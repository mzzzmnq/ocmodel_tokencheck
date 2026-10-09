/**
 * tokencheck — a zero-dependency local dashboard that shows how much of the
 * OpenCode Go allowance each model has consumed.
 *
 * Data sources
 *   1. Official OpenCode Go usage API  -> account-wide rolling/weekly/monthly %.
 *   2. Local opencode store (SQLite)   -> per-model tokens, cost and call counts.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStats, recentCalls, sessionStats, defaultDbPath } from "./stats.mjs";
import {
  fetchOfficialUsage,
  fetchModelCatalog,
  resolveKey,
  maskKey,
  writeConfigFile,
  configPath,
  clearUsageCache,
  clearCatalogCache,
} from "./official.mjs";
import { buildCoverage } from "./coverage.mjs";
import { MODELS, monthlyLimit, isPeakHour, WINDOW_RULES, windowOverridesFromOfficial } from "./pricing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const TOKENCHECK_VERSION = "1.0.0";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=");
    args.set(k, v ?? "true");
  }
}

const HOST = args.get("host") || process.env.TOKENCHECK_HOST || "127.0.0.1";
const PORT = Number(args.get("port") || process.env.TOKENCHECK_PORT || 7788);
const DB_PATH = args.get("db") || defaultDbPath();
const PLAN = args.get("plan") === "plus" ? "plus" : "go";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const target = path.resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(target, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(buf);
  });
}

async function api(req, res, url) {
  const route = url.pathname;

  if (route === "/api/health" && req.method === "GET") {
    return json(res, 200, { ok: true, version: TOKENCHECK_VERSION, dbPath: DB_PATH, plan: PLAN });
  }

  if (route === "/api/usage" && req.method === "GET") {
    const plan = url.searchParams.get("plan") === "plus" ? "plus" : url.searchParams.get("plan") === "go" ? "go" : PLAN;
    // Fetch the official windows first: their resetsAt define the account's real
    // billing windows, which the local aggregation is aligned to.
    const official = await fetchOfficialUsage({
      force: url.searchParams.get("force") === "1",
      dbPath: DB_PATH,
    });
    const windowOverrides = windowOverridesFromOfficial(official);
    let local;
    try {
      local = { ok: true, data: buildStats({ dbPath: DB_PATH, plan, windowOverrides }) };
    } catch (err) {
      local = {
        ok: false,
        reason: err.code === "ENODB" ? "no-db" : "error",
        message: err.message,
      };
    }

    let calls = [];
    let topSessions = [];
    if (local.ok) {
      try {
        calls = recentCalls({ dbPath: DB_PATH }, 25);
      } catch {
        calls = [];
      }
      try {
        topSessions = sessionStats({ dbPath: DB_PATH }, 15);
      } catch {
        topSessions = [];
      }
    }

    return json(res, 200, {
      version: TOKENCHECK_VERSION,
      now: Date.now(),
      plan,
      official,
      local,
      recentCalls: calls,
      topSessions,
    });
  }

  if (route === "/api/models" && req.method === "GET") {
    const rows = Object.entries(MODELS).map(([id, m]) => ({
      id,
      label: m.label,
      limit: Number.isFinite(m.limit) ? m.limit : null,
      unlimited: !Number.isFinite(m.limit),
      goLimit: monthlyLimit(id, "go"),
      plusLimit: monthlyLimit(id, "plus"),
      peak: Boolean(m.peakRate),
      tiers: m.tiers.map((t) => ({ ...t })),
    }));
    return json(res, 200, {
      count: rows.length,
      models: rows,
      windowRules: WINDOW_RULES,
      peakNow: isPeakHour(new Date()),
    });
  }

  if (route === "/api/catalog" && req.method === "GET") {
    const catalog = await fetchModelCatalog({ force: url.searchParams.get("force") === "1" });
    return json(res, 200, catalog);
  }

  if (route === "/api/coverage" && req.method === "GET") {
    const plan = url.searchParams.get("plan") === "plus" ? "plus" : PLAN;
    const coverage = await buildCoverage({
      dbPath: DB_PATH,
      plan,
      force: url.searchParams.get("force") === "1",
    });
    return json(res, 200, coverage);
  }

  if (route === "/api/key") {
    if (req.method === "GET") {
      const { key, source } = resolveKey({ dbPath: DB_PATH });
      const cfg = fs.existsSync(configPath());
      return json(res, 200, {
        hasKey: Boolean(key),
        masked: maskKey(key),
        source,
        configPath: configPath(),
        configExists: cfg,
      });
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      if (typeof body.apiKey !== "string") {
        return json(res, 400, { ok: false, message: "需要 apiKey 字段" });
      }
      const trimmed = body.apiKey.trim().replace(/^Bearer\s+/i, "");
      writeConfigFile({ apiKey: trimmed || null });
      clearUsageCache();
      const { key, source } = resolveKey({ dbPath: DB_PATH });
      return json(res, 200, { ok: true, hasKey: Boolean(key), masked: maskKey(key), source });
    }
    return json(res, 405, { ok: false, message: "method not allowed" });
  }

  if (route === "/api/refresh" && req.method === "POST") {
    clearUsageCache();
    clearCatalogCache();
    const [official, catalog] = await Promise.all([
      fetchOfficialUsage({ force: true, dbPath: DB_PATH }),
      fetchModelCatalog({ force: true }),
    ]);
    return json(res, 200, { ok: official.ok, official, catalog });
  }

  return json(res, 404, { ok: false, message: `unknown route ${route}` });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    api(req, res, url).catch((err) => {
      json(res, 500, { ok: false, message: String(err?.message || err) });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`tokencheck ${TOKENCHECK_VERSION}`);
  console.log(`  界面: ${url}`);
  console.log(`  数据库: ${DB_PATH}`);
  console.log(`  套餐: Go${PLAN === "plus" ? " Plus" : ""}`);
  const { key, source } = resolveKey({ dbPath: DB_PATH });
  console.log(`  API key: ${key ? `已发现（${source}）` : "未配置（仅显示本地统计）"}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
