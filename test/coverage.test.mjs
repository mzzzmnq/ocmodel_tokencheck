/**
 * Coverage report tests: the official catalogue is stubbed, the local database is
 * a fixture, so this runs offline and deterministically.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildCoverage } from "../src/coverage.mjs";
import { clearCatalogCache } from "../src/official.mjs";
import { MODELS } from "../src/pricing.mjs";

const MODELS_KEYS = Object.keys(MODELS);

test.beforeEach(() => clearCatalogCache());

function fixtureDb(modelIds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokencheck-cov-"));
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, model TEXT, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  db.prepare("INSERT INTO session_v2 (id, title) VALUES ('s1', 'fixture')").run();
  const ins = db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?,?,?,?,?,?)",
  );
  modelIds.forEach((id, i) => {
    ins.run(`msg_${i}`, "s1", "assistant", i, Date.UTC(2026, 0, 8), JSON.stringify({
      time: { created: Date.UTC(2026, 0, 8) },
      model: { id, providerID: "opencode-go" },
      tokens: { input: 1000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.01,
      finish: "stop",
    }));
  });
  db.close();
  return { file, dir };
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
    clearCatalogCache();
  };
}

test("coverage separates used, priced, advertised and unpriced models", async () => {
  const { file, dir } = fixtureDb(["deepseek-v4.1-flash", "omen-alpha", "glm-5.2"]);
  const restore = stubFetch(async (url) => {
    assert.match(String(url), /\/zen\/go\/v1\/models$/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        object: "list",
        data: [
          { id: "deepseek-v4.1-flash" },
          { id: "omen-alpha" },
          { id: "glm-5.2" },
          { id: "kimi-k3" },
          { id: "brand-new-model" },
        ],
      }),
    };
  });

  try {
    const c = await buildCoverage({ dbPath: file, plan: "go" });

    assert.equal(c.ok, true);
    assert.equal(c.catalog.ok, true);
    assert.equal(c.catalog.count, 5);
    assert.equal(c.summary.usedCount, 3);
    assert.equal(c.summary.advertisedCount, 5);
    assert.equal(c.summary.usedUnpricedCount, 1, "omen-alpha has no published price");
    assert.equal(c.summary.advertisedUnpricedCount, 2, "omen-alpha + brand-new-model");
    // the stub advertises 5 ids; all other prices (plus the two unpriced local ids)
    // are therefore not currently offered
    const advertised = ["deepseek-v4.1-flash", "omen-alpha", "glm-5.2", "kimi-k3", "brand-new-model"];
    const expectedRetired = MODELS_KEYS.filter((id) => !advertised.includes(id)).length;
    assert.equal(c.summary.notAdvertisedCount, expectedRetired);

    assert.equal(c.warnings.length, 1);
    assert.match(c.warnings[0], /omen-alpha/);
    assert.match(c.warnings[0], /费用不会计入估算/);

    // used rows first; within them, priced rows lead so the table opens with
    // fully-understood models and the unknowns follow immediately
    assert.deepEqual(
      c.rows.slice(0, 3).map((r) => r.id),
      ["deepseek-v4.1-flash", "glm-5.2", "omen-alpha"],
    );

    const unknown = c.rows.find((r) => r.id === "omen-alpha");
    assert.equal(unknown.used, true);
    assert.equal(unknown.priced, false);
    assert.equal(unknown.windowLimits, null, "no invented caps for unpriced models");

    const ds = c.rows.find((r) => r.id === "deepseek-v4.1-flash");
    assert.deepEqual(ds.windowLimits, { rolling: 12, weekly: 30, monthly: 60 });
    assert.equal(ds.peak, true);
    assert.equal(ds.used, true);

    const kimi = c.rows.find((r) => r.id === "kimi-k3");
    assert.equal(kimi.used, false);
    assert.equal(kimi.advertised, true);
    assert.deepEqual(kimi.windowLimits, { rolling: 3, weekly: 7.5, monthly: 15 });

    const novel = c.rows.find((r) => r.id === "brand-new-model");
    assert.equal(novel.priced, false);
    assert.equal(novel.advertised, true);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Go Plus doubles the caps reported in coverage", async () => {
  const { file, dir } = fixtureDb(["glm-5.2"]);
  const restore = stubFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: "glm-5.2" }] }),
  }));
  try {
    const c = await buildCoverage({ dbPath: file, plan: "plus" });
    const glm = c.rows.find((r) => r.id === "glm-5.2");
    assert.deepEqual(glm.windowLimits, { rolling: 24, weekly: 60, monthly: 120 });
    assert.equal(glm.monthlyLimit, 120);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a priced model missing from the live catalogue is flagged as retired", async () => {
  const { file, dir } = fixtureDb(["glm-5.2"]);
  // advertise everything this tool can price, except hy3
  const advertised = MODELS_KEYS.filter((id) => id !== "hy3");
  const restore = stubFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: advertised.map((id) => ({ id })) }),
  }));
  try {
    const c = await buildCoverage({ dbPath: file, plan: "go" });
    const hy3 = c.rows.find((r) => r.id === "hy3");
    assert.equal(hy3.priced, true);
    assert.equal(hy3.advertised, false);
    assert.equal(c.summary.notAdvertisedCount, 1, "only hy3 is missing upstream");
    const others = c.rows.filter((r) => r.priced && r.id !== "hy3");
    assert.ok(others.every((r) => r.advertised === true));
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreachable catalogue degrades without losing local information", async () => {
  const { file, dir } = fixtureDb(["omen-alpha"]);
  const restore = stubFetch(async () => {
    throw new Error("network offline");
  });
  try {
    const c = await buildCoverage({ dbPath: file, plan: "go" });
    assert.equal(c.ok, true);
    assert.equal(c.catalog.ok, false);
    assert.match(c.catalog.message, /network offline/);
    assert.equal(c.summary.advertisedCount, null);
    assert.equal(c.summary.usedUnpricedCount, 1);
    assert.match(c.warnings[0], /omen-alpha/);
    // advertised is unknown, not "false", so nothing is wrongly called retired
    assert.equal(c.summary.notAdvertisedCount, 0);
    assert.equal(c.rows.find((r) => r.id === "omen-alpha").advertised, null);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing local database still reports the price table", async () => {
  const restore = stubFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: "glm-5.2" }] }),
  }));
  try {
    const c = await buildCoverage({
      dbPath: path.join(os.tmpdir(), "definitely-missing-opencode.db"),
      plan: "go",
    });
    assert.equal(c.ok, true);
    assert.equal(c.summary.localError, "no-db");
    assert.equal(c.summary.usedCount, 0);
    assert.ok(c.pricedCount > 20, "the price table is independent of local data");
  } finally {
    restore();
  }
});
