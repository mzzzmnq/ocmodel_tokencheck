import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildStats, recentCalls, defaultDbPath } from "../src/stats.mjs";

/** Build a throwaway opencode-shaped database with known records. */
function fixtureDb(messages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokencheck-"));
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, title TEXT, model TEXT, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
  `);
  const insSession = db.prepare("INSERT INTO session_v2 (id, title) VALUES (?, ?)");
  const insMsg = db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?,?,?,?,?,?)",
  );
  const sessions = new Set();
  messages.forEach((m, i) => {
    if (!sessions.has(m.sessionId)) {
      sessions.add(m.sessionId);
      insSession.run(m.sessionId, `session ${m.sessionId}`);
    }
    insMsg.run(
      `msg_${i}`,
      m.sessionId,
      "assistant",
      i,
      m.at,
      JSON.stringify({
        time: { created: m.at },
        model: { id: m.modelId, providerID: m.providerId ?? "opencode-go" },
        tokens: {
          input: m.input ?? 0,
          output: m.output ?? 0,
          reasoning: m.reasoning ?? 0,
          cache: { read: m.cacheRead ?? 0, write: m.cacheWrite ?? 0 },
        },
        cost: m.cost,
        finish: m.finish ?? "stop",
      }),
    );
  });
  db.close();
  return { file, dir };
}

const NOW = Date.UTC(2026, 0, 8, 12, 0, 0); // Thursday noon UTC

test("buildStats aggregates per model and separates billing windows", () => {
  const { file, dir } = fixtureDb([
    // inside the 5h rolling window
    { sessionId: "s1", at: NOW - 60_000, modelId: "kimi-k3", input: 1e6, cost: 3.0 },
    // inside the week but outside 5h
    { sessionId: "s1", at: NOW - 30 * 3600_000, modelId: "kimi-k3", output: 1e6, cost: 15.0 },
    // inside the month but outside the week (Fri Jan 2)
    { sessionId: "s2", at: Date.UTC(2026, 0, 2, 3, 0, 0), modelId: "glm-5.2", input: 1e6, cost: 1.4 },
    // previous month, only counted in "all"
    { sessionId: "s2", at: Date.UTC(2025, 11, 20), modelId: "glm-5.2", input: 1e6, cost: 1.4 },
    // another provider must be ignored entirely
    { sessionId: "s3", at: NOW - 1000, modelId: "claude-sonnet", providerId: "anthropic", cost: 99 },
  ]);

  const stats = buildStats({ dbPath: file, now: NOW, plan: "go" });
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(stats.recordCount, 5);
  assert.equal(stats.goRecordCount, 4);

  const kimi = stats.models.find((m) => m.modelId === "kimi-k3");
  assert.ok(kimi, "kimi present");
  assert.equal(kimi.windows.rolling.cost, 3.0);
  assert.equal(kimi.windows.weekly.cost, 18.0);
  assert.equal(kimi.windows.monthly.cost, 18.0);
  assert.equal(kimi.windows.all.cost, 18.0);
  assert.equal(kimi.windows.monthly.calls, 2);
  assert.equal(kimi.monthlyLimit, 15);
  assert.equal(kimi.monthly.used, 18);
  assert.equal(kimi.monthly.remaining, 0);
  assert.ok(kimi.monthly.percentUsed > 100);

  const glm = stats.models.find((m) => m.modelId === "glm-5.2");
  assert.equal(glm.windows.rolling.cost, 0);
  assert.equal(glm.windows.weekly.cost, 0);
  assert.equal(glm.windows.monthly.cost, 1.4);
  assert.equal(glm.windows.all.cost, 2.8);
  assert.equal(glm.monthlyLimit, 60);

  // share ratios never decrease as the window widens
  assert.ok(kimi.shares.rolling.shareRatio <= kimi.shares.weekly.shareRatio + 1e-12);
  assert.ok(kimi.shares.weekly.shareRatio <= kimi.shares.monthly.shareRatio + 1e-12);
  assert.ok(Math.abs(kimi.shares.rolling.shareRatio - 3 / 15) < 1e-12);

  // models are ordered by monthly spend, descending
  assert.deepEqual(
    stats.models.map((m) => m.modelId),
    ["kimi-k3", "glm-5.2"],
  );

  assert.equal(stats.totals.rolling.cost, 3.0);
  assert.equal(stats.totals.weekly.cost, 18.0);
  assert.equal(Math.round(stats.totals.monthly.cost * 1e6) / 1e6, 19.4);
  assert.equal(Math.round(stats.totals.all.cost * 1e6) / 1e6, 20.8);
  assert.equal(stats.totals.monthly.calls, 3);
  assert.equal(stats.totals.monthly.errors, 0);
  assert.equal(stats.windows.monthly.resetsAt, Date.UTC(2026, 1, 1));
});

test("token counters accumulate per window and per model", () => {
  const { file, dir } = fixtureDb([
    {
      sessionId: "s1", at: NOW - 60_000, modelId: "kimi-k3",
      input: 100, output: 20, reasoning: 5, cacheRead: 1000, cacheWrite: 7, cost: 0.01,
    },
    {
      sessionId: "s1", at: NOW - 120_000, modelId: "kimi-k3",
      input: 200, output: 40, reasoning: 10, cacheRead: 2000, cacheWrite: 3, cost: 0.02,
    },
  ]);
  const stats = buildStats({ dbPath: file, now: NOW, plan: "go" });
  fs.rmSync(dir, { recursive: true, force: true });

  const w = stats.models[0].windows.monthly;
  assert.deepEqual(
    { input: w.input, output: w.output, reasoning: w.reasoning, cacheRead: w.cacheRead, cacheWrite: w.cacheWrite },
    { input: 300, output: 60, reasoning: 15, cacheRead: 3000, cacheWrite: 10 },
  );
  const t = stats.totals.monthly;
  assert.equal(t.input, 300);
  assert.equal(t.cacheRead, 3000);
  assert.equal(t.cost, 0.03);
});

test("Go Plus doubles the per-model allowance", () => {
  const { file, dir } = fixtureDb([
    { sessionId: "s1", at: NOW - 1000, modelId: "kimi-k3", cost: 18 },
  ]);
  const go = buildStats({ dbPath: file, now: NOW, plan: "go" });
  const plus = buildStats({ dbPath: file, now: NOW, plan: "plus" });
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(go.models[0].monthlyLimit, 15);
  assert.equal(plus.models[0].monthlyLimit, 30);
  assert.equal(go.models[0].monthly.remaining, 0);
  assert.equal(plus.models[0].monthly.remaining, 12);
});

test("unlimited free models report no limit and no percentage", () => {
  const { file, dir } = fixtureDb([
    { sessionId: "s1", at: NOW - 1000, modelId: "longcat-2.5-preview-free", input: 1e7, cost: 0 },
  ]);
  const stats = buildStats({ dbPath: file, now: NOW, plan: "go" });
  fs.rmSync(dir, { recursive: true, force: true });
  const m = stats.models[0];
  assert.equal(m.unlimited, true);
  assert.equal(m.monthlyLimit, null);
  assert.equal(m.monthly.remaining, null);
});

test("per-model counts include calls with missing cost and flag errors", () => {
  const { file, dir } = fixtureDb([
    { sessionId: "s1", at: NOW - 1000, modelId: "kimi-k3", input: 1000, cost: 0.003 },
    { sessionId: "s1", at: NOW - 2000, modelId: "kimi-k3", input: 1000, cost: 0.003, finish: "error" },
  ]);
  const stats = buildStats({ dbPath: file, now: NOW, plan: "go" });
  const calls = recentCalls({ dbPath: file }, 10);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(stats.models[0].windows.monthly.calls, 2);
  assert.equal(stats.models[0].windows.monthly.errors, 1);
  assert.equal(calls.length, 2);
  // newest first, and the errored call is flagged
  assert.ok(calls[0].at > calls[1].at);
  assert.equal(calls.filter((c) => c.error).length, 1);
});

test("daily rollup covers a continuous 14-day timeline", () => {
  // Activity on the last four days only, so the older days must be zero-filled.
  const msgs = [];
  for (let i = 0; i < 4; i++) {
    msgs.push({
      sessionId: "s1",
      at: NOW - i * 86_400_000,
      modelId: "glm-5.2",
      input: 1000,
      cost: 0.0014,
    });
  }
  const { file, dir } = fixtureDb(msgs);
  const stats = buildStats({ dbPath: file, now: NOW, plan: "go" });
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(stats.daily.length, 14);
  const dates = stats.daily.map((d) => d.date);
  assert.deepEqual(dates, [...dates].sort(), "chronological order");
  assert.equal(dates[dates.length - 1], "2026-01-08", "ends on the current UTC day");

  // every consecutive pair is exactly one day apart, including days with no usage
  for (let i = 1; i < dates.length; i++) {
    const gap = Date.parse(`${dates[i]}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`);
    assert.equal(gap, 86_400_000, `${dates[i - 1]} -> ${dates[i]}`);
  }

  assert.equal(
    stats.daily.reduce((s, d) => s + d.calls, 0),
    4,
    "only days with activity carry calls",
  );
  assert.equal(stats.daily.filter((d) => d.cost === 0).length, 10, "inactive days are zero-filled");
  assert.equal(stats.daily[0].cost, 0, "oldest day predates all activity");
  assert.equal(stats.daily[stats.daily.length - 1].calls, 1, "today carries the newest call");
});

test("a missing database produces a typed ENODB error", () => {
  assert.throws(
    () => buildStats({ dbPath: path.join(os.tmpdir(), "definitely-missing-opencode.db") }),
    (err) => err.code === "ENODB",
  );
});

test("an unknown plan is rejected instead of silently treated as Go", () => {
  assert.throws(() => buildStats({ plan: "enterprise" }), /unknown plan/);
});

test("defaultDbPath honours the TOKENCHECK_DB override", () => {
  const prev = process.env.TOKENCHECK_DB;
  process.env.TOKENCHECK_DB = "C:/tmp/custom.db";
  assert.equal(defaultDbPath(), "C:/tmp/custom.db");
  if (prev === undefined) delete process.env.TOKENCHECK_DB;
  else process.env.TOKENCHECK_DB = prev;
});
