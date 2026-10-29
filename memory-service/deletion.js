'use strict';

/**
 * 治理层 · 删除引用计数 / 级联 7 步 / deletion_job
 *
 * 契约依据：g:/everyagent/test-output/20261026-memory-arch/汇总、.txt
 *   - §9.1  ref_count 原子增减、每日对账；
 *   - §9.2  级联 7 步唯一口径，字段统一 _done，顺序不可跳，每步幂等；
 *   - §9.3  deletion_job.v4.1 状态机、retry_backoff、max_retry=5；
 *   - §22.1 deleted_pending → deleted_tombstone；tombstone 不保留原文、不可召回、不可导出；
 *   - §22.3 文件删除级联范围。
 *
 * DDL 取舍（不修改 ddl.js）：
 *   - §9.1 的 ref_event 明细表在附录 A 未单列，26 张表中不存在；因此对账以
 *     “现存活引用”为事实源，步骤幂等性由 *_done 里的 idempotency_key 保证；
 *   - deletion_job 无 reason 列：request 的 reason 及删除前内容哈希/字节数写入
 *     ref_release_done(s1) 的 JSON，作为 job 级元数据（JSON 字段本就可扩展）。
 */

const crypto = require('node:crypto');
const {
  DELETION_JOB,
  LIFECYCLE_STATE,
  QUALITY_FLAG,
  AUDIT_ACTION,
  SENSITIVITY,
} = require('./constants');
const audit = require('./audit');
const quota = require('./quota');
const lifecycle = require('./lifecycle');

const DELETION_SCHEMA_VERSION = 'deletion_job.v4.1';
const TERMINAL_STATES = new Set(['completed', 'failed_manual']);

// §9.2 唯一 7 步（顺序即契约顺序，不可跳）
const STEP_DEFS = Object.freeze([
  { key: 'ref_release_done', step_id: 's1', label: '释放引用计数' },
  { key: 'derived_edge_update_done', step_id: 's2', label: 'derived_edge 标 tombstone' },
  { key: 'index_delete_done', step_id: 's3', label: '删除向量/全文索引' },
  { key: 'content_delete_done', step_id: 's4', label: '删除/脱敏内容与 Dossier' },
  { key: 'audit_shell_done', step_id: 's5', label: '写审计壳（不含原文）' },
  { key: 'quota_release_done', step_id: 's6', label: '释放配额' },
  { key: 'audit_done', step_id: 's7', label: '写删除审计并完成' },
]);
const STEP_KEYS = STEP_DEFS.map((step) => step.key);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringify(value) {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function generateJobId() {
  const stamp = nowIso().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `del_${stamp}_${crypto.randomBytes(6).toString('hex')}`;
}

function stepIdempotencyKey(jobId, targetId, step) {
  return `sha256:${sha256Hex(`${step.step_id}|${jobId}|${targetId}|deletion_job.v4.1`)}`;
}

function initialStepMeta(jobId, targetId, step, extra = {}) {
  return {
    step_id: step.step_id,
    status: 'pending',
    idempotency_key: stepIdempotencyKey(jobId, targetId, step),
    last_error: null,
    at: null,
    ...extra,
  };
}

function readStep(job, key) {
  const fallback = { step_id: null, status: 'pending', idempotency_key: null, last_error: null, at: null };
  return parseJson(job?.[key], fallback) ?? fallback;
}

function stepsSnapshot(job) {
  const out = {};
  for (const step of STEP_DEFS) out[step.key] = readStep(job, step.key);
  return out;
}

function loadJob(store, jobId) {
  return store.get('SELECT * FROM deletion_job WHERE job_id = ?', jobId);
}

function getMemory(store, memId) {
  return store.get('SELECT * FROM memory_item WHERE mem_id = ?', memId);
}

function safeAudit(store, params) {
  try {
    return audit.append(store, params);
  } catch {
    return null;
  }
}

/** 同 request_id + action 只写一次，保证 step5/step7 在崩溃重跑时不重复追加。 */
function appendOnce(store, params) {
  if (params.request_id) {
    const existing = store.get(
      `SELECT event_id, hash, created_at FROM memory_audit_log
        WHERE user_id = ? AND request_id = ? AND action = ?
        ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      params.user_id,
      params.request_id,
      params.action
    );
    if (existing) {
      return { ok: true, event_id: existing.event_id, hash: existing.hash, created_at: existing.created_at, reused: true };
    }
  }
  return audit.append(store, params);
}

function collectSpanIds(store, mem) {
  const ids = new Set();
  if (mem?.source_span_id) ids.add(mem.source_span_id);
  for (const row of store.all(
    'SELECT span_id FROM memory_evidence_span WHERE mem_id = ? OR (user_id = ? AND span_id = ?)',
    mem.mem_id,
    mem.user_id,
    mem.source_span_id
  )) {
    if (row.span_id) ids.add(row.span_id);
  }
  return [...ids];
}

function collectFileIds(store, mem, spanIds) {
  const files = new Set();
  if (mem.media_ref) {
    if (store.get('SELECT file_id FROM file_entity WHERE file_id = ?', mem.media_ref)) {
      files.add(mem.media_ref);
    }
  }
  for (const spanId of spanIds) {
    const span = store.get('SELECT media_ref FROM memory_evidence_span WHERE span_id = ?', spanId);
    if (span?.media_ref && store.get('SELECT file_id FROM file_entity WHERE file_id = ?', span.media_ref)) {
      files.add(span.media_ref);
    }
  }
  return [...files];
}

function collectDossierIds(store, fileIds) {
  const secIds = [];
  const segIds = [];
  const d3SpanIds = [];
  for (const fileId of fileIds) {
    for (const row of store.all('SELECT sec_id FROM dossier_d1 WHERE file_id = ?', fileId)) {
      if (row.sec_id) secIds.push(row.sec_id);
    }
    for (const row of store.all('SELECT seg_id FROM dossier_d2 WHERE file_id = ?', fileId)) {
      if (row.seg_id) segIds.push(row.seg_id);
    }
    for (const row of store.all('SELECT span_id FROM dossier_d3 WHERE file_id = ?', fileId)) {
      if (row.span_id) d3SpanIds.push(row.span_id);
    }
  }
  return { secIds, segIds, spanIds: d3SpanIds };
}

function placeholders(count) {
  return new Array(count).fill('?').join(',');
}

function contentPayload(mem) {
  return {
    summary_short: mem.summary_short ?? null,
    summary_long: mem.summary_long ?? null,
    structured: mem.structured_json ?? null,
    tags: mem.tags_json ?? null,
    entities: mem.entities_json ?? null,
    relations: mem.relations_json ?? null,
    raw_text_ref: mem.raw_text_ref ?? null,
    media_ref: mem.media_ref ?? null,
    source_turns: mem.source_turns_json ?? null,
    why_recalled_log: mem.why_recalled_log_json ?? null,
    affect_ext: mem.affect_ext_json ?? null,
  };
}

function byteLength(value) {
  if (value === null || value === undefined) return 0;
  return Buffer.byteLength(String(value), 'utf8');
}

/** 删除前内容哈希 + 可释放字节（tombstone 只保留 hash）。 */
function computeContentMeta(store, mem) {
  const payload = contentPayload(mem);
  let freed = 0;
  for (const value of Object.values(payload)) freed += byteLength(value);

  const spanIds = collectSpanIds(store, mem);
  for (const spanId of spanIds) {
    const span = store.get(
      'SELECT raw_text, text_excerpt FROM memory_evidence_span WHERE span_id = ?',
      spanId
    );
    freed += byteLength(span?.raw_text) + byteLength(span?.text_excerpt);
  }

  const files = collectFileIds(store, mem, spanIds);
  for (const fileId of files) {
    const d0 = store.get('SELECT summary_1line, summary_para, topics_json FROM dossier_d0 WHERE file_id = ?', fileId);
    freed += byteLength(d0?.summary_1line) + byteLength(d0?.summary_para) + byteLength(d0?.topics_json);
    for (const d1 of store.all('SELECT summary, key_points_json FROM dossier_d1 WHERE file_id = ?', fileId)) {
      freed += byteLength(d1.summary) + byteLength(d1.key_points_json);
    }
    for (const d2 of store.all('SELECT caption, visual_desc, asr_text, ocr_text FROM dossier_d2 WHERE file_id = ?', fileId)) {
      freed += byteLength(d2.caption) + byteLength(d2.visual_desc)
        + byteLength(d2.asr_text) + byteLength(d2.ocr_text);
    }
  }

  return {
    content_hash: `sha256:${sha256Hex(audit.stableStringify(payload))}`,
    freed_bytes: freed,
    span_ids: spanIds,
    file_ids: files,
  };
}

// ---------------------------------------------------------------------------
// request：创建 deletion_job（§9.3），条目进入 deleted_pending（§22.1）
// ---------------------------------------------------------------------------

/**
 * @returns {{ok:true, job_id:string, job_ids:string[], skipped:Array}}
 */
function request(store, {
  mem_ids,
  user_id,
  agent_id,
  reason,
  actor,
  now = nowIso(),
} = {}) {
  if (!store || typeof store.run !== 'function') {
    throw new TypeError('request: store 必须由 getStore() 返回');
  }
  if (!user_id) throw new Error('§3.1 user_id 必填');
  const ids = [...new Set((Array.isArray(mem_ids) ? mem_ids : [mem_ids]).filter(Boolean).map(String))];
  if (ids.length === 0) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'mem_ids 不能为空' };
  }

  const jobIds = [];
  const skipped = [];

  for (const memId of ids) {
    const mem = store.get(
      'SELECT * FROM memory_item WHERE mem_id = ? AND user_id = ?',
      memId,
      user_id
    );
    if (!mem) {
      skipped.push({ mem_id: memId, reason: 'not_found' });
      continue;
    }

    // 已有未完成/已完成任务：幂等复用；failed_manual 则新建任务
    const existing = store.get(
      `SELECT job_id, state FROM deletion_job
        WHERE target_type = 'memory_item' AND target_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      memId
    );
    if (existing && existing.state !== 'failed_manual') {
      jobIds.push(existing.job_id);
      skipped.push({ mem_id: memId, reason: 'job_exists', job_id: existing.job_id, state: existing.state });
      continue;
    }

    if (mem.lifecycle_state === LIFECYCLE_STATE.DELETED_TOMBSTONE) {
      skipped.push({ mem_id: memId, reason: 'already_tombstone' });
      continue;
    }

    const jobId = generateJobId();
    const meta = computeContentMeta(store, mem);
    const s1Extra = {
      job_reason: reason ?? null,
      content_hash: meta.content_hash,
      freed_bytes: meta.freed_bytes,
      span_ids: meta.span_ids,
      file_ids: meta.file_ids,
    };

    store.run(
      `INSERT INTO deletion_job
        (job_id, user_id, target_type, target_id, state,
         ref_release_done, derived_edge_update_done, index_delete_done,
         content_delete_done, audit_shell_done, quota_release_done, audit_done,
         retry_count, max_retry, failed_at_state, last_error_json, audit_ref,
         schema_version, created_at, updated_at)
       VALUES (?, ?, 'memory_item', ?, 'pending', ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?, ?)`,
      jobId,
      user_id,
      memId,
      stringify(initialStepMeta(jobId, memId, STEP_DEFS[0], s1Extra)),
      stringify(initialStepMeta(jobId, memId, STEP_DEFS[1])),
      stringify(initialStepMeta(jobId, memId, STEP_DEFS[2])),
      stringify(initialStepMeta(jobId, memId, STEP_DEFS[3])),
      stringify(initialStepMeta(jobId, memId, STEP_DEFS[4])),
      stringify(initialStepMeta(jobId, memId, STEP_DEFS[5])),
      stringify(initialStepMeta(jobId, memId, STEP_DEFS[6])),
      DELETION_JOB.MAX_RETRY,
      DELETION_SCHEMA_VERSION,
      now,
      now
    );

    // §22.1 用户删除请求 → deleted_pending（直接改状态；终态 superseded 也允许用户删除）
    if (mem.lifecycle_state !== LIFECYCLE_STATE.DELETED_PENDING) {
      store.run(
        `UPDATE memory_item SET lifecycle_state = ?
          WHERE mem_id = ? AND user_id = ? AND lifecycle_state <> ?`,
        LIFECYCLE_STATE.DELETED_PENDING,
        memId,
        user_id,
        LIFECYCLE_STATE.DELETED_TOMBSTONE
      );
    }

    safeAudit(store, {
      user_id,
      agent_id: agent_id ?? mem.agent_id,
      action: AUDIT_ACTION.MEMORY_DELETE,
      target_type: 'memory_item',
      target_id: memId,
      before: { lifecycle_state: mem.lifecycle_state },
      after: { lifecycle_state: LIFECYCLE_STATE.DELETED_PENDING, job_id: jobId },
      reason: reason ?? 'delete_request',
      actor: actor ?? { type: 'user', id: user_id },
      request_id: jobId,
      sensitivity: mem.sensitivity ?? SENSITIVITY.S2,
      now,
    });

    jobIds.push(jobId);
  }

  return { ok: true, job_id: jobIds[0] ?? null, job_ids: jobIds, skipped };
}

// ---------------------------------------------------------------------------
// 级联 7 步实现（每步幂等）
// ---------------------------------------------------------------------------

function stepRefRelease(store, job, now) {
  const mem = getMemory(store, job.target_id);
  const s1 = readStep(job, 'ref_release_done');
  const detail = {
    spans: 0,
    marked_needs_review: [],
    job_reason: s1.job_reason ?? null,
    content_hash: s1.content_hash ?? null,
    freed_bytes: Number(s1.freed_bytes ?? 0),
    span_ids: s1.span_ids ?? [],
    file_ids: s1.file_ids ?? [],
  };
  if (!mem) {
    detail.note = 'memory_item_missing';
    return detail;
  }

  const spanIds = collectSpanIds(store, mem);
  for (const spanId of spanIds) {
    // §9.2 step1：若 source_span 仍被其他条目引用，先标记 needs_review（不物理删）
    const others = store.all(
      `SELECT mem_id, user_id, agent_id, quality_flag, quality_reasons_json, sensitivity
         FROM memory_item
        WHERE source_span_id = ? AND mem_id <> ?
          AND lifecycle_state <> ?`,
      spanId,
      mem.mem_id,
      LIFECYCLE_STATE.DELETED_TOMBSTONE
    );
    for (const other of others) {
      if (other.quality_flag !== QUALITY_FLAG.NORMAL) continue;
      const reasons = parseJson(other.quality_reasons_json, []) ?? [];
      if (!reasons.includes('source_span_being_deleted')) reasons.push('source_span_being_deleted');
      store.run(
        'UPDATE memory_item SET quality_flag = ?, quality_reasons_json = ? WHERE mem_id = ?',
        QUALITY_FLAG.NEEDS_REVIEW,
        stringify(reasons),
        other.mem_id
      );
      detail.marked_needs_review.push(other.mem_id);
      safeAudit(store, {
        user_id: other.user_id,
        agent_id: other.agent_id,
        action: AUDIT_ACTION.MEMORY_QUALITY_REVIEW,
        target_type: 'memory_item',
        target_id: other.mem_id,
        before: { quality_flag: QUALITY_FLAG.NORMAL },
        after: { quality_flag: QUALITY_FLAG.NEEDS_REVIEW, reason: 'source_span_being_deleted' },
        reason: 'source_span_being_deleted',
        actor: { type: 'system', id: 'deletion' },
        request_id: job.job_id,
        sensitivity: other.sensitivity ?? SENSITIVITY.S2,
        now,
      });
    }

    adjustRefCount(store, { span_id: spanId, delta: -1, now });
    detail.spans += 1;
  }

  detail.span_ids = spanIds;
  detail.file_ids = collectFileIds(store, mem, spanIds);
  return detail;
}

/**
 * §9.1 ref_count 原子增减。
 */
function adjustRefCount(store, { span_id, delta, now = nowIso() } = {}) {
  const amount = Number(delta);
  if (!span_id || !Number.isFinite(amount)) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'span_id/delta 必填' };
  }
  store.run(
    `UPDATE memory_evidence_span
        SET ref_count = MAX(0, COALESCE(ref_count, 0) + ?)
      WHERE span_id = ?`,
    Math.trunc(amount),
    span_id
  );
  const row = store.get('SELECT ref_count FROM memory_evidence_span WHERE span_id = ?', span_id);
  return { ok: true, span_id, ref_count: Number(row?.ref_count ?? 0), at: now };
}

function stepDerivedEdge(store, job) {
  const mem = getMemory(store, job.target_id);
  if (!mem) return { edges: 0, note: 'memory_item_missing' };
  const s1 = readStep(job, 'ref_release_done');
  const spanIds = Array.isArray(s1.span_ids) ? s1.span_ids : collectSpanIds(store, mem);
  const ids = [mem.mem_id, ...spanIds];
  let edges = 0;
  for (const id of ids) {
    const result = store.run(
      `UPDATE memory_derived_edge SET deletion_state = 'tombstone'
        WHERE (from_id = ? OR to_id = ?) AND COALESCE(deletion_state, '') <> 'tombstone'`,
      id,
      id
    );
    edges += Number(result.changes ?? 0);
  }
  return { edges, ids };
}

function stepIndexDelete(store, job) {
  const mem = getMemory(store, job.target_id);
  if (!mem) return { note: 'memory_item_missing' };
  const s1 = readStep(job, 'ref_release_done');
  const spanIds = Array.isArray(s1.span_ids) && s1.span_ids.length
    ? s1.span_ids
    : collectSpanIds(store, mem);
  const fileIds = Array.isArray(s1.file_ids) && s1.file_ids.length
    ? s1.file_ids
    : collectFileIds(store, mem, spanIds);
  const dossier = collectDossierIds(store, fileIds);

  const counts = { vector_item: 0, vector_fragment: 0, vector_segment: 0, fulltext: 0 };

  counts.vector_item += Number(store.run(
    'DELETE FROM memory_vector_index_item WHERE mem_id = ? AND user_id = ?',
    mem.mem_id,
    mem.user_id
  ).changes ?? 0);

  if (spanIds.length) {
    counts.vector_fragment += Number(store.run(
      `DELETE FROM memory_vector_index_fragment
        WHERE user_id = ? AND (mem_id = ? OR span_id IN (${placeholders(spanIds.length)}))`,
      mem.user_id,
      mem.mem_id,
      ...spanIds
    ).changes ?? 0);
  } else {
    counts.vector_fragment += Number(store.run(
      'DELETE FROM memory_vector_index_fragment WHERE user_id = ? AND mem_id = ?',
      mem.user_id,
      mem.mem_id
    ).changes ?? 0);
  }

  if (fileIds.length) {
    counts.vector_segment += Number(store.run(
      `DELETE FROM memory_vector_index_segment
        WHERE user_id = ? AND (mem_id = ? OR file_id IN (${placeholders(fileIds.length)}))`,
      mem.user_id,
      mem.mem_id,
      ...fileIds
    ).changes ?? 0);
  } else {
    counts.vector_segment += Number(store.run(
      'DELETE FROM memory_vector_index_segment WHERE user_id = ? AND mem_id = ?',
      mem.user_id,
      mem.mem_id
    ).changes ?? 0);
  }

  const objectIds = new Set([mem.mem_id, ...spanIds, ...fileIds, ...dossier.secIds, ...dossier.segIds, ...dossier.spanIds]);
  const ids = [...objectIds];
  if (ids.length) {
    counts.fulltext += Number(store.run(
      `DELETE FROM memory_fulltext_index
        WHERE user_id = ? AND object_id IN (${placeholders(ids.length)})`,
      mem.user_id,
      ...ids
    ).changes ?? 0);
  }

  return { ...counts, span_ids: spanIds, file_ids: fileIds, dossier };
}

function filterEvidenceRefs(store, table, idColumn, spanIds, userId) {
  if (!spanIds.length) return 0;
  const set = new Set(spanIds);
  let changed = 0;
  const rows = store.all(
    `SELECT ${idColumn} AS id, evidence_refs_json FROM ${table} WHERE user_id = ?`,
    userId
  );
  for (const row of rows) {
    const refs = parseJson(row.evidence_refs_json, []) ?? [];
    if (!Array.isArray(refs)) continue;
    const remaining = refs.filter((ref) => !set.has(ref));
    if (remaining.length === refs.length) continue;
    const deletionState = remaining.length === 0
      ? 'content_deleted_audit_retained'
      : null;
    if (table === 'relationship_milestone') {
      store.run(
        `UPDATE relationship_milestone SET evidence_refs_json = ?, deletion_state = COALESCE(?, deletion_state)
          WHERE ${idColumn} = ?`,
        stringify(remaining),
        deletionState,
        row.id
      );
    } else {
      store.run(
        `UPDATE prospective_store SET evidence_refs_json = ? WHERE ${idColumn} = ?`,
        stringify(remaining),
        row.id
      );
    }
    changed += 1;
  }
  return changed;
}

function stepContentDelete(store, job, now) {
  const mem = getMemory(store, job.target_id);
  if (!mem) return { note: 'memory_item_missing' };
  const s1 = readStep(job, 'ref_release_done');
  const spanIds = Array.isArray(s1.span_ids) && s1.span_ids.length
    ? s1.span_ids
    : collectSpanIds(store, mem);
  const fileIds = Array.isArray(s1.file_ids) && s1.file_ids.length
    ? s1.file_ids
    : collectFileIds(store, mem, spanIds);
  const contentHash = s1.content_hash ?? computeContentMeta(store, mem).content_hash;
  const freedBytes = Number(s1.freed_bytes ?? computeContentMeta(store, mem).freed_bytes);

  // §22.1 deleted_pending → deleted_tombstone（状态机校验，终态不可回退）
  const transition = lifecycle.transition(mem, LIFECYCLE_STATE.DELETED_TOMBSTONE, {
    now,
    reason: 'deletion_cascade',
  });
  if (!transition.ok) {
    throw Object.assign(new Error(transition.message ?? '生命周期迁移被拒'), {
      code: transition.code ?? 'ILLEGAL_TRANSITION',
    });
  }

  // 内容字段清空：tombstone 仅保留 ID/hash/删除时间/审计引用（§22.1）
  store.run(
    `UPDATE memory_item
        SET summary_short = '', summary_long = NULL, structured_json = NULL,
            tags_json = NULL, entities_json = NULL, relations_json = NULL,
            embedding_refs_json = NULL, raw_text_ref = NULL, media_ref = NULL,
            source_turns_json = NULL, why_recalled_log_json = NULL,
            affect_ext_json = NULL, source_span_id = '', derived_from_json = '[]',
            share_scope_json = '[]', supersedes_json = NULL, version_chain_json = NULL,
            superseded_by = NULL, importance = 0, confidence = 0, source_reliability = 0,
            recency = NULL, decay_score = NULL, access_count = 0,
            quality_flag = ?, quality_reasons_json = ?,
            lifecycle_state = ?, last_access = ?
      WHERE mem_id = ? AND user_id = ?`,
    QUALITY_FLAG.DEGRADED,
    stringify(['deleted_tombstone']),
    LIFECYCLE_STATE.DELETED_TOMBSTONE,
    now,
    mem.mem_id,
    mem.user_id
  );

  if (spanIds.length) {
    store.run(
      `UPDATE memory_evidence_span
          SET raw_text = NULL, text_excerpt = NULL, media_ref = NULL,
              deletion_state = 'content_deleted_audit_retained'
        WHERE user_id = ? AND span_id IN (${placeholders(spanIds.length)})`,
      mem.user_id,
      ...spanIds
    );
    // D3 直接复用 span_id（§13）
    store.run(
      `UPDATE dossier_d3
          SET frame_ref = NULL, asr_ref = NULL, ocr_ref = NULL,
              deletion_state = 'content_deleted_audit_retained'
        WHERE user_id = ? AND span_id IN (${placeholders(spanIds.length)})`,
      mem.user_id,
      ...spanIds
    );
  }

  let files = 0;
  if (fileIds.length) {
    for (const fileId of fileIds) {
      // §22.3：file_entity 内容 / D0-D3 内容
      store.run(
        `UPDATE file_entity SET file_name = NULL, deletion_state = 'content_deleted_audit_retained'
          WHERE user_id = ? AND file_id = ?`,
        mem.user_id,
        fileId
      );
      store.run(
        `UPDATE dossier_d0
            SET title = NULL, summary_1line = NULL, summary_para = NULL, topics_json = NULL,
                key_entities_json = NULL, outline_refs_json = NULL, embedding_file = NULL,
                deletion_state = 'content_deleted_audit_retained'
          WHERE user_id = ? AND file_id = ?`,
        mem.user_id,
        fileId
      );
      store.run(
        `UPDATE dossier_d1
            SET title = NULL, summary = NULL, key_points_json = NULL, speakers_json = NULL,
                entities_json = NULL, affect_tag_json = NULL, seg_refs_json = NULL,
                embedding_sec = NULL, deletion_state = 'content_deleted_audit_retained'
          WHERE user_id = ? AND file_id = ?`,
        mem.user_id,
        fileId
      );
      store.run(
        `UPDATE dossier_d2
            SET caption = NULL, visual_desc = NULL, asr_text = NULL, ocr_text = NULL,
                emotion_json = NULL, entities_json = NULL, evidence_refs_json = '[]',
                embedding_seg = NULL, deletion_state = 'content_deleted_audit_retained'
          WHERE user_id = ? AND file_id = ?`,
        mem.user_id,
        fileId
      );
      store.run(
        `UPDATE dossier_d3
            SET frame_ref = NULL, asr_ref = NULL, ocr_ref = NULL,
                deletion_state = 'content_deleted_audit_retained'
          WHERE user_id = ? AND file_id = ?`,
        mem.user_id,
        fileId
      );
      files += 1;
    }
  }

  // §22.3 里程碑引用脱敏：从 evidence_refs 中移除被删 span
  const milestones = filterEvidenceRefs(
    store,
    'relationship_milestone',
    'milestone_id',
    spanIds,
    mem.user_id
  );
  filterEvidenceRefs(store, 'prospective_store', 'prospective_id', spanIds, mem.user_id);

  return {
    content_hash: contentHash,
    freed_bytes: freedBytes,
    spans: spanIds.length,
    files,
    milestones,
    lifecycle_state: LIFECYCLE_STATE.DELETED_TOMBSTONE,
  };
}

function stepAuditShell(store, job, now) {
  const mem = getMemory(store, job.target_id);
  const s1 = readStep(job, 'ref_release_done');
  const s4 = readStep(job, 'content_delete_done');
  const contentHash = s4.content_hash ?? s1.content_hash ?? null;
  const reason = s1.job_reason ?? 'deletion_cascade';

  const shell = audit.buildShell({
    object_id: job.target_id,
    action: AUDIT_ACTION.MEMORY_DELETE,
    timestamp: now,
    reason,
    hash: contentHash,
  });

  const event = appendOnce(store, {
    user_id: job.user_id,
    agent_id: mem?.agent_id ?? null,
    action: AUDIT_ACTION.MEMORY_DELETE,
    target_type: 'memory_item',
    target_id: job.target_id,
    before: null,
    after: { content_hash: contentHash, shell }, // §9.2 step5：不含原文
    reason,
    actor: { type: 'system', id: 'deletion' },
    request_id: `${job.job_id}#audit_shell`, // 与 request 阶段的 memory.delete 区分，避免 appendOnce 复用
    sensitivity: mem?.sensitivity ?? SENSITIVITY.S2,
    now,
  });

  store.run(
    'UPDATE memory_item SET audit_ref = ? WHERE mem_id = ? AND user_id = ?',
    event.event_id,
    job.target_id,
    job.user_id
  );

  return { audit_ref: event.event_id, content_hash: contentHash, reused: Boolean(event.reused) };
}

function stepQuotaRelease(store, job, now) {
  const s1 = readStep(job, 'ref_release_done');
  const s4 = readStep(job, 'content_delete_done');
  const freedBytes = Number(s4.freed_bytes ?? s1.freed_bytes ?? 0);

  const items = quota.release(store, {
    user_id: job.user_id,
    agent_id: store.agentId,
    dimension: 'memory_items',
    amount: 1,
    now,
  });
  if (!items.ok) throw Object.assign(new Error('释放 memory_items 配额失败'), { code: items.code });

  const bytes = quota.release(store, {
    user_id: job.user_id,
    agent_id: store.agentId,
    dimension: 'storage_bytes',
    amount: Math.max(0, freedBytes),
    now,
  });
  if (!bytes.ok) throw Object.assign(new Error('释放 storage_bytes 配额失败'), { code: bytes.code });

  return {
    memory_items: items.used,
    storage_bytes: bytes.used,
    released_bytes: Math.max(0, freedBytes),
  };
}

function stepAuditDone(store, job, now) {
  const mem = getMemory(store, job.target_id);
  const s1 = readStep(job, 'ref_release_done');
  const s3 = readStep(job, 'index_delete_done');
  const s4 = readStep(job, 'content_delete_done');
  const spanIds = Array.isArray(s1.span_ids) ? s1.span_ids : [];
  const fileIds = Array.isArray(s1.file_ids) ? s1.file_ids : [];

  if (spanIds.length) {
    appendOnce(store, {
      user_id: job.user_id,
      agent_id: mem?.agent_id ?? null,
      action: AUDIT_ACTION.EVIDENCE_DELETE,
      target_type: 'evidence_span',
      target_id: job.target_id, // 以 mem_id 关联，after 内列 span_ids
      after: { span_ids: spanIds },
      reason: 'deletion_cascade',
      actor: { type: 'system', id: 'deletion' },
      request_id: job.job_id,
      sensitivity: mem?.sensitivity ?? SENSITIVITY.S2,
      now,
    });
  }
  if (fileIds.length) {
    appendOnce(store, {
      user_id: job.user_id,
      agent_id: mem?.agent_id ?? null,
      action: AUDIT_ACTION.FILE_DELETE,
      target_type: 'file_entity',
      target_id: job.target_id,
      after: { file_ids: fileIds },
      reason: 'deletion_cascade',
      actor: { type: 'system', id: 'deletion' },
      request_id: job.job_id,
      sensitivity: mem?.sensitivity ?? SENSITIVITY.S2,
      now,
    });
  }

  const event = appendOnce(store, {
    user_id: job.user_id,
    agent_id: mem?.agent_id ?? null,
    action: AUDIT_ACTION.DELETION_JOB_COMPLETE,
    target_type: 'deletion_job',
    target_id: job.job_id,
    after: {
      job_id: job.job_id,
      target_id: job.target_id,
      state: 'completed',
      content_hash: s4.content_hash ?? s1.content_hash ?? null,
      index_delete: { vector_item: s3.vector_item ?? 0, fulltext: s3.fulltext ?? 0 },
    },
    reason: s1.job_reason ?? 'deletion_cascade',
    actor: { type: 'system', id: 'deletion' },
    request_id: job.job_id,
    sensitivity: mem?.sensitivity ?? SENSITIVITY.S2,
    now,
  });

  return { complete_event_id: event.event_id, reused: Boolean(event.reused) };
}

const STEP_RUNNERS = Object.freeze({
  ref_release_done: stepRefRelease,
  derived_edge_update_done: stepDerivedEdge,
  index_delete_done: stepIndexDelete,
  content_delete_done: stepContentDelete,
  audit_shell_done: stepAuditShell,
  quota_release_done: stepQuotaRelease,
  audit_done: stepAuditDone,
});

function stateAfterStep(step) {
  switch (step.key) {
    case 'ref_release_done':
      return 'ref_releasing';
    case 'derived_edge_update_done':
    case 'index_delete_done':
      return 'cascading';
    case 'content_delete_done':
    case 'audit_shell_done':
    case 'quota_release_done':
      return 'content_deleted_audit_retained';
    case 'audit_done':
      return 'completed';
    default:
      return 'cascading';
  }
}

function stateBeforeStep(step) {
  if (step.key === 'ref_release_done') return 'ref_releasing';
  if (['derived_edge_update_done', 'index_delete_done', 'content_delete_done'].includes(step.key)) {
    return 'cascading';
  }
  return 'content_deleted_audit_retained';
}

function updateJob(store, jobId, fields, now) {
  const allowed = new Set([...STEP_KEYS, 'state', 'retry_count', 'failed_at_state', 'last_error_json', 'audit_ref']);
  const keys = Object.keys(fields).filter((key) => allowed.has(key));
  if (keys.length === 0) return;
  const assignments = keys.map((key) => `${key} = ?`).join(', ');
  const params = keys.map((key) => fields[key]);
  store.run(
    `UPDATE deletion_job SET ${assignments}, updated_at = ? WHERE job_id = ?`,
    ...params,
    now,
    jobId
  );
}

// ---------------------------------------------------------------------------
// runJob：严格执行 7 步，顺序不可跳，失败可重试
// ---------------------------------------------------------------------------

/**
 * @returns {{ok:boolean, job_id:string, state:string, steps:object, failed_step?:string}}
 */
function runJob(store, { job_id, now = nowIso() } = {}) {
  if (!store || typeof store.run !== 'function') {
    throw new TypeError('runJob: store 必须由 getStore() 返回');
  }
  let job = loadJob(store, job_id);
  if (!job) return { ok: false, code: 'JOB_NOT_FOUND', job_id };

  const results = {};
  for (const step of STEP_DEFS) {
    const meta = readStep(job, step.key);
    if (meta.status === 'done') {
      results[step.key] = { status: 'done', skipped: true, ...meta };
      continue;
    }

    if (job.state === 'failed_manual') {
      return {
        ok: false,
        code: 'MAX_RETRY_EXCEEDED',
        job_id,
        state: job.state,
        failed_step: step.key,
        retry_count: Number(job.retry_count ?? 0),
        max_retry: Number(job.max_retry ?? DELETION_JOB.MAX_RETRY),
        steps: stepsSnapshot(job),
      };
    }

    try {
      // 顺序不可跳：执行当前步前，所有前序步骤必须 done
      for (const previous of STEP_DEFS) {
        if (previous.key === step.key) break;
        if (readStep(job, previous.key).status !== 'done') {
          throw Object.assign(new Error(`§9.2 步骤顺序不可跳: ${previous.key} 未完成`), {
            code: 'STEP_OUT_OF_ORDER',
          });
        }
      }

      const detail = STEP_RUNNERS[step.key](store, job, now) ?? {};
      const nextState = stateAfterStep(step);
      const nextMeta = {
        ...meta,
        status: 'done',
        last_error: null,
        at: now,
        ...detail,
      };
      const fields = { [step.key]: stringify(nextMeta), state: nextState };
      if (step.key === 'audit_shell_done' && nextMeta.audit_ref) fields.audit_ref = nextMeta.audit_ref;
      updateJob(store, job_id, fields, now);

      job = loadJob(store, job_id);
      results[step.key] = { status: 'done', ...nextMeta };
    } catch (error) {
      const retryCount = Number(job.retry_count ?? 0) + 1;
      const maxRetry = Number(job.max_retry ?? DELETION_JOB.MAX_RETRY);
      const failedState = stateBeforeStep(step);
      const nextState = retryCount >= maxRetry ? 'failed_manual' : 'retrying';
      const lastError = {
        code: error?.code ?? 'STEP_FAILED',
        message: error?.message ?? String(error),
        at: now,
      };
      const failedMeta = {
        ...meta,
        status: 'failed',
        last_error: lastError,
        at: now,
      };
      updateJob(store, job_id, {
        [step.key]: stringify(failedMeta),
        state: nextState,
        retry_count: retryCount,
        failed_at_state: failedState,
        last_error_json: stringify(lastError),
      }, now);

      safeAudit(store, {
        user_id: job.user_id,
        agent_id: store.agentId,
        action: nextState === 'failed_manual'
          ? AUDIT_ACTION.DELETION_JOB_FAILED_MANUAL
          : AUDIT_ACTION.DELETION_JOB_RETRY,
        target_type: 'deletion_job',
        target_id: job.job_id,
        before: { state: job.state },
        after: { state: nextState, failed_step: step.key, retry_count: retryCount, last_error: lastError },
        reason: 'deletion_step_failed',
        actor: { type: 'system', id: 'deletion' },
        request_id: job.job_id,
        sensitivity: SENSITIVITY.S2,
        now,
      });

      job = loadJob(store, job_id);
      return {
        ok: false,
        code: 'STEP_FAILED',
        job_id,
        state: nextState,
        failed_step: step.key,
        retry_count: retryCount,
        max_retry: maxRetry,
        error: lastError,
        steps: stepsSnapshot(job),
      };
    }
  }

  // 所有步骤 done 但状态可能因崩溃未落 completed
  if (job.state !== 'completed') {
    updateJob(store, job_id, { state: 'completed' }, now);
    job = loadJob(store, job_id);
  }

  return {
    ok: true,
    job_id,
    state: job.state,
    audit_ref: job.audit_ref ?? null,
    steps: stepsSnapshot(job),
  };
}

/** 单条级联：等价 request + runJob。 */
function cascade(store, { mem_id, now = nowIso() } = {}) {
  const mem = getMemory(store, mem_id);
  if (!mem) return { ok: false, code: 'MEMORY_NOT_FOUND', mem_id };
  const created = request(store, {
    mem_ids: [mem_id],
    user_id: mem.user_id,
    agent_id: mem.agent_id,
    reason: 'cascade',
    actor: { type: 'system', id: 'deletion' },
    now,
  });
  if (!created.ok || !created.job_id) return { ok: false, code: 'JOB_NOT_CREATED', mem_id, detail: created };
  return runJob(store, { job_id: created.job_id, now });
}

// ---------------------------------------------------------------------------
// 对账（§9.1：每日对账 ref_count == sum(ref_events)）
// ---------------------------------------------------------------------------

function countLiveReferences(store, spanId) {
  const memRefs = Number(store.get(
    `SELECT COUNT(*) AS n FROM memory_item
      WHERE source_span_id = ? AND lifecycle_state <> ?`,
    spanId,
    LIFECYCLE_STATE.DELETED_TOMBSTONE
  )?.n ?? 0);

  let jsonRefs = 0;
  for (const table of ['relationship_milestone', 'prospective_store', 'dossier_d2']) {
    const idColumn = table === 'relationship_milestone'
      ? 'milestone_id'
      : (table === 'prospective_store' ? 'prospective_id' : 'seg_id');
    for (const row of store.all(`SELECT ${idColumn} AS id, evidence_refs_json FROM ${table}`)) {
      const refs = parseJson(row.evidence_refs_json, []) ?? [];
      if (Array.isArray(refs) && refs.includes(spanId)) jsonRefs += 1;
    }
  }
  return memRefs + jsonRefs;
}

/**
 * 对账：ref_count 与现存活引用数比对。
 * 注意：§9.1 的 ref_event 明细表未列入附录 A（26 表无此表），故以活引用为事实源。
 *
 * @returns {{ok:boolean, checked:number, mismatch_count:number, mismatches:Array}}
 */
function reconcile(store, { repair = false, now = nowIso() } = {}) {
  const spans = store.all('SELECT span_id, ref_count, user_id FROM memory_evidence_span');
  const mismatches = [];
  for (const span of spans) {
    const stored = Number(span.ref_count ?? 0);
    const actual = countLiveReferences(store, span.span_id);
    if (stored === actual) continue;
    mismatches.push({ span_id: span.span_id, user_id: span.user_id, stored, actual });
    if (repair) {
      store.run(
        'UPDATE memory_evidence_span SET ref_count = ? WHERE span_id = ?',
        actual,
        span.span_id
      );
    }
  }
  return {
    ok: mismatches.length === 0,
    checked: spans.length,
    mismatch_count: mismatches.length,
    mismatches,
    repaired: repair ? mismatches.length : 0,
    now,
  };
}

module.exports = {
  STEP_DEFS,
  STEP_KEYS,
  DELETION_SCHEMA_VERSION,
  request,
  runJob,
  cascade,
  adjustRefCount,
  reconcile,
};
