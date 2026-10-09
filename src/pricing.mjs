/**
 * OpenCode Go pricing & allowance table.
 *
 * Source: https://opencode.ai/docs/go/  (usage limits section)
 * Prices are USD per 1,000,000 tokens.
 *
 * Notes
 *  - `limit` is the model's *monthly* dollar allowance for the Go plan.
 *    Go Plus limits are derived as `limit * plusMultiplier` (the docs publish
 *    Go Plus as "higher usage limits" scaling each model's allowance).
 *  - `null` for `cacheWrite` means the model does not bill a separate cache
 *    write price (the docs show "-"), not that writes are free of context.
 *  - Models priced by context size carry a `tiers` array; the applicable tier
 *    is the last one whose `maxInputTokens` is >= the request's context.
 *    `null` maxInputTokens means "no upper bound".
 *  - `peak` multipliers model DeepSeek's peak / off-peak pricing.
 */

/** Fallback Go Plus multiplier, used only for models missing a documented figure. */
export const PLUS_MULTIPLIER = 2;

/** DeepSeek peak windows: 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri. */
export const PEAK_WINDOWS = [
  { startHour: 1, endHour: 4 },
  { startHour: 6, endHour: 10 },
];

/** @typedef {{input:number,output:number,cacheRead:number,cacheWrite:number|null,limit:number,maxInputTokens:number|null,tier?:string}} Rate */

/** @type {Record<string, {label:string, provider:string, limit:number, tiers:Rate[], peak?:{peak:number,offPeak:number}}>} */
export const MODELS = {
  "glm-5.3-flash": { label: "GLM-5.3-Flash", limit: 60, tiers: [rate(0.15, 0.5, 0.03, null)] },
  "glm-5.3": { label: "GLM-5.3", limit: 15, tiers: [rate(1.4, 4.4, 0.26, null)] },
  "glm-5.2": { label: "GLM-5.2", limit: 60, tiers: [rate(1.4, 4.4, 0.26, null)] },
  "kimi-k3": { label: "Kimi K3", limit: 15, tiers: [rate(3.0, 15.0, 0.3, null)] },
  "kimi-k2.7-code": { label: "Kimi K2.7 Code", limit: 60, tiers: [rate(0.95, 4.0, 0.19, null)] },
  "kimi-k2.6": { label: "Kimi K2.6", limit: 60, tiers: [rate(0.95, 4.0, 0.16, null)] },
  "longcat-2.0": { label: "LongCat-2.0", limit: 60, tiers: [rate(0.3, 1.2, 0.006, null)] },
  "longcat-2.5-preview-free": {
    label: "LongCat 2.5 Preview Free",
    limit: Infinity,
    tiers: [rate(0, 0, 0, null)],
    unlimited: true,
  },
  "step-5-preview-free": {
    label: "Step 5 Preview Free",
    limit: Infinity,
    tiers: [rate(0, 0, 0, null)],
    unlimited: true,
  },
  "mimo-v2.6-flash": { label: "MiMo-V2.6-Flash", limit: 60, tiers: [rate(0.14, 0.28, 0.0028, null)] },
  "mimo-v2.6-pro": { label: "MiMo-V2.6-Pro", limit: 15, tiers: [rate(0.435, 0.87, 0.003625, null)] },
  "mimo-v2.5": { label: "MiMo-V2.5", limit: 60, tiers: [rate(0.14, 0.28, 0.0028, null)] },
  "mimo-v2.5-pro": { label: "MiMo-V2.5-Pro", limit: 15, tiers: [rate(0.435, 0.87, 0.003625, null)] },
  "minimax-m3": { label: "MiniMax M3", limit: 60, tiers: [rate(0.3, 1.2, 0.06, null)] },
  "minimax-m2.7": { label: "MiniMax M2.7", limit: 60, tiers: [rate(0.3, 1.2, 0.06, 0.375)] },
  "muse-spark-1.3-contributor": {
    label: "Muse Spark 1.3 Contributor",
    limit: 60,
    tiers: [rate(0.1, 0.2, 0.002, null)],
  },
  "muse-spark-1.2-contributor": {
    label: "Muse Spark 1.2 Contributor",
    limit: 60,
    tiers: [rate(0.1, 0.2, 0.002, null)],
  },
  "qwen3.8-max": { label: "Qwen3.8 Max", limit: 15, tiers: [rate(2.0, 6.0, 0.25, 2.5)] },
  "qwen3.8-flash": { label: "Qwen3.8 Flash", limit: 30, tiers: [rate(0.15, 0.47, 0.016, 0.2)] },
  "qwen3.7-plus": {
    label: "Qwen3.7 Plus",
    limit: 60,
    tiers: [
      rate(0.4, 1.6, 0.04, 0.5, 262144, "≤ 256K tokens"),
      rate(1.2, 4.8, 0.12, 1.5, null, "> 256K tokens"),
    ],
  },
  "deepseek-v4.1-flash": {
    label: "DeepSeek V4.1 Flash",
    limit: 60,
    peak: { peak: 2, offPeak: 1 },
    tiers: [rate(0.15, 0.6, 0.003, null, null, "Off-Peak")],
    peakRate: rate(0.3, 1.2, 0.006, null, null, "Peak"),
  },
  "deepseek-v4-pro": {
    label: "DeepSeek V4 Pro",
    limit: 15,
    peak: { peak: 2, offPeak: 1 },
    tiers: [rate(0.66, 1.98, 0.022, null, null, "Off-Peak")],
    peakRate: rate(1.32, 3.96, 0.044, null, null, "Peak"),
  },
  "deepseek-v4-flash": {
    label: "DeepSeek V4 Flash",
    limit: 30,
    peak: { peak: 2, offPeak: 1 },
    tiers: [rate(0.15, 0.6, 0.003, null, null, "Off-Peak")],
    peakRate: rate(0.3, 1.2, 0.006, null, null, "Peak"),
  },
  "deepseek-v4-flash-vision-exp": {
    label: "DeepSeek V4 Flash Vision Exp",
    limit: 15,
    peak: { peak: 2, offPeak: 1 },
    tiers: [rate(0.15, 0.6, 0.003, null, null, "Off-Peak")],
    peakRate: rate(0.3, 1.2, 0.006, null, null, "Peak"),
  },
  "hy4-preview": { label: "Hy4 preview", limit: 30, tiers: [rate(0.834, 2.501, 0.042, null)] },
  hy3: { label: "Hy3", limit: 60, tiers: [rate(0.14, 0.58, 0.035, null)] },
  "space-bunny": { label: "Space Bunny", limit: 30, tiers: [rate(0.15, 0.6, 0.03, null)] },
  "grok-4.7": {
    label: "Grok 4.7",
    limit: 15,
    tiers: [
      rate(2.0, 6.0, 0.5, null, 200000, "≤ 200K tokens"),
      rate(4.0, 12.0, 1.0, null, null, "> 200K tokens"),
    ],
  },
  "grok-4.6": {
    label: "Grok 4.6",
    limit: 15,
    tiers: [
      rate(2.0, 6.0, 0.5, null, 200000, "≤ 200K tokens"),
      rate(4.0, 12.0, 1.0, null, null, "> 200K tokens"),
    ],
  },
  "gpt-6-luna": {
    label: "GPT 6 Luna",
    limit: 15,
    tiers: [
      rate(0.1, 0.5, 0.01, 0.125, 272000, "≤ 272K tokens"),
      rate(0.2, 0.75, 0.02, 0.25, null, "> 272K tokens"),
    ],
  },
  "gpt-5.6-luna": {
    label: "GPT 5.6 Luna",
    limit: 15,
    tiers: [
      rate(0.2, 1.2, 0.02, 0.25, 272000, "≤ 272K tokens"),
      rate(0.4, 1.8, 0.04, 0.5, null, "> 272K tokens"),
    ],
  },
  "claude-haiku-5-5": {
    label: "Claude Haiku 5.5",
    limit: 15,
    tiers: [
      rate(0.1, 0.5, 0.01, 0.125, 100000, "≤ 100K tokens"),
      rate(0.5, 2.5, 0.05, 0.625, null, "> 100K tokens"),
    ],
  },
};

function rate(input, output, cacheRead, cacheWrite, maxInputTokens = null, tier) {
  return { input, output, cacheRead, cacheWrite, maxInputTokens, tier };
}

/**
 * Documented Go Plus monthly allowances (USD), from the Go Plus tab of
 * https://opencode.ai/docs/go/. Go Plus is NOT a uniform multiple of Go — the
 * published figures range from 2x to 8x depending on the model.
 */
export const PLUS_LIMITS = {
  "glm-5.3-flash": 180,
  "glm-5.3": 120,
  "glm-5.2": 180,
  "kimi-k3": 60,
  "kimi-k2.7-code": 180,
  "kimi-k2.6": 240,
  "longcat-2.0": 240,
  "mimo-v2.6-flash": 120,
  "mimo-v2.6-pro": 60,
  "mimo-v2.5": 120,
  "mimo-v2.5-pro": 60,
  "minimax-m3": 180,
  "minimax-m2.7": 240,
  "muse-spark-1.3-contributor": 120,
  "muse-spark-1.2-contributor": 120,
  "qwen3.8-max": 60,
  "qwen3.8-flash": 90,
  "qwen3.7-plus": 180,
  "deepseek-v4.1-flash": 120,
  "deepseek-v4-pro": 60,
  "deepseek-v4-flash": 120,
  "deepseek-v4-flash-vision-exp": 60,
  "hy4-preview": 120,
  hy3: 240,
  "space-bunny": 120,
  "grok-4.7": 60,
  "grok-4.6": 60,
  "gpt-6-luna": 60,
  "gpt-5.6-luna": 60,
  "claude-haiku-5-5": 60,
};

/**
 * Model ids that the Go endpoint serves but that the docs' Go plan price table
 * does not cover, so they cannot be billed locally.
 *
 * This is reference data only — coverage.mjs derives the same set at runtime by
 * diffing the live `/v1/models` list against MODELS, which is what the dashboard
 * actually shows. It is kept here so a reader can see the gap without network
 * access, and `npm run smoke` asserts the live list still agrees with it.
 */
export const KNOWN_UNPRICED = [
  "minimax-m2.5",
  "kimi-k2.5",
  "glm-5.1",
  "glm-5",
  "deepseek-flash",
  "qwen3.7-max",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "hy3-preview",
  "grok-4.5",
  "omen-alpha",
];

export function getModel(modelId) {
  return MODELS[modelId] || null;
}

export function isPeakHour(date) {
  const d = date instanceof Date ? date : new Date(date);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = d.getUTCHours();
  return PEAK_WINDOWS.some((w) => hour >= w.startHour && hour < w.endHour);
}

/** Pick the pricing tier for a request given its context size. */
export function pickTier(modelId, contextTokens) {
  const model = MODELS[modelId];
  if (!model) return null;
  const ctx = Number.isFinite(contextTokens) ? contextTokens : 0;
  for (const t of model.tiers) {
    if (t.maxInputTokens === null || ctx <= t.maxInputTokens) return t;
  }
  return model.tiers[model.tiers.length - 1];
}

/** Monthly allowance in USD for a model, or Infinity when unlimited. */
export function monthlyLimit(modelId, plan = "go") {
  const model = MODELS[modelId];
  if (!model) return null;
  if (!Number.isFinite(model.limit)) return Infinity;
  if (plan === "plus") {
    const documented = PLUS_LIMITS[modelId];
    return Number.isFinite(documented) ? documented : model.limit * PLUS_MULTIPLIER;
  }
  return model.limit;
}

/**
 * Cost in USD of one usage record.
 *
 * @param {string} modelId
 * @param {{input?:number,output?:number,reasoning?:number,cacheRead?:number,cacheWrite?:number}} tokens
 * @param {{at?: number|Date, plan?: string}} [opts]
 */
export function costOf(modelId, tokens, opts = {}) {
  const model = MODELS[modelId];
  if (!model) return null;

  const input = num(tokens.input);
  const output = num(tokens.output) + num(tokens.reasoning);
  const cacheRead = num(tokens.cacheRead);
  const cacheWrite = num(tokens.cacheWrite);

  let tier = pickTier(modelId, input + cacheRead);
  if (model.peakRate && isPeakHour(opts.at ?? new Date())) tier = model.peakRate;
  if (!tier) return null;

  const per = 1e6;
  let cost =
    (input / per) * tier.input +
    (output / per) * tier.output +
    (cacheRead / per) * tier.cacheRead;
  if (tier.cacheWrite != null) cost += (cacheWrite / per) * tier.cacheWrite;

  return { cost, tier: tier.tier ?? null, rate: tier };
}

function num(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Billing windows, mirroring the Go plan: 5-hour rolling, weekly, monthly.
 *
 * The docs define the allowance *per model* as fractions of that model's own
 * monthly limit: "5-hour — 20% of the monthly limit; weekly — 50%; and
 * monthly — 100%". A model can therefore be throttled by any one of the three,
 * which is what makes the tightest-window view meaningful.
 */
export const WINDOW_RULES = {
  rolling: { share: 0.2, label: "5 小时滚动", short: "5 小时", resets: "rolling" },
  weekly: { share: 0.5, label: "本周", short: "本周", resets: "week" },
  monthly: { share: 1, label: "本月", short: "本月", resets: "month" },
  all: { share: null, label: "全部", short: "全部", resets: null },
};

/** Dollar allowance for one billing window of a model, or Infinity. */
export function windowLimit(modelId, plan, window) {
  const monthly = monthlyLimit(modelId, plan);
  if (monthly === null) return null;
  if (!Number.isFinite(monthly)) return Infinity;
  const rule = WINDOW_RULES[window];
  if (!rule || rule.share === null) return Infinity;
  return monthly * rule.share;
}

export function windowStarts(now = Date.now(), overrides = null) {
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const day = d.getUTCDay();
  const sinceMonday = (day + 6) % 7;
  const weekStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
  const base = {
    rolling: now - 5 * 3600_000,
    weekly: weekStart,
    monthly: monthStart,
    rollingResetsAt: null,
    weeklyResetsAt: weekStart + 7 * 86_400_000,
    monthlyResetsAt: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
  if (!overrides) return base;
  // The official usage API publishes each window's own `resetsAt`. Prefer those
  // so the local windows line up with the account's windows instead of assuming
  // calendar boundaries — the Go monthly window is NOT the calendar month.
  for (const w of ["rolling", "weekly", "monthly"]) {
    if (Number.isFinite(overrides[w])) base[w] = overrides[w];
    if (Number.isFinite(overrides[`${w}ResetsAt`])) base[`${w}ResetsAt`] = overrides[`${w}ResetsAt`];
  }
  return base;
}

/**
 * Derive window starts from the official resetsAt values, so the local per-model
 * figures are measured over the same windows the account is billed on.
 *
 * @param {{ok?:boolean, usage?:Record<string,{resetsAt?:string}>}} official
 */
export function windowOverridesFromOfficial(official) {
  if (!official?.ok) return null;
  const parse = (iso) => {
    const t = Date.parse(iso ?? "");
    return Number.isFinite(t) ? t : null;
  };
  const out = {};
  const rolling = parse(official.usage?.rolling?.resetsAt);
  const weekly = parse(official.usage?.weekly?.resetsAt);
  const monthly = parse(official.usage?.monthly?.resetsAt);
  if (rolling !== null) {
    out.rolling = rolling - 5 * 3600_000;
    out.rollingResetsAt = rolling;
  }
  if (weekly !== null) {
    out.weekly = weekly - 7 * 86_400_000;
    out.weeklyResetsAt = weekly;
  }
  if (monthly !== null) {
    const m = new Date(monthly);
    m.setUTCMonth(m.getUTCMonth() - 1);
    out.monthly = m.getTime();
    out.monthlyResetsAt = monthly;
  }
  return Object.keys(out).length ? out : null;
}
