/**
 * Coverage report: what the Go endpoint offers, what this tool can price, and
 * what this machine has actually used.
 *
 * The point is to make the two blind spots visible instead of silent:
 *   - a model the account uses that has no published price in the docs table
 *     (its spend is counted in tokens but never in dollars), and
 *   - a model the endpoint serves that this tool has no price for at all.
 */
import { MODELS, getModel, monthlyLimit, windowLimit } from "./pricing.mjs";
import { localModelIds } from "./stats.mjs";
import { fetchModelCatalog } from "./official.mjs";

const UNPRICED_LIMIT = 30;

/**
 * @param {{dbPath?: string, plan?: string, force?: boolean}} [opts]
 */
export async function buildCoverage(opts = {}) {
  const plan = opts.plan === "plus" ? "plus" : "go";

  let used = [];
  let localError = null;
  try {
    used = localModelIds({ dbPath: opts.dbPath });
  } catch (err) {
    localError = err.code === "ENODB" ? "no-db" : "error";
  }

  let catalog = null;
  try {
    catalog = await fetchModelCatalog({ force: opts.force });
  } catch {
    catalog = null;
  }

  const advertised = catalog?.ok ? catalog.ids : null;
  const usedSet = new Set(used);

  /** Every id we know about from either source. */
  const ids = new Set([...Object.keys(MODELS), ...used, ...(advertised ?? [])]);

  const rows = [...ids]
    .map((id) => {
      const meta = getModel(id);
      return {
        id,
        label: meta?.label ?? id,
        // "used" means this account has Go traffic for it in the local store
        used: usedSet.has(id),
        // "advertised" means the endpoint lists it right now
        advertised: advertised ? advertised.includes(id) : null,
        priced: Boolean(meta),
        unlimited: meta ? !Number.isFinite(meta.limit) : false,
        monthlyLimit: meta ? monthlyLimit(id, plan) : null,
        windowLimits: meta
          ? {
              rolling: windowLimit(id, plan, "rolling"),
              weekly: windowLimit(id, plan, "weekly"),
              monthly: windowLimit(id, plan, "monthly"),
            }
          : null,
        peak: Boolean(meta?.peakRate),
      };
    })
    .sort((a, b) => {
      if (a.used !== b.used) return a.used ? -1 : 1;
      if (a.priced !== b.priced) return a.priced ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

  const usedUnpriced = rows.filter((r) => r.used && !r.priced);
  const advertisedUnpriced = rows.filter((r) => r.priced === false && r.advertised);
  const notAdvertised = advertised ? rows.filter((r) => r.priced && !r.advertised) : [];

  return {
    ok: true,
    plan,
    catalog: catalog
      ? { ok: catalog.ok, endpoint: catalog.endpoint, fetchedAt: catalog.fetchedAt ?? null, count: advertised?.length ?? 0, message: catalog.message ?? null }
      : { ok: false, message: "模型目录不可用。" },
    pricedCount: rows.filter((r) => r.priced).length,
    summary: {
      usedCount: used.length,
      advertisedCount: advertised?.length ?? null,
      usedUnpricedCount: usedUnpriced.length,
      advertisedUnpricedCount: advertisedUnpriced.length,
      notAdvertisedCount: notAdvertised.length,
      localError,
    },
    // These are the ones that actually matter: used but unbillable locally.
    warnings: usedUnpriced.length
      ? [
          `本机使用了 ${usedUnpriced.length} 个未收录官方价格的模型：` +
            `${usedUnpriced.slice(0, UNPRICED_LIMIT).map((r) => r.id).join("、")}` +
            `。这些模型的 token 会被统计，但费用不会计入估算。`,
        ]
      : [],
    rows,
  };
}
