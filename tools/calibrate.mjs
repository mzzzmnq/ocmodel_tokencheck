/**
 * Calibration harness.
 *
 * opencode stores the cost it attributed to each assistant message. Recomputing
 * that cost from the token counts with src/pricing.mjs must reproduce it exactly;
 * otherwise the price table has drifted from what opencode actually bills.
 *
 * Also reports the peak/off-peak split so a DeepSeek window mistake is visible.
 *
 * Usage: node --experimental-sqlite tools/calibrate.mjs [--db <path>] [--show 5]
 */
import { readRecords } from "../src/stats.mjs";
import { costOf, getModel, isPeakHour } from "../src/pricing.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const dbPath = opt("db", undefined);
const show = Number(opt("show", 10));

/** DeepSeek billed at the off-peak schedule regardless of the request time. */
const OFFPEAK_PROBE = Date.UTC(2026, 0, 3, 20, 0, 0);

let records;
try {
  ({ records } = readRecords({ dbPath }));
} catch (err) {
  console.error(`无法读取 opencode 数据库：${err.message}`);
  console.error("用 --db <path> 指定路径，或设置 TOKENCHECK_DB。");
  process.exit(2);
}

const perModel = new Map();
let exact = 0;
let peakOnly = 0;
let unexplained = 0;
let unpriced = 0;
let recordedTotal = 0;
let computedTotal = 0;
const offenders = [];

for (const r of records.filter((x) => x.isGo)) {
  const meta = getModel(r.modelId);
  if (!meta) {
    unpriced++;
    continue;
  }
  const got = costOf(r.modelId, r.tokens, { at: r.at });
  const rec = r.recordedCost;
  recordedTotal += rec;
  computedTotal += got.cost;

  const stats = perModel.get(r.modelId) ?? {
    modelId: r.modelId,
    label: meta.label,
    calls: 0,
    recorded: 0,
    computed: 0,
    exact: 0,
    peakOnly: 0,
    unexplained: 0,
    peak: 0,
    offPeak: 0,
  };
  stats.calls++;
  stats.recorded += rec;
  stats.computed += got.cost;

  const isExact = Math.abs(got.cost - rec) < 1e-9;
  // Recorded cost equals the off-peak computation: opencode's own price map is
  // flat for models we price with a peak multiplier.
  const flat = costOf(r.modelId, r.tokens, { at: OFFPEAK_PROBE });
  const isFlatEquivalent =
    meta.peakRate && Math.abs(flat.cost - rec) < 1e-9 && Math.abs(got.cost - rec) > 1e-9;

  if (isExact) {
    stats.exact++;
    exact++;
  } else if (isFlatEquivalent) {
    stats.peakOnly++;
    peakOnly++;
  } else {
    stats.unexplained++;
    unexplained++;
    if (offenders.length < show) {
      offenders.push({
        id: r.id,
        modelId: r.modelId,
        at: new Date(r.at).toISOString(),
        tokens: r.tokens,
        recorded: rec,
        computed: got.cost,
        offPeakComputed: flat.cost,
        tier: got.tier,
        isPeakHour: isPeakHour(r.at),
      });
    }
  }
  if (isPeakHour(r.at)) stats.peak++;
  else stats.offPeak++;
  perModel.set(r.modelId, stats);
}

const fmt = (n) => `$${n.toFixed(6)}`;
console.log("按模型：");
for (const s of [...perModel.values()].sort((a, b) => b.recorded - a.recorded)) {
  console.log(
    `  ${s.label.padEnd(26)} 调用 ${String(s.calls).padStart(4)}  记录 ${fmt(s.recorded).padStart(12)}  ` +
      `复算 ${fmt(s.computed).padStart(12)}  完全一致 ${s.exact}/${s.calls}` +
      `  仅峰谷差异 ${s.peakOnly}  无法解释 ${s.unexplained}  峰/谷 ${s.peak}/${s.offPeak}`,
  );
}
console.log(
  `\n合计：记录 ${fmt(recordedTotal)}（opencode 自身口径）  复算 ${fmt(computedTotal)}（官方峰谷口径）\n` +
    `      完全一致 ${exact} 条 · 仅因峰谷加价不同 ${peakOnly} 条 · 无法解释 ${unexplained} 条 · 未收录价格 ${unpriced} 条`,
);

if (peakOnly > 0) {
  console.log(
    "\n说明：opencode 记录 cost 时对 DeepSeek 模型只使用平价单价，未按时段加价；" +
      "tokencheck 按官方峰谷表计算，因此高峰时段的估算会高于 opencode 的记录值。",
  );
}

if (offenders.length) {
  console.log("\n无法解释的偏差样例：");
  for (const o of offenders) console.log(" ", JSON.stringify(o));
}

const ok = unexplained === 0;
console.log(
  ok
    ? "\n结果：本地价格表与 opencode 记录一致（差异均可由峰谷口径解释）。"
    : "\n结果：存在无法解释的偏差，请核对 src/pricing.mjs 的费率表。",
);
process.exit(ok ? 0 : 1);

