/**
 * Renders public/app.js against a minimal fake DOM and a stubbed fetch, to prove
 * the dashboard actually populates its rings, tables, totals and chart from the
 * shape the server returns.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appSource = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

const ELEMENT_IDS = [
  "healthDot", "planPill", "planSelect", "refreshBtn", "keyBtn", "updatedAt",
  "officialSource", "rings", "officialNotice", "keyCard", "keySource", "configPath",
  "keyInput", "keySave", "keyClear", "windowSeg", "modelsHint", "modelsTable",
  "dailyChart", "totals", "totalsScope", "callsTable", "toast", "footInfo",
];

class El {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this._html = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this._classes = new Set();
    this.classList = {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      contains: (c) => this._classes.has(c),
      toggle: (c, on) =>
        on === undefined
          ? this._classes.has(c)
            ? this._classes.delete(c)
            : this._classes.add(c)
          : on
            ? this._classes.add(c)
            : this._classes.delete(c),
    };
  }
  get className() {
    return [...this._classes].join(" ");
  }
  set className(v) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  addEventListener() {}
  focus() {}
  closest(sel) {
    return this._closest === sel ? this : null;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return this._all ?? [];
  }
}

function makeDom() {
  const els = new Map(ELEMENT_IDS.map((id) => [id, new El("div", id)]));
  const tbody = (parent) => {
    const b = new El("tbody");
    parent.appendChild(b);
    return b;
  };
  tbody(els.get("modelsTable"));
  tbody(els.get("callsTable"));

  const segButtons = ["rolling", "weekly", "monthly", "all"].map((w) => {
    const b = new El("button");
    b.dataset.win = w;
    if (w === "rolling") b.classList.add("active");
    b._closest = "#windowSeg button";
    return b;
  });
  const seg = els.get("windowSeg");
  seg._all = segButtons;

  const handlers = {};
  const document = {
    querySelector(sel) {
      const m = /^#([A-Za-z0-9_-]+)$/.exec(sel);
      if (m) return els.get(m[1]) ?? null;
      if (sel.includes(" ")) {
        const [head, tail] = sel.split(/\s+/);
        const parent = document.querySelector(head);
        return (
          (parent?.children ?? []).find((k) => k.tagName === tail.toUpperCase()) ?? null
        );
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "#windowSeg button") return segButtons;
      if (sel === "[data-reset]") {
        return els
          .get("rings")
          .children.map((c) => (c._inner ?? (c._inner = new El("span"))));
      }
      if (sel === "#modelsTable tbody" || sel === "#callsTable tbody") {
        const table = els.get(sel.split(" ")[0].slice(1));
        return table.children.filter((c) => c.tagName === "TBODY");
      }
      return [];
    },
    createElement: (tag) => new El(tag),
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    },
  };
  return { document, els, segButtons, handlers };
}

function usagePayload() {
  const zero = (o = {}) => ({
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
    cost: 0, costRaw: 0, calls: 0, errors: 0, peakCalls: 0, offPeakCalls: 0, ...o,
  });
  return {
    version: "1.0.0",
    now: Date.UTC(2026, 0, 8, 12, 0, 0),
    plan: "go",
    official: {
      ok: true,
      fetchedAt: Date.UTC(2026, 0, 8, 12, 0, 0),
      endpoint: "https://opencode.ai/zen/go/v1/usage",
      keySource: "opencode.db:opencode-go",
      keyMasked: "oc_sk_35…l-wC",
      usage: {
        rolling: { status: "ok", percent: 0, resetsAt: "2026-01-08T16:00:00.000Z", rateLimited: false },
        weekly: { status: "ok", percent: 3, resetsAt: "2026-01-12T00:00:00.000Z", rateLimited: false },
        monthly: { status: "rate-limited", percent: 96, resetsAt: "2026-02-01T00:00:00.000Z", rateLimited: true },
      },
      plan: null,
    },
    local: {
      ok: true,
      data: {
        dbPath: "C:\\Users\\tester\\.local\\share\\opencode\\opencode.db",
        plan: "go",
        models: [
          {
            modelId: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", known: true,
            unlimited: false, monthlyLimit: 60,
            lastUsedAt: Date.UTC(2026, 0, 8, 11, 30, 0), sessionCount: 4,
            windows: {
              rolling: zero({ input: 100, output: 10, reasoning: 5, cacheRead: 1000, cost: 0.01, costRaw: 0.02, calls: 1, peakCalls: 1 }),
              weekly: zero({ input: 500, output: 50, reasoning: 25, cacheRead: 5000, cost: 0.05, costRaw: 0.08, calls: 5, peakCalls: 4, offPeakCalls: 1 }),
              monthly: zero({ input: 700, output: 80, reasoning: 40, cacheRead: 7000, cost: 0.09, costRaw: 0.13, calls: 7, errors: 1, peakCalls: 5, offPeakCalls: 2 }),
              all: zero({ input: 700, output: 80, reasoning: 40, cacheRead: 7000, cost: 0.09, costRaw: 0.13, calls: 7, errors: 1, peakCalls: 5, offPeakCalls: 2 }),
            },
            monthly: { used: 0.09, limit: 60, remaining: 59.91, percentUsed: 0.15, percentRemaining: 99.85 },
            costBasis: { official: 0.09, opencodeRecorded: 0.13, delta: -0.04 },
            peakSplit: { peakCost: 0.07, offPeakCost: 0.02 },
            shares: {
              rolling: { cost: 0.01, calls: 1, shareRatio: 0.001, hasPeakPricing: true },
              weekly: { cost: 0.05, calls: 5, shareRatio: 0.002, hasPeakPricing: true },
              monthly: { cost: 0.09, calls: 7, shareRatio: 0.0015, hasPeakPricing: true },
            },
          },
          {
            modelId: "longcat-2.5-preview-free", label: "LongCat 2.5 Preview Free",
            known: true, unlimited: true, monthlyLimit: null,
            lastUsedAt: Date.UTC(2026, 0, 7, 9, 0, 0), sessionCount: 1,
            windows: {
              rolling: zero(),
              weekly: zero({ input: 10, output: 1, calls: 1 }),
              monthly: zero({ input: 10, output: 1, calls: 1 }),
              all: zero({ input: 10, output: 1, calls: 1 }),
            },
            monthly: { used: 0, limit: null, remaining: null, percentUsed: 0, percentRemaining: 100 },
            costBasis: { official: 0, opencodeRecorded: 0, delta: 0 },
            peakSplit: null,
            shares: {
              rolling: { cost: 0, calls: 0, shareRatio: 0, hasPeakPricing: false },
              weekly: { cost: 0, calls: 1, shareRatio: 0, hasPeakPricing: false },
              monthly: { cost: 0, calls: 1, shareRatio: 0, hasPeakPricing: false },
            },
          },
        ],
        totals: {
          rolling: zero({ input: 100, output: 10, reasoning: 5, cacheRead: 1000, cost: 0.01, costRaw: 0.02, calls: 1, peakCalls: 1 }),
          weekly: zero({ input: 510, output: 51, reasoning: 25, cacheRead: 5000, cost: 0.05, costRaw: 0.08, calls: 6, peakCalls: 4, offPeakCalls: 2 }),
          monthly: zero({ input: 710, output: 81, reasoning: 40, cacheRead: 7000, cost: 0.09, costRaw: 0.13, calls: 8, errors: 1, peakCalls: 5, offPeakCalls: 3 }),
          all: zero({ input: 710, output: 81, reasoning: 40, cacheRead: 7000, cost: 0.09, costRaw: 0.13, calls: 8, errors: 1, peakCalls: 5, offPeakCalls: 3 }),
        },
        daily: [
          { date: "2026-01-06", cost: 0.01, calls: 1, byModel: {} },
          { date: "2026-01-07", cost: 0.02, calls: 2, byModel: {} },
          { date: "2026-01-08", cost: 0.06, calls: 5, byModel: {} },
        ],
        sessionCount: 4,
        recordCount: 9,
        goRecordCount: 8,
        windows: {
          rolling: { startsAt: 1, resetsAt: null, label: "5 小时滚动" },
          weekly: { startsAt: 1, resetsAt: 2, label: "本周" },
          monthly: { startsAt: 1, resetsAt: 2, label: "本月" },
          all: { startsAt: null, resetsAt: null, label: "全部" },
        },
      },
    },
    recentCalls: [
      {
        id: "msg_1", at: Date.UTC(2026, 0, 8, 11, 30, 0), modelId: "deepseek-v4.1-flash",
        label: "DeepSeek V4.1 Flash", title: "一个很长的会话标题需要被截断显示", tier: "Peak",
        tokens: { input: 2293, output: 1470, reasoning: 1025, cacheRead: 9472, cacheWrite: 0 },
        cost: 0.001869366, error: false,
      },
      {
        id: "msg_2", at: Date.UTC(2026, 0, 7, 10, 0, 0), modelId: "deepseek-v4.1-flash",
        label: "DeepSeek V4.1 Flash", title: null, tier: "Off-Peak",
        tokens: { input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0.00001, error: true,
      },
    ],
  };
}

async function boot({ payload = usagePayload(), keyInfo } = {}) {
  const { document, els, segButtons, handlers } = makeDom();
  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
    const body = String(url).startsWith("/api/usage")
      ? payload
      : (keyInfo ?? {
          hasKey: true,
          masked: "oc_sk_35…l-wC",
          source: "opencode.db:opencode-go",
          configPath: "C:\\cfg\\config.json",
        });
    return { ok: true, status: 200, json: async () => body };
  };

  const store = new Map();
  const fn = new Function(
    "document", "window", "fetch", "localStorage", "setInterval", "setTimeout", "clearTimeout", "console",
    `"use strict";\n${appSource}\n;return { state, render, renderModels };`,
  );
  const api = fn(
    document,
    {},
    fetchImpl,
    { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    () => 0,
    () => 0,
    () => {},
    { log() {}, warn() {}, error() {} },
  );

  // wait until the initial render has actually populated the DOM
  for (let i = 0; i < 400; i++) {
    if (fetchCalls.length >= 2 && els.get("totals").innerHTML !== "") break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(fetchCalls.length >= 2, "initial load issued requests");
  assert.notEqual(els.get("totals").innerHTML, "", "initial render completed");
  return { els, segButtons, handlers, fetchCalls, api };
}

const rows = (els, table) =>
  (els.get(table).children.find((c) => c.tagName === "TBODY") ?? { children: [] }).children;

const tbodyHtml = (els, table) =>
  (els.get(table).children.find((c) => c.tagName === "TBODY") ?? { innerHTML: "" }).innerHTML;

test("dashboard renders rings, per-model rows, totals, chart and calls", async () => {
  const { els, segButtons, handlers } = await boot();

  const rings = els.get("rings");
  assert.equal(rings.children.length, 3, "three official windows");
  const ringHtml = rings.children.map((c) => c.innerHTML).join("\n");
  assert.match(ringHtml, /5 小时滚动/);
  assert.match(ringHtml, /本周/);
  assert.match(ringHtml, /已触发限流/, "rate-limited window is called out");
  assert.match(ringHtml, /96%/, "monthly percent is rendered");

  // 5h window by default, then the monthly view which has both models
  handlers.click({ target: segButtons[2] });
  const modelRows = rows(els, "modelsTable");
  assert.equal(modelRows.length, 2);
  assert.match(modelRows[0].innerHTML, /DeepSeek V4\.1 Flash/);
  assert.match(modelRows[0].innerHTML, /峰谷价/);
  assert.match(modelRows[0].innerHTML, /本窗口官方口径/, "cost-basis gap is surfaced");
  assert.match(modelRows[0].innerHTML, /\$0\.0900 \/ \$60/, "window cost over monthly limit");
  assert.match(modelRows[1].innerHTML, /免费/);

  const totalsHtml = els.get("totals").innerHTML;
  assert.match(els.get("totalsScope").textContent, /本月窗口/);
  assert.match(totalsHtml, /本月消耗/);
  assert.match(totalsHtml, /本月调用/);
  assert.match(totalsHtml, /8 次/);
  assert.match(totalsHtml, /累计消耗/);

  const chart = els.get("dailyChart").innerHTML;
  assert.match(chart, /<svg/);
  assert.equal((chart.match(/bar-rect/g) || []).length, 3, "one bar per day");

  const callRows = rows(els, "callsTable");
  assert.equal(callRows.length, 2);
  assert.match(callRows[0].innerHTML, /Peak/);
  assert.match(callRows[0].innerHTML, /2\.3K/, "token counts are formatted");

  assert.match(els.get("footInfo").textContent, /8\/9 条记录属于 OpenCode Go/);
  assert.equal(els.get("planPill").textContent, "Go");
});

test("switching the billing window re-filters rows without another fetch", async () => {
  const { els, segButtons, handlers, fetchCalls, api } = await boot();
  const before = fetchCalls.filter((c) => c.url.startsWith("/api/usage")).length;

  // default view is the 5h window; the free model stays visible there because
  // it has no dollar allowance at all
  assert.equal(api.state.win, "rolling");
  assert.equal(rows(els, "modelsTable").length, 2);

  handlers.click({ target: segButtons[2] });
  assert.equal(api.state.win, "monthly");
  assert.equal(rows(els, "modelsTable").length, 2, "monthly shows both models");

  handlers.click({ target: segButtons[3] });
  assert.equal(api.state.win, "all");
  assert.equal(rows(els, "modelsTable").length, 2);

  assert.equal(
    fetchCalls.filter((c) => c.url.startsWith("/api/usage")).length,
    before,
    "window switching is client-side only",
  );
});

test("a missing local database degrades gracefully", async () => {
  const payload = usagePayload();
  payload.local = { ok: false, reason: "no-db", message: "opencode database not found at X" };
  payload.recentCalls = [];
  const { els } = await boot({ payload });

  assert.match(tbodyHtml(els, "modelsTable"), /opencode database not found/);
  assert.equal(rows(els, "modelsTable").length, 0, "no fabricated model rows");
  assert.match(tbodyHtml(els, "callsTable"), /暂无调用记录/);
  assert.match(els.get("dailyChart").innerHTML, /暂无数据/);
  assert.match(els.get("footInfo").textContent, /opencode database not found/);
  // official data is unaffected by a local failure
  assert.equal(els.get("rings").children.length, 3);
});

test("a missing API key explains itself instead of showing fake percentages", async () => {
  const payload = usagePayload();
  payload.official = {
    ok: false,
    reason: "no-key",
    message: "未找到 OpenCode Go API key。可在界面里填入，或设置 TOKENCHECK_API_KEY 环境变量。",
  };
  const { els } = await boot({ payload });

  const notice = els.get("officialNotice");
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /未找到 OpenCode Go API key/);
  assert.equal(els.get("rings").children.length, 3, "placeholder rings still render");
  assert.match(els.get("rings").children[0].innerHTML, /无数据/);
  assert.equal(rows(els, "modelsTable").length, 2, "local stats still shown");
});
