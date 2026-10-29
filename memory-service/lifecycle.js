'use strict';

/**
 * 治理层 · 生命周期状态机与批量清理
 *
 * 契约依据：g:/everyagent/test-output/20261026-memory-arch/汇总、.txt
 *   - §22.1  Memory Lifecycle：active / superseded / cold_archived /
 *            deleted_pending / deleted_tombstone；
 *   - §22.2  quality_flag 迁移（本文件的 transition 只管 lifecycle_state）；
 *   - §21.3  审计保留 180 天 / 敏感 365 天；
 *   - §9.2   tombstone 不保留原文、不可召回、不可导出；
 *   - §23.1  “M4 不被自动降级”。
 */

const {
  LIFECYCLE_STATE,
  QUALITY_FLAG,
  AUDIT_ACTION,
  SENSITIVITY,
  AUDIT_RETENTION_DAYS,
} = require('./constants');
const audit = require('./audit');

const STATE_SET = new Set(Object.values(LIFECYCLE_STATE));

// §22.1 允许的 lifecycle_state 迁移（唯一事实源）
// superseded 契约语义是“仅保留版本链与证据”，但用户删除请求仍必须可级联，
// 故仅额外允许 superseded → deleted_pending（用户主动删除），不允许回 active。
const ALLOWED_TRANSITIONS = Object.freeze({
  [LIFECYCLE_STATE.ACTIVE]: Object.freeze([
    LIFECYCLE_STATE.SUPERSEDED,
    LIFECYCLE_STATE.COLD_ARCHIVED,
    LIFECYCLE_STATE.DELETED_PENDING,
  ]),
  [LIFECYCLE_STATE.COLD_ARCHIVED]: Object.freeze([
    LIFECYCLE_STATE.ACTIVE, // 巩固任务重新激活
    LIFECYCLE_STATE.DELETED_PENDING,
  ]),
  [LIFECYCLE_STATE.SUPERSEDED]: Object.freeze([
    LIFECYCLE_STATE.DELETED_PENDING, // 用户删除请求
  ]),
  [LIFECYCLE_STATE.DELETED_PENDING]: Object.freeze([
    LIFECYCLE_STATE.DELETED_TOMBSTONE,
  ]),
  [LIFECYCLE_STATE.DELETED_TOMBSTONE]: Object.freeze([]),
});

// M4 只允许被显式审批的迁移降级；普通扫描/巩固不得自动降级
const M4_DOWNGRADE_TARGETS = new Set([
  LIFECYCLE_STATE.COLD_ARCHIVED,
  LIFECYCLE_STATE.SUPERSEDED,
]);

function nowIso() {
  return new Date().toISOString();
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
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function safeAudit(store, params) {
  try {
    return audit.append(store, params);
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * §22 状态机校验（纯函数，不写库）。
 *
 * @param {object} item memory_item 行或 MemoryItem 对象
 * @param {string} to 目标 lifecycle_state
 * @param {{now?:string, reason?:string, m4_approved?:boolean}} [options]
 * @returns {{ok:true, changed:boolean, from:string, to:string, item:object}
 *          |{ok:false, code:string, from:string, to:string, message:string}}
 */
function transition(item, to, { now = nowIso(), reason, m4_approved = false } = {}) {
  if (!isPlainObject(item)) {
    return {
      ok: false, code: 'ILLEGAL_TRANSITION', from: null, to,
      message: 'transition: item 必须是对象',
    };
  }
  const from = item.lifecycle_state;
  if (!STATE_SET.has(from)) {
    return {
      ok: false, code: 'ILLEGAL_TRANSITION', from, to,
      message: `§22.1 未知源状态: ${from}`,
    };
  }
  if (!STATE_SET.has(to)) {
    return {
      ok: false, code: 'ILLEGAL_TRANSITION', from, to,
      message: `§22.1 未知目标状态: ${to}`,
    };
  }

  // superseded 与 cold_archived 互斥（§2.5 / 任务要求）
  if (item.superseded === true && item.cold_archived === true) {
    return {
      ok: false, code: 'ILLEGAL_TRANSITION', from, to,
      message: '§2.5 superseded 与 cold_archived 互斥',
    };
  }
  if (to === LIFECYCLE_STATE.SUPERSEDED && item.cold_archived === true) {
    return {
      ok: false, code: 'ILLEGAL_TRANSITION', from, to,
      message: 'superseded 与 cold_archived 互斥',
    };
  }
  if (to === LIFECYCLE_STATE.COLD_ARCHIVED && item.superseded === true) {
    return {
      ok: false, code: 'ILLEGAL_TRANSITION', from, to,
      message: 'superseded 与 cold_archived 互斥',
    };
  }

  // §23.1 M4 不被自动降级；只有显式审批（m4_approved / reason=m4_override）才放行
  if (
    item.layer === 'M4'
    && M4_DOWNGRADE_TARGETS.has(to)
    && from !== to
    && !m4_approved
    && reason !== 'm4_override'
  ) {
    return {
      ok: false, code: 'M4_NO_AUTO_DOWNGRADE', from, to,
      message: '§23.1 M4 不得自动降级；需 m4_approved 显式审批',
    };
  }

  // 同状态视为幂等 no-op
  if (from === to) {
    return { ok: true, changed: false, from, to, item: { ...item }, now, reason: reason ?? null };
  }

  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return {
      ok: false, code: 'ILLEGAL_TRANSITION', from, to,
      message: `§22.1 不允许 ${from} → ${to}`,
    };
  }

  return {
    ok: true,
    changed: true,
    from,
    to,
    now,
    reason: reason ?? null,
    item: { ...item, lifecycle_state: to },
  };
}

/**
 * 批量清理（§22.1 / §21.3 / §9.2）。
 *
 * 统计口径：
 *   expired             valid_to < now 的 active 条目数（含被 M4 规则拦下的）
 *   cold_archived       实际成功迁移到 cold_archived 的条目数
 *   tombstoned          本轮清理的 deleted_tombstone 条目数（清残余原文/索引）
 *   prospective_expired 前瞻条目过期数
 *   audit_retention     审计保留期到期统计（180/365 天）
 */
function sweep(store, { now = nowIso() } = {}) {
  if (!store || typeof store.run !== 'function') {
    throw new TypeError('sweep: store 必须由 getStore() 返回');
  }

  const stats = {
    expired: 0,
    cold_archived: 0,
    tombstoned: 0,
    prospective_expired: 0,
    blocked_m4: 0,
    audit_retention: null,
    now,
  };

  // 1) 过期 → 冷归档（§22.1 active → cold_archived）
  const expiredRows = store.all(
    `SELECT mem_id, user_id, agent_id, layer, lifecycle_state, valid_to, sensitivity
       FROM memory_item
      WHERE lifecycle_state = ? AND valid_to IS NOT NULL AND valid_to < ?`,
    LIFECYCLE_STATE.ACTIVE,
    now
  );
  for (const row of expiredRows) {
    stats.expired += 1;
    const result = transition(row, LIFECYCLE_STATE.COLD_ARCHIVED, {
      now,
      reason: 'valid_to_expired',
    });
    if (!result.ok) {
      // M4 过期也不得自动降级（§23.1）
      if (result.code === 'M4_NO_AUTO_DOWNGRADE') stats.blocked_m4 += 1;
      continue;
    }
    store.run(
      'UPDATE memory_item SET lifecycle_state = ?, last_access = ? WHERE mem_id = ?',
      LIFECYCLE_STATE.COLD_ARCHIVED,
      now,
      row.mem_id
    );
    stats.cold_archived += 1;
    safeAudit(store, {
      user_id: row.user_id,
      agent_id: row.agent_id,
      action: AUDIT_ACTION.MEMORY_COLD_ARCHIVE,
      target_type: 'memory_item',
      target_id: row.mem_id,
      before: { lifecycle_state: LIFECYCLE_STATE.ACTIVE, valid_to: row.valid_to },
      after: { lifecycle_state: LIFECYCLE_STATE.COLD_ARCHIVED, reason: 'valid_to_expired' },
      reason: 'valid_to_expired',
      actor: { type: 'system', id: 'lifecycle_sweep' },
      sensitivity: row.sensitivity ?? SENSITIVITY.S2,
      now,
    });
  }

  // 2) tombstone 清理：不得保留原文、不得可召回、不得可导出（§9.2 / §22.1）
  const tombstones = store.all(
    `SELECT mem_id, user_id FROM memory_item WHERE lifecycle_state = ?`,
    LIFECYCLE_STATE.DELETED_TOMBSTONE
  );
  for (const row of tombstones) {
    const spanIds = store.all(
      'SELECT span_id FROM memory_evidence_span WHERE mem_id = ?',
      row.mem_id
    ).map((span) => span.span_id).filter(Boolean);

    store.run(
      `UPDATE memory_item
          SET summary_short = '', summary_long = NULL, structured_json = NULL,
              tags_json = NULL, entities_json = NULL, relations_json = NULL,
              embedding_refs_json = NULL, raw_text_ref = NULL, media_ref = NULL,
              source_turns_json = NULL, why_recalled_log_json = NULL,
              affect_ext_json = NULL, source_span_id = '', derived_from_json = '[]',
              supersedes_json = NULL, version_chain_json = NULL, superseded_by = NULL,
              quality_flag = ?, quality_reasons_json = ?
        WHERE mem_id = ? AND lifecycle_state = ?`,
      QUALITY_FLAG.DEGRADED,
      stringify(['deleted_tombstone']),
      row.mem_id,
      LIFECYCLE_STATE.DELETED_TOMBSTONE
    );

    store.run('DELETE FROM memory_vector_index_item WHERE mem_id = ? AND user_id = ?', row.mem_id, row.user_id);
    store.run('DELETE FROM memory_vector_index_fragment WHERE mem_id = ? AND user_id = ?', row.mem_id, row.user_id);
    store.run('DELETE FROM memory_vector_index_segment WHERE mem_id = ? AND user_id = ?', row.mem_id, row.user_id);

    if (spanIds.length) {
      const placeholders = spanIds.map(() => '?').join(',');
      store.run(
        `UPDATE memory_evidence_span
            SET raw_text = NULL, text_excerpt = NULL, media_ref = NULL, deletion_state = 'tombstone'
          WHERE user_id = ? AND span_id IN (${placeholders})`,
        row.user_id,
        ...spanIds
      );
      store.run(
        `DELETE FROM memory_fulltext_index
          WHERE user_id = ? AND object_id IN (${[...spanIds, row.mem_id].map(() => '?').join(',')})`,
        row.user_id,
        ...spanIds,
        row.mem_id
      );
    } else {
      store.run(
        'DELETE FROM memory_fulltext_index WHERE user_id = ? AND object_id = ?',
        row.user_id,
        row.mem_id
      );
    }

    store.run(
      `UPDATE memory_derived_edge SET deletion_state = 'tombstone'
        WHERE (from_id = ? OR to_id = ?) AND COALESCE(deletion_state, '') <> 'tombstone'`,
      row.mem_id,
      row.mem_id
    );

    stats.tombstoned += 1;
  }

  // 3) 前瞻过期（§17.7 / §10 prospective.expired）
  const probeRows = store.all(
    `SELECT prospective_id, user_id, agent_id, status, due_time
       FROM prospective_store
      WHERE status IN ('pending', 'triggered')
        AND due_time IS NOT NULL AND due_time < ?`,
    now
  );
  for (const row of probeRows) {
    store.run(
      `UPDATE prospective_store SET status = 'expired', updated_at = ? WHERE prospective_id = ?`,
      now,
      row.prospective_id
    );
    stats.prospective_expired += 1;
    safeAudit(store, {
      user_id: row.user_id,
      agent_id: row.agent_id,
      action: AUDIT_ACTION.PROSPECTIVE_EXPIRED,
      target_type: 'prospective_item',
      target_id: row.prospective_id,
      before: { status: row.status, due_time: row.due_time },
      after: { status: 'expired' },
      reason: 'due_time_expired',
      actor: { type: 'system', id: 'lifecycle_sweep' },
      sensitivity: SENSITIVITY.S2,
      now,
    });
  }

  // 4) 审计保留期（§21.3）：只追加/WORM，不能在此删除；
  //    这里给出 180/365 天到期数量，供合规归档管线处理。
  stats.audit_retention = audit.retentionReport(store, {
    now,
    default_days: AUDIT_RETENTION_DAYS.DEFAULT,
    sensitive_days: AUDIT_RETENTION_DAYS.SENSITIVE,
  });

  return stats;
}

module.exports = {
  ALLOWED_TRANSITIONS,
  M4_DOWNGRADE_TARGETS,
  transition,
  sweep,
};
