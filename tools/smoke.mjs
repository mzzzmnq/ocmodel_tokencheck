/**
 * End-to-end HTTP checks against a live tokencheck server.
 * Usage: node --experimental-sqlite tools/smoke.mjs [--port 7799]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 7799;
const base = `http://127.0.0.1:${port}`;

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokencheck-cfg-"));
const child = spawn(
  process.execPath,
  ["--experimental-sqlite", path.join(root, "src", "server.mjs"), `--port=${port}`],
  { env: { ...process.env, APPDATA: configDir, TOKENCHECK_API_KEY: "" }, stdio: "inherit" },
);

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const get = async (p, init) => {
  const res = await fetch(base + p, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, headers: res.headers, text, json };
};

const waitForServer = async () => {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

try {
  check("server becomes reachable", await waitForServer());

  const health = await get("/api/health");
  check("GET /api/health", health.status === 200 && health.json.ok === true);

  const usage = await get("/api/usage");
  check("GET /api/usage returns 200", usage.status === 200);
  check("usage payload has official + local + recentCalls",
    Boolean(usage.json.official) && Boolean(usage.json.local) && Array.isArray(usage.json.recentCalls));
  check("official block reports key provenance",
    typeof usage.json.official.keySource === "string" || usage.json.official.reason === "no-key",
    `reason=${usage.json.official.reason ?? "-"} source=${usage.json.official.keySource ?? "-"}`);
  check("safe mode never leaks the raw API key",
    !/oc_sk_[A-Za-z0-9]{8,}/.test(usage.text), "response contains no full key");
  check("local block has per-model rows",
    usage.json.local.ok === true && Array.isArray(usage.json.local.data.models),
    usage.json.local.ok ? `${usage.json.local.data.models.length} models` : usage.json.local.message);

  const plus = await get("/api/usage?plan=plus");
  check("plan=plus is honoured", plus.json.plan === "plus");

  const models = await get("/api/models");
  check("GET /api/models lists the price table",
    models.status === 200 && models.json.count > 20, `${models.json.count} models`);

  const key0 = await get("/api/key");
  check("GET /api/key reports state without the secret",
    typeof key0.json.hasKey === "boolean" && !JSON.stringify(key0.json).includes("sk_35575004"));

  const saved = await get("/api/key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "oc_sk_test_injected_key_123456" }),
  });
  check("POST /api/key stores a key", saved.json.ok === true && saved.json.hasKey === true,
    `${saved.json.masked} from ${saved.json.source}`);
  check("stored key is masked in the response", saved.json.masked.includes("…"));

  const cfgFile = path.join(configDir, "tokencheck", "config.json");
  check("key was written to the isolated config file", fs.existsSync(cfgFile));

  const forced = await get("/api/refresh", { method: "POST" });
  check("POST /api/refresh re-reads the official endpoint", forced.status === 200 && "official" in forced.json);

  const wrong = await get("/api/key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nope: true }),
  });
  check("POST /api/key rejects a malformed body", wrong.status === 400);

  const clear = await get("/api/key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "" }),
  });
  check("POST /api/key with an empty key clears it", clear.status === 200);

  const badJson = await fetch(`${base}/api/key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  check("invalid JSON body is a 500, not a crash", badJson.status === 500);

  const missing = await get("/api/nope");
  check("unknown API route returns 404", missing.status === 404);

  const index = await get("/");
  check("GET / serves the dashboard", index.status === 200 && /OpenCode Go 额度监控/.test(index.text));

  const css = await get("/styles.css");
  check("GET /styles.css", css.status === 200 && css.headers.get("content-type").includes("text/css"));

  const js = await get("/app.js");
  check("GET /app.js", js.status === 200 && js.headers.get("content-type").includes("javascript"));

  const traversal = await fetch(`${base}/../package.json`);
  const traversalText = await traversal.text();
  check("path traversal outside public/ is refused",
    (traversal.status === 403 || traversal.status === 404) &&
      !traversalText.includes('"name": "tokencheck"'),
    `status=${traversal.status}`);

  const encodedTraversal = await fetch(`${base}/%2e%2e%2fpackage.json`);
  const encodedText = await encodedTraversal.text();
  check("encoded traversal is refused too",
    (encodedTraversal.status === 403 || encodedTraversal.status === 404) &&
      !encodedText.includes('"name": "tokencheck"'),
    `status=${encodedTraversal.status}`);
} finally {
  child.kill();
  fs.rmSync(configDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
