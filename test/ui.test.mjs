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

// app.js receives a stubbed setTimeout so its timers never fire; the test itself
// still needs a real one to wait for the async render to settle.
const sleep = (ms) => new Promise((r) => globalThis.setTimeout(r, ms));

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// Surface rejections from the module-level load() so a render crash is visible
// instead of silently leaving the dashboard half-populated.
const seenRejections = [];
process.on("unhandledRejection", (e) => seenRejections.push(e?.stack || String(e)));

const ELEMENT_IDS = [
  "healthDot", "planPill", "planSelect", "refreshBtn", "keyBtn", "updatedAt",
  "officialSource", "rings", "officialNotice", "reconcile", "keyCard", "keySource", "configPath",
  "keyInput", "keySave", "keyClear", "windowSeg", "modelsHint", "modelsTable",
  "dailyChart", "totals", "totalsScope", "sessionsTable", "sessionsHint", "callsTable", "toast", "footInfo",
  "coverageBtn", "coverageCard", "coverageSource", "coverageWarn", "coverageSummary",
  "coverageTable",
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
  // Element-level listeners (buttons) are recorded so tests can fire them.
  addEventListener(type, fn) {
    (this._handlers ??= {})[type] = fn;
  }
  emit(type, evt = {}) {
    if (!this._handlers?.[type]) return false;
    this._handlers[type]({ target: this, ...evt });
    return true;
  }
  focus() {}
  scrollIntoView() {}
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
  tbody(els.get("sessionsTable"));
  tbody(els.get("coverageTable"));

  const segButtons = ["rolling", "weekly", "monthly", "all"].map((w) => {
    const b = new El("button");
    b.dataset.win = w;
    if (w === "rolling") b.classList.add("active");
    b._closest = "#windowSeg button";
    return b;
  });
  const seg = els.get("windowSeg");
  seg._all = segButtons;

  // mirror the markup: the coverage panel and the key entry start collapsed
  for (const id of ["coverageCard", "keyCard", "officialNotice", "coverageWarn", "toast"]) {
    els.get(id).hidden = true;
  }

  const handlers = {};
  const document = {
    querySelector(sel) {
      const m = /^#([A-Za-z0-9_-]+)$/.exec(sel);
      if (m) return els.get(m[1]) ?? null;
      // "#windowSeg button[data-win=\"x\"]"
      const attr = /^#([A-Za-z0-9_-]+)\s+(\w+)\[data-([\w-]+)="([^"]+)"\]$/.exec(sel);
      if (attr) {
        const parent = els.get(attr[1]);
        return (
          (parent?._all ?? []).find(
            (el) =>
              el.tagName === attr[2].toUpperCase() &&
              String(el.dataset[camel(attr[3])]) === attr[4],
          ) ?? null
        );
      }
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
      if (sel === "#modelsTable tbody" || sel === "#callsTable tbody" || sel === "#coverageTable tbody") {
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
    cost: 0, recordedCost: 0, calls: 0, errors: 0, peakCalls: 0, offPeakCalls: 0, ...o,
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
      keyMasked: "oc_sk_FAKE…TEST",
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
              rolling: zero({ input: 100, output: 10, reasoning: 5, cacheRead: 1000, cost: 0.02, recordedCost: 0.01, calls: 1, peakCalls: 1 }),
              weekly: zero({ input: 500, output: 50, reasoning: 25, cacheRead: 5000, cost: 0.08, recordedCost: 0.05, calls: 5, peakCalls: 4, offPeakCalls: 1 }),
              monthly: zero({ input: 700, output: 80, reasoning: 40, cacheRead: 7000, cost: 0.13, recordedCost: 0.09, calls: 7, errors: 1, peakCalls: 5, offPeakCalls: 2 }),
              all: zero({ input: 700, output: 80, reasoning: 40, cacheRead: 7000, cost: 0.13, recordedCost: 0.09, calls: 7, errors: 1, peakCalls: 5, offPeakCalls: 2 }),
            },
            monthly: { used: 0.13, limit: 60, remaining: 59.87, percentUsed: 0.2167, percentRemaining: 99.7833 },
            costBasis: { official: 0.13, opencodeRecorded: 0.09, delta: 0.04 },
            peakSplit: { peakCost: 0.1, offPeakCost: 0.03 },
            shares: {
              rolling: { cost: 0.02, calls: 1, shareRatio: 0.0016667, hasPeakPricing: true },
              weekly: { cost: 0.08, calls: 5, shareRatio: 0.0026667, hasPeakPricing: true },
              monthly: { cost: 0.13, calls: 7, shareRatio: 0.0021667, hasPeakPricing: true },
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
          rolling: zero({ input: 100, output: 10, reasoning: 5, cacheRead: 1000, cost: 0.02, recordedCost: 0.01, calls: 1, peakCalls: 1 }),
          weekly: zero({ input: 510, output: 51, reasoning: 25, cacheRead: 5000, cost: 0.08, recordedCost: 0.05, calls: 6, peakCalls: 4, offPeakCalls: 2 }),
          monthly: zero({ input: 710, output: 81, reasoning: 40, cacheRead: 7000, cost: 0.13, recordedCost: 0.09, calls: 8, errors: 1, peakCalls: 5, offPeakCalls: 3 }),
          all: zero({ input: 710, output: 81, reasoning: 40, cacheRead: 7000, cost: 0.13, recordedCost: 0.09, calls: 8, errors: 1, peakCalls: 5, offPeakCalls: 3 }),
        },
        daily: [
          { date: "2026-01-06", cost: 0.01, calls: 1, byModel: {} },
          { date: "2026-01-07", cost: 0.02, calls: 2, byModel: {} },
          { date: "2026-01-08", cost: 0.06, calls: 5, byModel: {} },
        ],
        sessionCount: 4,
        recordCount: 9,
        goRecordCount: 8,
        clients: [
          { client: "opencode", cost: 0.09, calls: 7, models: 1 },
          { client: "openleet", cost: 0.04, calls: 3, models: 1 },
        ],
        windows: {
          rolling: { startsAt: 1, resetsAt: null, label: "5 小时滚动" },
          weekly: { startsAt: 1, resetsAt: 2, label: "本周" },
          monthly: { startsAt: 1, resetsAt: 2, label: "本月" },
          all: { startsAt: null, resetsAt: null, label: "全部" },
        },
      },
    },
    topSessions: [
      {
        sessionId: "ses_1", title: "离散傅里叶变换计算举例", modelIds: ["deepseek-v4.1-flash"],
        label: "DeepSeek V4.1 Flash", cost: 0.0019, recordedCost: 0.001, calls: 3, errors: 0,
        tokens: { input: 5000, output: 2000, reasoning: 500, cacheRead: 9000, cacheWrite: 0 },
        firstAt: Date.UTC(2026, 0, 7, 9, 0, 0), lastAt: Date.UTC(2026, 0, 8, 11, 30, 0),
      },
      {
        sessionId: "ses_2", title: "<img src=x onerror=alert(1)>", modelIds: ["glm-5.2", "kimi-k3"],
        label: "GLM-5.2、Kimi K3", cost: 0.0005, recordedCost: 0.0005, calls: 1, errors: 0,
        tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        firstAt: Date.UTC(2026, 0, 8, 10, 0, 0), lastAt: Date.UTC(2026, 0, 8, 10, 0, 0),
      },
    ],
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

function coveragePayload() {
  return {
    ok: true,
    plan: "go",
    catalog: { ok: true, endpoint: "https://opencode.ai/zen/go/v1/models", fetchedAt: Date.UTC(2026, 0, 8, 9, 0, 0), count: 41, message: null },
    pricedCount: 30,
    summary: {
      usedCount: 2,
      advertisedCount: 41,
      usedUnpricedCount: 1,
      advertisedUnpricedCount: 11,
      notAdvertisedCount: 0,
      localError: null,
    },
    warnings: ["本机使用了 1 个未收录官方价格的模型：omen-alpha。这些模型的 token 会被统计，但费用不会计入估算。"],
    rows: [
      {
        id: "omen-alpha", label: "omen-alpha", used: true, advertised: true,
        priced: false, unlimited: false, monthlyLimit: null, windowLimits: null, peak: false,
      },
      {
        id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", used: true, advertised: true,
        priced: true, unlimited: false, monthlyLimit: 60,
        windowLimits: { rolling: 12, weekly: 30, monthly: 60 }, peak: true,
      },
      {
        id: "kimi-k3", label: "Kimi K3", used: false, advertised: false,
        priced: true, unlimited: false, monthlyLimit: 15,
        windowLimits: { rolling: 3, weekly: 7.5, monthly: 15 }, peak: false,
      },
    ],
  };
}

async function boot({ payload = usagePayload(), keyInfo, coverage = coveragePayload() } = {}) {
  const { document, els, segButtons, handlers } = makeDom();
  const fetchCalls = [];
  const DBG = { steps: [] };
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
    DBG.steps.push(`fetch:${String(url)}`);
    const target = String(url);
    const body = target.startsWith("/api/usage")
      ? payload
      : target.startsWith("/api/coverage")
        ? coverage
        : (keyInfo ?? {
            hasKey: true,
            masked: "oc_sk_FAKE…TEST",
            source: "opencode.db:opencode-go",
            configPath: "C:\\cfg\\config.json",
          });
    return { ok: true, status: 200, json: async () => body };
  };

  const store = new Map();
  const fn = new Function(
    "document", "window", "fetch", "localStorage", "setInterval", "setTimeout", "clearTimeout", "console",
    `"use strict";\n${appSource}\n;return { state, render, load };`,
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
  DBG.steps.push("module-evaluated");

  // wait until the initial render has actually populated the DOM
  for (let i = 0; i < 400; i++) {
    if (fetchCalls.length >= 2 && els.get("totals").innerHTML !== "") break;
    await sleep(5);
  }
  assert.ok(fetchCalls.length >= 2, `initial load issued requests (got ${JSON.stringify(fetchCalls)}; steps ${JSON.stringify(DBG.steps)}; rejections: ${JSON.stringify(seenRejections.slice(0, 2))})`);
  assert.notEqual(els.get("totals").innerHTML, "", "initial render completed");
  return { els, segButtons, handlers, fetchCalls, api };
}

async function bootRaw({ payload, coverage = coveragePayload() } = {}) {
  const { document, els, segButtons, handlers } = makeDom();
  const calls = [];
  const logged = [];
  const fn = new Function(
    "document", "window", "fetch", "localStorage", "setInterval", "setTimeout", "clearTimeout", "console",
    `"use strict";\n${appSource}\n;return { state };`,
  );
  fn(
    document,
    {},
    async (url) => {
      const target = String(url);
      calls.push(target);
      const body = target.startsWith("/api/usage")
        ? payload
        : target.startsWith("/api/coverage")
          ? coverage
          : { hasKey: true, masked: "oc_sk_FAKE…TEST", source: "config", configPath: "C:\\cfg.json" };
      return { ok: true, json: async () => body };
    },
    { getItem: () => null, setItem() {} },
    () => 0,
    () => 0,
    () => {},
    { log() {}, warn() {}, error: (...a) => logged.push(a.map(String).join(" ")) },
  );
  return { els, segButtons, handlers, calls, logged };
}

test("a render crash is reported instead of leaving a blank dashboard", async () => {
  const payload = usagePayload();
  // damage the payload in a way that breaks model-row rendering
  payload.local.data.models = { not: "an array" };
  const { els, logged } = await bootRaw({ payload });
  await sleep(50);

  assert.ok(logged.length > 0, "the failure is logged");
  assert.match(logged.join("\n"), /渲染失败/);
  assert.equal(els.get("toast").hidden, false, "the user sees a toast");
  assert.match(els.get("toast").textContent, /渲染失败/);
  // everything that rendered before the bad field still made it to the page
  assert.match(els.get("rings").children.map((c) => c.innerHTML).join(""), /本月/);
});

const rows = (els, table) =>
  (els.get(table).children.find((c) => c.tagName === "TBODY") ?? { children: [] }).children;

const tbodyHtml = (els, table) =>
  (els.get(table).children.find((c) => c.tagName === "TBODY") ?? { innerHTML: "" }).innerHTML;

test("?coverage=1 opens the coverage panel on load", async () => {
  globalThis.location = { search: "?coverage=1" };
  try {
    const { els } = await boot();
    await sleep(30);
    assert.equal(els.get("coverageCard").hidden, false);
    assert.match(els.get("coverageSource").textContent, /官方目录 41 个模型/);
    assert.equal(rows(els, "coverageTable").length, 3);
  } finally {
    delete globalThis.location;
  }
});

test("?win= forces a billing window and suppresses auto-picking", async () => {
  globalThis.location = { search: "?win=all" };
  try {
    const { els, api, segButtons } = await boot();
    await sleep(30);
    assert.equal(api.state.win, "all");
    assert.equal(api.state.autoPicked, false);
    const active = segButtons.filter((b) => b.classList.contains("active"));
    assert.equal(active.length, 1);
    assert.equal(active[0].dataset.win, "all");
    assert.match(els.get("totalsScope").textContent, /全部窗口/);
  } finally {
    delete globalThis.location;
  }
});

test("dashboard renders rings, per-model rows, totals, chart and calls", async () => {
  const { els, segButtons, handlers } = await boot();

  const rings = els.get("rings");
  assert.equal(rings.children.length, 3, "three official windows");
  const ringHtml = rings.children.map((c) => c.innerHTML).join("\n");
  assert.match(ringHtml, /5 小时滚动/);
  assert.match(ringHtml, /本周/);
  assert.match(ringHtml, /已触发限流/, "rate-limited window is called out");
  assert.match(ringHtml, /96%/, "monthly percent is rendered");

  // the tightest window (weekly) is selected on load; switch to monthly, which
  // is roomier and therefore includes the idle free model too
  handlers.click({ target: segButtons[2] });
  const modelRows = rows(els, "modelsTable");
  assert.equal(modelRows.length, 2);
  assert.match(modelRows[0].innerHTML, /DeepSeek V4\.1 Flash/);
  assert.match(modelRows[0].innerHTML, /峰谷价/);
  assert.match(modelRows[0].innerHTML, /本窗口上限 \$60\.00（月额度的 100%）/, "window cap is spelled out");
  assert.match(modelRows[0].innerHTML, /官方口径/, "cost-basis gap is surfaced");
  assert.match(modelRows[0].innerHTML, /\$0\.1300 \/ \$60\.00/, "window cost over its own cap");
  assert.match(modelRows[1].innerHTML, /免费/);
  assert.match(els.get("modelsHint").textContent, /来源：/, "per-client sources are shown");
  assert.match(els.get("modelsHint").textContent, /openleet/);

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

test("the reconciliation panel contrasts account and local percentages", async () => {
  const { els } = await boot();
  const host = els.get("reconcile");
  assert.equal(host.hidden, false);
  assert.match(host.innerHTML, /口径对账/);
  assert.match(host.innerHTML, /账号 96%/, "account-wide monthly percent");
  assert.match(host.innerHTML, /本机 0\.2%/, "local estimate for the same window");
  assert.match(host.innerHTML, /差额来自本机之外/, "the gap is called out, not hidden");
});

test("session ranking renders and escapes titles", async () => {
  const { els } = await boot();
  const sessionRows = rows(els, "sessionsTable");
  assert.equal(sessionRows.length, 2);
  assert.match(sessionRows[0].innerHTML, /离散傅里叶/);
  assert.match(sessionRows[0].innerHTML, /\$0\.0019/);
  assert.match(sessionRows[0].innerHTML, /DeepSeek V4\.1 Flash/);
  // a hostile session title must be escaped, never injected as markup
  assert.match(sessionRows[1].innerHTML, /&lt;img/);
  assert.doesNotMatch(sessionRows[1].innerHTML, /<img src=x/);
  assert.match(els.get("sessionsHint").textContent, /共 2 个/);
});

test("multiple priced models render in the server's order", async () => {
  const payload = usagePayload();
  const ds = payload.local.data.models[0];
  const kimi = JSON.parse(JSON.stringify(ds));
  kimi.modelId = "kimi-k3";
  kimi.label = "Kimi K3";
  kimi.monthlyLimit = 15;
  kimi.windows.monthly = { ...kimi.windows.monthly, cost: 0.5, calls: 3 };
  kimi.shares.monthly = { cost: 0.5, calls: 3, shareRatio: 0.0333, hasPeakPricing: false };
  payload.local.data.models = [kimi, ds]; // server sorts by monthly spend desc

  const { els, segButtons, handlers } = await boot({ payload });
  handlers.click({ target: segButtons[2] }); // monthly
  const modelRows = rows(els, "modelsTable");
  assert.equal(modelRows.length, 2);
  assert.match(modelRows[0].innerHTML, /Kimi K3/);
  assert.match(modelRows[1].innerHTML, /DeepSeek V4\.1 Flash/);
});

test("switching the billing window re-filters rows without another fetch", async () => {
  const { els, segButtons, handlers, fetchCalls, api } = await boot();
  const before = fetchCalls.filter((c) => c.url.startsWith("/api/usage")).length;

  // the auto-picked tightest window is weekly here; the free model has no dollar
  // allowance so it stays visible regardless
  assert.equal(api.state.win, "weekly");
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

test("the tightest window is selected automatically", async () => {
  const { els, api } = await boot();
  // rolling: 0.02/12 = 0.17%, weekly: 0.08/30 = 0.27%, monthly: 0.13/60 = 0.22%
  assert.equal(api.state.win, "weekly", "weekly is the most consumed window here");
  assert.equal(api.state.autoPicked, true);
  assert.match(els.get("modelsHint").textContent, /已自动切到最紧的窗口/);

  const active = els.get("windowSeg").querySelectorAll().filter((b) => b.classList.contains("active"));
  assert.equal(active.length, 1);
  assert.equal(active[0].dataset.win, "weekly");
});

test("coverage view lists caps, flags unpriced models and warns", async () => {
  const { els, handlers } = await boot();
  const card = els.get("coverageCard");
  assert.equal(card.hidden, true, "hidden until requested");

  // the coverage button has its own listener, not the delegated document one
  els.get("coverageBtn").emit("click");
  await sleep(30);
  assert.equal(card.hidden, false);
  assert.match(els.get("coverageSource").textContent, /官方目录 41 个模型/);
  assert.equal(els.get("coverageWarn").hidden, false);
  assert.match(els.get("coverageWarn").textContent, /omen-alpha/);

  const summary = els.get("coverageSummary").innerHTML;
  assert.match(summary, /用过但未收录价/);
  assert.match(summary, /1 个/);

  const coverRows = rows(els, "coverageTable");
  assert.equal(coverRows.length, 3);
  // used-but-unpriced first, with no fabricated dollar caps
  assert.match(coverRows[0].innerHTML, /omen-alpha/);
  assert.match(coverRows[0].innerHTML, /未收录价格/);
  assert.match(coverRows[0].innerHTML, /<td class="num">—<\/td>/);
  assert.match(coverRows[1].innerHTML, /DeepSeek V4\.1 Flash/);
  assert.match(coverRows[1].innerHTML, /\$12\.00/);
  assert.match(coverRows[1].innerHTML, /\$30\.00/);
  assert.match(coverRows[1].innerHTML, /\$60\.00/);
  assert.match(coverRows[1].innerHTML, /在用/);
  assert.match(coverRows[2].innerHTML, /已下架/);
});

test("the coverage button toggles the panel and the key button reveals the key row", async () => {
  const { els } = await boot();
  assert.equal(els.get("coverageCard").hidden, true);
  els.get("coverageBtn").emit("click");
  await sleep(30);
  assert.equal(els.get("coverageCard").hidden, false);
  els.get("coverageBtn").emit("click");
  assert.equal(els.get("coverageCard").hidden, true, "second click collapses it again");

  assert.equal(els.get("keyCard").hidden, true);
  els.get("keyBtn").emit("click");
  assert.equal(els.get("keyCard").hidden, false);
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
