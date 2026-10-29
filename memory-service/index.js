'use strict';

// 记忆服务门面：把所有记忆能力按「每个 AI 一个独立库」封装成统一入口。
// 契约依据：§1（L0 接口层）、§3（作用域隔离）。
// 存储位置：<AI 工作区>/.memory/memory.db —— 即容器内 /workspace/.memory/memory.db。

const storeModule = require('./store');
const write = require('./write');
const retrieval = require('./retrieval');
const media = require('./media');
const affect = require('./affect');
const persona = require('./persona');
const relationship = require('./relationship');
const prospective = require('./prospective');
const m4 = require('./m4');
const audit = require('./audit');
const deletion = require('./deletion');
const quota = require('./quota');
const lifecycle = require('./lifecycle');
const cache = require('./cache');
const evalModule = require('./eval');
const embedding = require('./embedding');
const constants = require('./constants');
const schema = require('./schema');

const DEFAULT_USER_ID = 'admin';

/**
 * 获取某个 AI 的记忆上下文。workspaceDir 必须是该 AI 的工作区根目录
 * （宿主机 data/agents/<agent_id>/workspace），数据库文件由 store 自动创建。
 */
function forAgent({ agentId, workspaceDir, userId = DEFAULT_USER_ID }) {
  if (!agentId) throw new Error('agentId 必填');
  if (!workspaceDir) throw new Error('workspaceDir 必填');

  const store = storeModule.getStore({ agentId, workspaceDir });

  const ctx = {
    agentId,
    userId,
    workspaceDir,
    store,
    dir: store.memoryDir,

    // ---------- 写入 ----------
    write(input = {}) {
      const now = input.now || storeModule.nowIso();
      const items = Array.isArray(input.items) ? input.items : [input.item || input];
      const result = write.writeBatch(store, {
        items,
        source_turn_id: input.source_turn_id ?? null,
        context: {
          agentId,
          userId: input.user_id || userId,
          scope: input.scope,
          tenantId: input.tenant_id,
          orgId: input.org_id,
          sessionId: input.session_id,
          now
        },
        actor: input.actor || agentId,
        request_id: input.request_id,
        now,
        embedder: input.embedder
      });
      // 配额与审计（失败不阻断写入，只记录）
      try {
        const okCount = (result.results || []).filter((r) => r.ok).length;
        if (okCount) {
          quota.consume(store, {
            user_id: input.user_id || userId,
            agent_id: agentId,
            dimension: 'memory_items',
            amount: okCount,
            now
          });
        }
      } catch (error) {
        result.warnings = (result.warnings || []).concat([{ code: 'quota_record_failed', message: error.message }]);
      }
      return result;
    },

    // ---------- 召回 ----------
    recall(input = {}) {
      const now = input.now || storeModule.nowIso();
      const result = retrieval.recall(store, {
        query: input.query || '',
        user_id: input.user_id || userId,
        agent_id: agentId,
        scope: input.scope || 'user',
        tenant_id: input.tenant_id,
        org_id: input.org_id,
        session_id: input.session_id,
        layer: input.layer,
        types: input.types,
        top_k: input.top_k,
        token_budget: input.token_budget ?? input.budget,
        scenario: input.scenario,
        sensitivity_max: input.sensitivity_max,
        purpose: input.purpose,
        must_inject: input.must_inject,
        now,
        use_embedder: input.use_embedder,
        request_id: input.request_id
      });
      try {
        quota.consume(store, {
          user_id: input.user_id || userId,
          agent_id: agentId,
          dimension: 'recall_calls',
          amount: 1,
          now
        });
      } catch {
        // 配额统计失败不影响召回
      }
      return result;
    },

    // ---------- 遗忘 ----------
    forget(input = {}) {
      const now = input.now || storeModule.nowIso();
      const memIds = Array.isArray(input.mem_ids) ? input.mem_ids : [];
      if (!memIds.length) {
        return { ok: false, code: 'INVALID_PAYLOAD', message: 'mem_ids 不能为空' };
      }
      const job = deletion.request(store, {
        mem_ids: memIds,
        user_id: input.user_id || userId,
        agent_id: agentId,
        reason: input.reason || 'ai_request',
        actor: input.actor || agentId,
        now
      });
      const jobId = job.job_id || job.jobId || job.id;
      const run = jobId ? deletion.runJob(store, { job_id: jobId, now }) : job;
      return { ok: true, job_id: jobId, result: run };
    },

    // ---------- 多模态 ----------
    media(adapters = {}) {
      return media.create({ ...adapters, store });
    },
    registerFile(input = {}) {
      return media.registerFile(store, { user_id: userId, agent_id: agentId, ...input });
    },
    buildDossier(input = {}, adapters = {}) {
      const service = media.create({ ...adapters, store });
      return service.buildDossier(store, { user_id: userId, agent_id: agentId, ...input });
    },
    searchMedia(input = {}, adapters = {}) {
      const service = media.create({ ...adapters, store });
      return service.search(store, { user_id: userId, agent_id: agentId, ...input });
    },

    // ---------- 情感 / 人格 / 关系 / 前瞻 / M4 ----------
    affect: {
      upsert(state, input = {}) {
        return affect.upsertState(store, { user_id: userId, agent_id: agentId, affect_state: state, ...input });
      },
      get() {
        return affect.getState(store, { user_id: userId, agent_id: agentId });
      },
      decay(state, options = {}) {
        return affect.decay(state, { store, user_id: userId, agent_id: agentId, ...options });
      },
      recognize(text) {
        return affect.recognize(text);
      }
    },
    persona: {
      get() {
        return persona.getProfile(store, { user_id: userId, agent_id: agentId });
      },
      upsert(profile, input = {}) {
        return persona.upsertProfile(store, { user_id: userId, agent_id: agentId, persona: profile, ...input });
      },
      calibrate(profile, opts = {}) {
        return persona.calibrate(profile, opts);
      }
    },
    relationship: {
      upsert(input = {}) {
        return relationship.upsertEdge(store, { user_id: userId, agent_id: agentId, ...input });
      },
      milestone(input = {}) {
        return relationship.addMilestone(store, { user_id: userId, agent_id: agentId, ...input });
      },
      top(limit = 10) {
        return relationship.getTopEdges(store, { user_id: userId, agent_id: agentId, limit });
      }
    },
    prospective: {
      create(item, input = {}) {
        return prospective.create(store, { user_id: userId, agent_id: agentId, item, ...input });
      },
      due(now) {
        return prospective.due(store, { now: now || storeModule.nowIso(), user_id: userId, agent_id: agentId });
      },
      expire(now) {
        return prospective.expire(store, { now: now || storeModule.nowIso() });
      }
    },
    m4: {
      request(input = {}) {
        return m4.request(store, { requested_by: agentId, ...input });
      },
      review(input = {}) {
        return m4.review(store, input);
      },
      apply(input = {}) {
        return m4.apply(store, input);
      },
      get(requestId) {
        return m4.get(store, { request_id: requestId });
      }
    },

    // ---------- 审计 / 配额 / 生命周期 / 评测 ----------
    audit: {
      trace(input = {}) {
        return audit.trace(store, { user_id: userId, ...input });
      },
      verify() {
        return audit.verifyChain(store, { user_id: userId });
      }
    },
    quota() {
      return quota.usage(store, { user_id: userId, agent_id: agentId });
    },
    sweep(now) {
      return lifecycle.sweep(store, { now: now || storeModule.nowIso() });
    },
    evaluate(cases, now) {
      const ctx0 = { store, agentId, userId, now: now || storeModule.nowIso() };
      return evalModule.runSuite(ctx0, cases || evalModule.defaultCases(ctx0));
    },

    // ---------- 直接暴露底层模块 ----------
    modules: {
      store, write, retrieval, media, affect, persona, relationship,
      prospective, m4, audit, deletion, quota, lifecycle, cache, eval: evalModule,
      embedding, constants, schema
    }
  };

  return ctx;
}

module.exports = {
  DEFAULT_USER_ID,
  forAgent,
  closeAll: storeModule.closeAll,
  ...constants,
  ...{ schema }
};
