import test from "node:test";
import assert from "node:assert/strict";
import {
  costOf,
  isPeakHour,
  monthlyLimit,
  pickTier,
  windowLimit,
  windowStarts,
  windowOverridesFromOfficial,
  WINDOW_RULES,
  MODELS,
} from "../src/pricing.mjs";

const at = (iso) => new Date(iso);

test("deepseek-v4.1-flash uses off-peak rates outside DeepSeek peak windows", () => {
  // 2026-01-05 is a Monday. 20:00 UTC is off-peak.
  const off = costOf("deepseek-v4.1-flash", { input: 1e6, output: 1e6, cacheRead: 1e6 }, { at: at("2026-01-05T20:00:00Z") });
  assert.equal(off.tier, "Off-Peak");
  assert.equal(off.cost, 0.15 + 0.6 + 0.003);

  const peak = costOf("deepseek-v4.1-flash", { input: 1e6, output: 1e6, cacheRead: 1e6 }, { at: at("2026-01-05T02:00:00Z") });
  assert.equal(peak.tier, "Peak");
  assert.equal(peak.cost, 0.3 + 1.2 + 0.006);
});

test("DeepSeek peak windows are 01-04 and 06-10 UTC on weekdays only", () => {
  assert.equal(isPeakHour(at("2026-01-05T00:59:00Z")), false);
  assert.equal(isPeakHour(at("2026-01-05T01:00:00Z")), true);
  assert.equal(isPeakHour(at("2026-01-05T03:59:00Z")), true);
  assert.equal(isPeakHour(at("2026-01-05T04:00:00Z")), false);
  assert.equal(isPeakHour(at("2026-01-05T05:59:00Z")), false);
  assert.equal(isPeakHour(at("2026-01-05T06:00:00Z")), true);
  assert.equal(isPeakHour(at("2026-01-05T09:59:00Z")), true);
  assert.equal(isPeakHour(at("2026-01-05T10:00:00Z")), false);
  // Saturday 2026-01-10 and Sunday 2026-01-11 inside the same hours are off-peak.
  assert.equal(isPeakHour(at("2026-01-10T02:00:00Z")), false);
  assert.equal(isPeakHour(at("2026-01-11T07:00:00Z")), false);
});

test("reasoning tokens are billed as output tokens", () => {
  const withReasoning = costOf("deepseek-v4.1-flash", { input: 0, output: 500, reasoning: 500 }, { at: at("2026-01-05T20:00:00Z") });
  const plain = costOf("deepseek-v4.1-flash", { input: 0, output: 1000 }, { at: at("2026-01-05T20:00:00Z") });
  assert.equal(withReasoning.cost, plain.cost);
  assert.ok(Math.abs(withReasoning.cost - 0.0006) < 1e-12);
});

test("context-size tiers pick the right rate", () => {
  // Grok 4.7 is $2/1M up to 200K tokens of context and $4/1M above that.
  assert.equal(pickTier("grok-4.7", 100_000).input, 2.0);
  assert.equal(pickTier("grok-4.7", 200_000).input, 2.0);
  assert.equal(pickTier("grok-4.7", 200_001).input, 4.0);

  // A request over the threshold bills the whole request at the higher rate.
  const small = costOf("grok-4.7", { input: 200_000 }, { at: at("2026-01-05T20:00:00Z") });
  const big = costOf("grok-4.7", { input: 300_000 }, { at: at("2026-01-05T20:00:00Z") });
  assert.equal(small.cost, 0.4);
  assert.equal(big.cost, 1.2);
  assert.equal(small.rate.input, 2.0);
  assert.equal(big.rate.input, 4.0);

  assert.equal(pickTier("qwen3.7-plus", 262_144).input, 0.4);
  assert.equal(pickTier("qwen3.7-plus", 300_000).input, 1.2);
});

test("cache write is billed only for models that publish a write price", () => {
  const cached = costOf("minimax-m2.7", { input: 0, cacheWrite: 1e6 }, { at: at("2026-01-05T20:00:00Z") });
  assert.ok(Math.abs(cached.cost - 0.375) < 1e-12);

  const noWritePrice = costOf("glm-5.2", { input: 0, cacheWrite: 1e6 }, { at: at("2026-01-05T20:00:00Z") });
  assert.equal(noWritePrice.cost, 0);
});

test("monthly limits follow the documented per-model allowances and Go Plus scaling", () => {
  assert.equal(monthlyLimit("kimi-k3", "go"), 15);
  assert.equal(monthlyLimit("glm-5.2", "go"), 60);
  assert.equal(monthlyLimit("qwen3.8-flash", "go"), 30);
  assert.equal(monthlyLimit("kimi-k3", "plus"), 60);
  assert.equal(monthlyLimit("glm-5.2", "plus"), 180);
  assert.equal(monthlyLimit("deepseek-v4.1-flash", "plus"), 120);
  assert.equal(monthlyLimit("longcat-2.5-preview-free", "go"), Infinity);
  assert.equal(monthlyLimit("step-5-preview-free", "go"), Infinity);
  assert.equal(monthlyLimit("not-a-model", "go"), null);
});

test("each window gets 20% / 50% / 100% of the model's monthly allowance", () => {
  assert.equal(WINDOW_RULES.rolling.share, 0.2);
  assert.equal(WINDOW_RULES.weekly.share, 0.5);
  assert.equal(WINDOW_RULES.monthly.share, 1);

  // GLM-5.2 has a $60 monthly allowance -> $12 / $30 / $60 windows
  assert.equal(windowLimit("glm-5.2", "go", "rolling"), 12);
  assert.equal(windowLimit("glm-5.2", "go", "weekly"), 30);
  assert.equal(windowLimit("glm-5.2", "go", "monthly"), 60);
  assert.equal(windowLimit("glm-5.2", "go", "all"), Infinity);

  // Go Plus uses the documented per-model allowance (Kimi K3: $60, not 2x Go)
  assert.equal(windowLimit("kimi-k3", "plus", "rolling"), 12);
  assert.equal(windowLimit("kimi-k3", "plus", "weekly"), 30);
  assert.equal(windowLimit("kimi-k3", "plus", "monthly"), 60);

  // unlimited models have no window caps; unknown models have no data at all
  assert.equal(windowLimit("longcat-2.5-preview-free", "go", "monthly"), Infinity);
  assert.equal(windowLimit("not-a-model", "go", "monthly"), null);
});

test("window limits are always ordered rolling <= weekly <= monthly", () => {
  for (const plan of ["go", "plus"]) {
    for (const id of Object.keys(MODELS)) {
      const r = windowLimit(id, plan, "rolling");
      const w = windowLimit(id, plan, "weekly");
      const m = windowLimit(id, plan, "monthly");
      if (!Number.isFinite(r)) continue;
      assert.ok(r <= w && w <= m, `${id}/${plan}: ${r} ${w} ${m}`);
    }
  }
});

test("the free preview model costs nothing", () => {
  const r = costOf("longcat-2.5-preview-free", { input: 5e6, output: 5e6 }, { at: at("2026-01-05T20:00:00Z") });
  assert.equal(r.cost, 0);
});

test("unknown models are reported as unpriced rather than guessed", () => {
  assert.equal(costOf("omen-alpha", { input: 1e6 }), null);
});

test("window starts align with the documented reset semantics", () => {
  // Thursday 2026-01-08 12:00 UTC
  const now = Date.UTC(2026, 0, 8, 12, 0, 0);
  const w = windowStarts(now);
  assert.equal(w.rolling, now - 5 * 3600_000);
  assert.equal(w.weekly, Date.UTC(2026, 0, 5, 0, 0, 0)); // Monday
  assert.equal(w.weeklyResetsAt, Date.UTC(2026, 0, 12, 0, 0, 0));
  assert.equal(w.monthly, Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.equal(w.monthlyResetsAt, Date.UTC(2026, 1, 1, 0, 0, 0));
});

test("every documented model carries a positive or unlimited allowance", () => {
  for (const [id, m] of Object.entries(MODELS)) {
    assert.ok(m.tiers.length > 0, `${id} has tiers`);
    const limit = monthlyLimit(id, "go");
    assert.ok(limit > 0, `${id} limit ${limit}`);
  }
});

test("official resetsAt overrides the calendar window boundaries", () => {
  const official = {
    ok: true,
    usage: {
      rolling: { resetsAt: "2026-10-08T11:26:05.000Z" },
      weekly: { resetsAt: "2026-10-12T00:00:00.000Z" },
      monthly: { resetsAt: "2026-10-23T01:14:47.000Z" },
    },
  };
  const ov = windowOverridesFromOfficial(official);
  assert.equal(ov.rolling, Date.parse("2026-10-08T06:26:05.000Z"));
  assert.equal(ov.rollingResetsAt, Date.parse("2026-10-08T11:26:05.000Z"));
  assert.equal(ov.weekly, Date.parse("2026-10-05T00:00:00.000Z"));
  // the Go monthly window is NOT the calendar month: it starts a month before its reset
  assert.equal(ov.monthly, Date.parse("2026-09-23T01:14:47.000Z"));
  assert.equal(ov.monthlyResetsAt, Date.parse("2026-10-23T01:14:47.000Z"));

  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const s = windowStarts(now, ov);
  assert.equal(s.monthly, Date.parse("2026-09-23T01:14:47.000Z"));
  assert.equal(s.monthlyResetsAt, Date.parse("2026-10-23T01:14:47.000Z"));

  // without overrides, the calendar defaults still apply
  const base = windowStarts(now);
  assert.equal(base.monthly, Date.UTC(2026, 9, 1));
  assert.equal(base.monthlyResetsAt, Date.UTC(2026, 10, 1));
  assert.equal(base.rollingResetsAt, null);

  assert.equal(windowOverridesFromOfficial({ ok: false }), null);
  assert.equal(windowOverridesFromOfficial({ ok: true, usage: {} }), null);
});
