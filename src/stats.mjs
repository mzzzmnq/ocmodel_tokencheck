/**
 * Local per-model usage accounting, read from opencode's own SQLite store.
 *
 * opencode records, for every assistant message, the model that served it plus
 * a full token breakdown and the cost it attributed to the request. That makes
 * the local database the only source of *per-model* consumption — the official
 * OpenCode Go usage API only reports account-wide rolling / weekly / monthly
 * percentages.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { costOf, getModel, isPeakHour, monthlyLimit, windowStarts } from "./pricing.mjs";

export function defaultDbPath() {
  const override = process.env.TOKENCHECK_DB;
  if (override) return override;
  return path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}

export function emptyWindow() {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costRaw: 0,
    calls: 0,
    errors: 0,
    peakCalls: 0,
    offPeakCalls: 0,
  };
}

function addInto(acc, rec) {
  acc.input += rec.tokens.input;
  acc.output += rec.tokens.output;
  acc.reasoning += rec.tokens.reasoning;
  acc.cacheRead += rec.tokens.cacheRead;
  acc.cacheWrite += rec.tokens.cacheWrite;
  acc.cost += rec.cost;
  acc.costRaw += rec.costRaw;
  acc.calls += 1;
  if (rec.error) acc.errors += 1;
  if (rec.peak === true) acc.peakCalls += 1;
  if (rec.peak === false) acc.offPeakCalls += 1;
}

function num(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Read every assistant usage record from the opencode database.
 * @param {{dbPath?: string, modelsDevPath?: string}} [opts]
 */
export function readRecords(opts = {}) {
  const dbPath = opts.dbPath || defaultDbPath();
  if (!fs.existsSync(dbPath)) {
    const err = new Error(`opencode database not found at ${dbPath}`);
    err.code = "ENODB";
    throw err;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows;
  let sessions;
  try {
    rows = db
      .prepare(
        `SELECT m.id AS id, m.session_id AS sessionId, m.time_created AS createdAt, m.data AS data,
                s.title AS title
           FROM session_message m
           LEFT JOIN session_v2 s ON s.id = m.session_id
          WHERE m.type = 'assistant'`,
      )
      .all();
    sessions = db
      .prepare("SELECT id, title, model, cost, tokens_input, tokens_output, tokens_cache_read FROM session_v2")
      .all();
  } finally {
    db.close();
  }

  const records = [];
  for (const row of rows) {
    let data;
    try {
      data = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (!data || !data.tokens || !data.model || !data.model.id) continue;
    const at = data.time?.created ?? row.createdAt ?? Date.now();

    // Sub-agent / auxiliary calls are recorded without a providerID; keep them,
    // they still consume the same allowance.
    const modelId = data.model.id;
    const providerId = data.model.providerID ?? null;

    const tokens = {
      input: num(data.tokens.input),
      output: num(data.tokens.output),
      reasoning: num(data.tokens.reasoning),
      cacheRead: num(data.tokens.cache?.read),
      cacheWrite: num(data.tokens.cache?.write),
    };

    const priced = costOf(modelId, tokens, { at });
    const recorded = Number.isFinite(data.cost) ? data.cost : null;
    records.push({
      id: row.id,
      sessionId: row.sessionId,
      title: row.title ?? null,
      at,
      modelId,
      providerId,
      isGo: providerId === "opencode-go",
      tokens,
      peak: getModel(modelId)?.peakRate ? isPeakHour(at) : null,
      tier: priced?.tier ?? null,
      cost: recorded ?? priced?.cost ?? 0,
      costRaw: priced?.cost ?? 0,
      error: data.finish === "error" || Boolean(data.error),
    });
  }

  records.sort((a, b) => a.at - b.at);
  return { records, sessions, dbPath };
}

/**
 * Aggregate usage per model for a set of windows.
 *
 * @param {{dbPath?: string, plan?: string, now?: number}} [opts]
 */
export function buildStats(opts = {}) {
  if (opts.plan && opts.plan !== "go" && opts.plan !== "plus") {
    throw new Error(`unknown plan: ${opts.plan}`);
  }
  const now = opts.now ?? Date.now();
  const plan = opts.plan === "plus" ? "plus" : "go";
  const { records, sessions, dbPath } = readRecords(opts);
  const starts = windowStarts(now);

  const windows = {
    rolling: starts.rolling,
    weekly: starts.weekly,
    monthly: starts.monthly,
    all: -Infinity,
  };

  /** @type {Map<string, {model: any, windows: Record<string, any>, lastUsedAt: number, sessions: Set<string>}>} */
  const byModel = new Map();
  /** @type {Record<string, any>} */
  const totals = {
    rolling: emptyWindow(),
    weekly: emptyWindow(),
    monthly: emptyWindow(),
    all: emptyWindow(),
  };
  const daily = new Map();

  for (const rec of records) {
    if (!rec.isGo) continue;
    let entry = byModel.get(rec.modelId);
    if (!entry) {
      const meta = getModel(rec.modelId);
      entry = {
        modelId: rec.modelId,
        label: meta?.label ?? rec.modelId,
        known: Boolean(meta),
        unlimited: meta ? !Number.isFinite(meta.limit) : false,
        monthlyLimit: monthlyLimit(rec.modelId, plan),
        windows: {
          rolling: emptyWindow(),
          weekly: emptyWindow(),
          monthly: emptyWindow(),
          all: emptyWindow(),
        },
        lastUsedAt: 0,
        sessionCount: 0,
        _sessions: new Set(),
        peakSplit: meta?.peak ? { peakCost: 0, offPeakCost: 0 } : null,
      };
      byModel.set(rec.modelId, entry);
    }

    entry.lastUsedAt = Math.max(entry.lastUsedAt, rec.at);
    entry._sessions.add(rec.sessionId);
    if (entry.peakSplit) {
      if (rec.peak) entry.peakSplit.peakCost += rec.cost;
      else entry.peakSplit.offPeakCost += rec.cost;
    }

    for (const [name, start] of Object.entries(windows)) {
      if (rec.at >= start) addInto(entry.windows[name], rec);
      if (rec.at >= start) addInto(totals[name], rec);
    }

    const day = new Date(rec.at).toISOString().slice(0, 10);
    const d = daily.get(day) || { date: day, cost: 0, calls: 0, byModel: {} };
    d.cost += rec.cost;
    d.calls += 1;
    d.byModel[rec.modelId] = (d.byModel[rec.modelId] || 0) + rec.cost;
    daily.set(day, d);
  }

  const goRecords = records.filter((r) => r.isGo);

  const models = [...byModel.values()]
    .map((e) => {
      const used = e.windows.monthly.cost;
      const limit = e.monthlyLimit;
      const unlimited = e.unlimited || !Number.isFinite(limit);
      const remaining = unlimited ? Infinity : Math.max(0, limit - used);
      return {
        modelId: e.modelId,
        label: e.label,
        known: e.known,
        unlimited,
        monthlyLimit: unlimited ? null : limit,
        windows: e.windows,
        lastUsedAt: e.lastUsedAt || null,
        sessionCount: e._sessions.size,
        peakSplit: e.peakSplit,
        monthly: {
          used,
          limit: unlimited ? null : limit,
          remaining: unlimited ? null : remaining,
          percentUsed: unlimited || limit <= 0 ? 0 : (used / limit) * 100,
          percentRemaining: unlimited || limit <= 0 ? 100 : (remaining / limit) * 100,
        },
        costBasis: {
          official: e.windows.monthly.cost,
          opencodeRecorded: e.windows.monthly.costRaw,
          delta: e.windows.monthly.cost - e.windows.monthly.costRaw,
        },
        shares: modelShares(goRecords, e.modelId, starts),
      };
    })
    .sort((a, b) => b.windows.monthly.cost - a.windows.monthly.cost || b.windows.all.calls - a.windows.all.calls);

  for (const e of byModel.values()) delete e._sessions;

  return {
    generatedAt: now,
    dbPath,
    plan,
    windows: {
      rolling: { startsAt: starts.rolling, resetsAt: null, label: "5 小时滚动" },
      weekly: { startsAt: starts.weekly, resetsAt: starts.weeklyResetsAt, label: "本周" },
      monthly: { startsAt: starts.monthly, resetsAt: starts.monthlyResetsAt, label: "本月" },
      all: { startsAt: null, resetsAt: null, label: "全部" },
    },
    models,
    totals,
    daily: fillDaily(daily, now, 14),
    sessionCount: sessions.length,
    recordCount: records.length,
    goRecordCount: records.filter((r) => r.isGo).length,
  };
}

/**
 * Per-model consumption inside each billing window.
 *
 * `shareRatio` is the fraction of this model's own documented monthly limit
 * that the locally observed spend in that window represents. It is derived from
 * local records only, because the official API reports a single account-wide
 * percentage per window and cannot be split by model.
 */
function modelShares(goRecords, modelId, starts) {
  const meta = getModel(modelId);
  const limit = monthlyLimit(modelId, "go");
  const out = {};
  const windows = { rolling: starts.rolling, weekly: starts.weekly, monthly: starts.monthly };

  for (const [name, start] of Object.entries(windows)) {
    let cost = 0;
    for (let i = goRecords.length - 1; i >= 0; i--) {
      const r = goRecords[i];
      if (r.at < start) break;
      if (r.modelId === modelId) cost += r.cost;
    }
    out[name] = {
      cost,
      calls: goRecords.filter((r) => r.modelId === modelId && r.at >= start).length,
      shareRatio: Number.isFinite(limit) && limit > 0 ? cost / limit : 0,
      hasPeakPricing: Boolean(meta?.peakRate),
    };
  }

  // Nested-window guard: the monthly share must never look smaller than weekly,
  // and weekly never smaller than rolling.
  out.weekly.shareRatio = Math.max(out.weekly.shareRatio, out.rolling.shareRatio);
  out.monthly.shareRatio = Math.max(out.monthly.shareRatio, out.weekly.shareRatio);
  return out;
}

/**
 * Emit one entry per calendar day for the last `days` days, so the chart always
 * shows a continuous timeline instead of jumping between active days.
 */
function fillDaily(daily, now, days) {
  const out = [];
  const end = new Date(now);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - i));
    const date = d.toISOString().slice(0, 10);
    out.push(daily.get(date) ?? { date, cost: 0, calls: 0, byModel: {} });
  }
  return out;
}

/** Recent N calls, newest first. */
export function recentCalls(opts = {}, limit = 40) {
  const { records } = readRecords(opts);
  return records
    .filter((r) => r.isGo)
    .slice(-limit)
    .reverse()
    .map((r) => ({
      id: r.id,
      at: r.at,
      modelId: r.modelId,
      label: getModel(r.modelId)?.label ?? r.modelId,
      title: r.title,
      tokens: r.tokens,
      cost: r.cost,
      costRaw: r.costRaw,
      tier: r.tier,
      error: r.error,
    }));
}

/** Distinct opencode-go model ids seen locally, for coverage checking. */
export function localModelIds(opts = {}) {
  const { records } = readRecords(opts);
  return [...new Set(records.filter((r) => r.isGo).map((r) => r.modelId))].sort();
}
