/**
 * Official OpenCode Go usage client.
 *
 * Endpoint: GET https://opencode.ai/zen/go/v1/usage
 *   -> { usage: { rolling: {status,percent,resetsAt}, weekly: {...}, monthly: {...} } }
 *
 * The three windows are account-wide: `percent` is the share of the account's
 * allowance already consumed, so they cannot be split per model. Per-model
 * numbers come from stats.mjs instead; this module supplies the authoritative
 * aggregate picture and the reset times.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { defaultDbPath } from "./stats.mjs";

export const USAGE_URL =
  process.env.TOKENCHECK_USAGE_URL || "https://opencode.ai/zen/go/v1/usage";

const CACHE_TTL_MS = Number(process.env.TOKENCHECK_CACHE_MS || 60_000);
let cache = { key: null, at: 0, payload: null, error: null };

export function configPath() {
  const dir = process.env.APPDATA
    ? path.join(process.env.APPDATA, "tokencheck")
    : path.join(os.homedir(), ".config", "tokencheck");
  return path.join(dir, "config.json");
}

export function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

export function writeConfigFile(patch) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...readConfigFile(), ...patch };
  fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  return next;
}

function stripPrefix(key) {
  return String(key || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
}

/** Look for an OpenCode Go key inside opencode's own credential store. */
export function keyFromOpencodeDb(dbFile = defaultDbPath()) {
  if (!fs.existsSync(dbFile)) return null;
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT integration_id, value FROM credential WHERE active = 1 AND integration_id LIKE 'opencode%'",
      )
      .all();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value);
        const key = stripPrefix(parsed.key || parsed.access || parsed.apiKey);
        if (key) return { key, source: `opencode.db:${row.integration_id}` };
      } catch {
        const key = stripPrefix(row.value);
        if (key) return { key, source: `opencode.db:${row.integration_id}` };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Resolve the API key, in priority order:
 *   1. TOKENCHECK_API_KEY env var
 *   2. tokencheck config file
 *   3. opencode's own credential store (so a working setup needs no config)
 */
export function resolveKey(opts = {}) {
  if (opts.apiKey) return { key: stripPrefix(opts.apiKey), source: "request" };

  const env = stripPrefix(process.env.TOKENCHECK_API_KEY || process.env.OPENCODE_GO_API_KEY);
  if (env) return { key: env, source: "env" };

  const cfg = readConfigFile();
  if (cfg.apiKey) return { key: stripPrefix(cfg.apiKey), source: "config" };

  const fromDb = keyFromOpencodeDb(opts.dbPath);
  if (fromDb) return fromDb;

  return { key: null, source: null };
}

export function maskKey(key) {
  if (!key) return null;
  if (key.length <= 12) return `${key.slice(0, 4)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function normalizeWindow(w) {
  if (!w || typeof w !== "object") return null;
  const percent = Number(w.percent);
  return {
    status: typeof w.status === "string" ? w.status : "unknown",
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
    resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
    rateLimited: w.status === "rate-limited",
  };
}

/**
 * Fetch the official usage windows.
 * @param {{apiKey?: string, dbPath?: string, force?: boolean}} [opts]
 */
export async function fetchOfficialUsage(opts = {}) {
  const { key, source } = resolveKey(opts);
  if (!key) {
    return {
      ok: false,
      reason: "no-key",
      message:
        "未找到 OpenCode Go API key。可在界面里填入，或设置 TOKENCHECK_API_KEY 环境变量。",
    };
  }

  if (!opts.force && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ...cache.payload, cached: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let payload;
  try {
    const res = await fetch(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        "User-Agent": "tokencheck/1.0",
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      payload = {
        ok: false,
        reason: "unauthorized",
        status: res.status,
        message: `官方用量接口返回 ${res.status}：API key 无效或无权读取额度。`,
        keySource: source,
        keyMasked: maskKey(key),
      };
    } else if (!res.ok) {
      payload = {
        ok: false,
        reason: "http-error",
        status: res.status,
        message: `官方用量接口返回 HTTP ${res.status}。`,
        keySource: source,
        keyMasked: maskKey(key),
      };
    } else {
      const body = await res.json();
      const usage = body?.usage ?? body?.data?.usage ?? null;
      if (!usage) {
        payload = {
          ok: false,
          reason: "shape",
          message: "官方用量接口响应格式无法识别。",
          raw: body,
          keySource: source,
          keyMasked: maskKey(key),
        };
      } else {
        payload = {
          ok: true,
          fetchedAt: Date.now(),
          endpoint: USAGE_URL,
          keySource: source,
          keyMasked: maskKey(key),
          usage: {
            rolling: normalizeWindow(usage.rolling),
            weekly: normalizeWindow(usage.weekly),
            monthly: normalizeWindow(usage.monthly),
          },
          plan: typeof body?.plan === "string" ? body.plan : null,
        };
      }
    }
  } catch (err) {
    payload = {
      ok: false,
      reason: err?.name === "AbortError" ? "timeout" : "network",
      message: `请求官方用量接口失败：${err?.message ?? err}`,
      keySource: source,
      keyMasked: maskKey(key),
    };
  } finally {
    clearTimeout(timer);
  }

  cache = { key, at: Date.now(), payload };
  return payload;
}

export function clearUsageCache() {
  cache = { key: null, at: 0, payload: null };
}
