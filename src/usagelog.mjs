/**
 * External usage logs.
 *
 * Some clients call the OpenCode Go API directly, so their spend never reaches
 * opencode's database and the per-model dashboard cannot see it. This module
 * reads an append-only JSONL log such clients can write, and turns each line
 * into a record shaped exactly like the ones stats.mjs reads from opencode —
 * priced with the same table, so tiers and DeepSeek peak/off-peak apply
 * identically. The price table stays the single source of truth: producers only
 * log raw token counts, never a price.
 *
 * One JSON object per line:
 *
 *   {"at": <ms|ISO>, "model": "deepseek-v4.1-flash",
 *    "tokens": {"input":N,"output":N,"reasoning":N,"cacheRead":N,"cacheWrite":N},
 *    "sessionId": "openleet-chat", "client": "openleet",
 *    "title": "optional", "cost": <optional recorded cost>, "error": false}
 *
 * `at`/`time`, `input`/`output`/`reasoning`/`cacheRead`/`cacheWrite` may also be
 * given at the top level for convenience.
 *
 * Sources are opt-in via `TOKENCHECK_USAGE_LOGS`: one or more paths separated by
 * `;` (a file or a directory of `*.jsonl`). When the variable is unset there is
 * no external source, so a plain opencode setup is unaffected.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { costOf, getModel, isPeakHour } from "./pricing.mjs";

/** Resolve the configured log sources. Opt-in: empty unless the env var is set. */
export function usageLogSources() {
  const env = process.env.TOKENCHECK_USAGE_LOGS;
  if (!env || !env.trim()) return [];
  return env
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function expandFiles(source) {
  const resolved =
    source === "~" || source.startsWith("~/") || source.startsWith("~\\")
      ? path.join(os.homedir(), source.slice(1))
      : source;
  try {
    const st = fs.statSync(resolved);
    if (st.isDirectory()) {
      return fs
        .readdirSync(resolved)
        .filter((f) => f.toLowerCase().endsWith(".jsonl"))
        .sort()
        .map((f) => path.join(resolved, f));
    }
    return [resolved];
  } catch {
    return [];
  }
}

function num(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function parseTime(v) {
  if (Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

/**
 * Read every external usage line from `sources` (defaults to the configured
 * sources) and return records in the same shape as stats.mjs produces.
 *
 * @param {string[]} [sources]
 */
export function readUsageLog(sources = usageLogSources()) {
  const records = [];
  for (const source of sources) {
    for (const file of expandFiles(source)) {
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      let lineNo = 0;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lineNo++;
        let o;
        try {
          o = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const modelId = o.model ?? o.modelId;
        if (typeof modelId !== "string" || !modelId) continue;

        const at = parseTime(o.at ?? o.time);
        const tk = o.tokens ?? {};
        const tokens = {
          input: num(tk.input ?? o.input),
          output: num(tk.output ?? o.output),
          reasoning: num(tk.reasoning ?? o.reasoning),
          cacheRead: num(tk.cacheRead ?? tk.cache?.read ?? o.cacheRead),
          cacheWrite: num(tk.cacheWrite ?? tk.cache?.write ?? o.cacheWrite),
        };
        const priced = costOf(modelId, tokens, { at });
        const client = typeof o.client === "string" && o.client ? o.client : "external";
        records.push({
          id: typeof o.id === "string" ? o.id : `${path.basename(file)}#${lineNo}`,
          sessionId:
            typeof o.sessionId === "string" && o.sessionId ? o.sessionId : `${client}:${modelId}`,
          title: typeof o.title === "string" ? o.title : null,
          at,
          modelId,
          providerId: `external:${client}`,
          isGo: true,
          tokens,
          peak: getModel(modelId)?.peakRate ? isPeakHour(at) : null,
          tier: priced?.tier ?? null,
          cost: priced?.cost ?? 0,
          recordedCost: Number.isFinite(o.cost) ? o.cost : (priced?.cost ?? 0),
          error: Boolean(o.error),
          client,
        });
      }
    }
  }
  return records;
}
