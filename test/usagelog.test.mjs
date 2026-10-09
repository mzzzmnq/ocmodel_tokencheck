import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUsageLog, usageLogSources } from "../src/usagelog.mjs";

function tempLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokencheck-log-"));
  const file = path.join(dir, "usage.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return { file, dir };
}

test("readUsageLog prices external lines with the shared table (peak-aware)", () => {
  const { file, dir } = tempLog([
    JSON.stringify({
      at: "2026-01-05T20:00:00Z", model: "deepseek-v4.1-flash", client: "openleet",
      tokens: { input: 1e6, output: 1e6, cacheRead: 1e6 }, sessionId: "leet-1", title: "two-sum",
    }),
    JSON.stringify({
      at: "2026-01-05T02:00:00Z", model: "deepseek-v4.1-flash", client: "openleet",
      input: 1e6, output: 1e6, cacheRead: 1e6,
    }),
  ]);
  const records = readUsageLog([file]);
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(records.length, 2);
  const [off, peak] = records;
  assert.equal(off.client, "openleet");
  assert.equal(off.isGo, true);
  assert.equal(off.sessionId, "leet-1");
  assert.equal(off.title, "two-sum");
  assert.equal(off.tier, "Off-Peak");
  assert.ok(Math.abs(off.cost - (0.15 + 0.6 + 0.003)) < 1e-12, `off-peak cost ${off.cost}`);
  assert.equal(peak.tier, "Peak");
  assert.ok(Math.abs(peak.cost - (0.3 + 1.2 + 0.006)) < 1e-12, `peak cost ${peak.cost}`);
});

test("readUsageLog tolerates malformed lines and unpriced models", () => {
  const { file, dir } = tempLog([
    "{ not json",
    JSON.stringify({ model: "omen-alpha", client: "openleet", tokens: { input: 1000 } }),
    JSON.stringify({ tokens: { input: 5 } }), // no model -> skipped
  ]);
  const records = readUsageLog([file]);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(records.length, 1);
  assert.equal(records[0].modelId, "omen-alpha");
  assert.equal(records[0].cost, 0, "an unpriced model contributes no cost");
});

test("readUsageLog expands a directory of .jsonl files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokencheck-logdir-"));
  fs.writeFileSync(
    path.join(dir, "a.jsonl"),
    JSON.stringify({ model: "glm-5.2", client: "openleet", input: 1e6 }) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "b.jsonl"),
    JSON.stringify({ model: "kimi-k3", client: "openleet", input: 1e6 }) + "\n",
    "utf8",
  );
  const records = readUsageLog([dir]);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.modelId).sort(), ["glm-5.2", "kimi-k3"]);
});

test("usageLogSources is opt-in via TOKENCHECK_USAGE_LOGS", () => {
  const prev = process.env.TOKENCHECK_USAGE_LOGS;
  delete process.env.TOKENCHECK_USAGE_LOGS;
  assert.deepEqual(usageLogSources(), [], "unset means no external source");
  process.env.TOKENCHECK_USAGE_LOGS = "C:/a.jsonl; C:/b.jsonl";
  assert.deepEqual(usageLogSources(), ["C:/a.jsonl", "C:/b.jsonl"]);
  if (prev === undefined) delete process.env.TOKENCHECK_USAGE_LOGS;
  else process.env.TOKENCHECK_USAGE_LOGS = prev;
});
