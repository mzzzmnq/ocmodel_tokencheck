"use strict";

const state = {
  win: "rolling",
  autoPicked: false,
  data: null,
  coverage: null,
  plan: localStorage.getItem("tokencheck.plan") || "go",
};

const $ = (sel) => document.querySelector(sel);

// Deep link support: /?win=monthly pins a billing window, /?coverage=1 opens the
// coverage panel. globalThis keeps this testable outside a browser.
const bootParams = new URLSearchParams(globalThis.location?.search ?? "");
const WINDOWS = ["rolling", "weekly", "monthly", "all"];
const pinnedWindow = WINDOWS.includes(bootParams.get("win")) ? bootParams.get("win") : null;

/* ---------- formatting ---------- */

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function fmtMoney(v, digits) {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = digits ?? (Math.abs(v) < 1 ? 4 : 2);
  return `$${v.toFixed(d)}`;
}

function fmtTokens(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

function fmtPercent(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtCountdown(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "即将重置";
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d} 天 ${h} 小时后重置`;
  if (h > 0) return `${h} 小时 ${m % 60} 分后重置`;
  return `${m} 分钟后重置`;
}

function barClass(percent) {
  if (percent >= 90) return "bad";
  if (percent >= 70) return "warn";
  return "";
}

function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

/* ---------- data ---------- */

/**
 * Pick the billing window under the most pressure, so a model throttled by its
 * 5-hour cap is not hidden behind a roomy monthly number.
 */
function tightestWindow() {
  const models = state.data?.local?.ok ? state.data.local.data.models : [];
  const order = ["rolling", "weekly", "monthly"];
  let best = null;
  for (const w of order) {
    let max = 0;
    for (const m of models) {
      if (m.unlimited || !m.known) continue;
      const r = m.shares?.[w]?.shareRatio;
      if (Number.isFinite(r)) max = Math.max(max, r);
    }
    if (best === null || max > best.share) best = { win: w, share: max };
  }
  return best?.win ?? "rolling";
}

function setAutoWindow() {
  const pick = tightestWindow();
  const btn = document.querySelector(`#windowSeg button[data-win="${pick}"]`);
  state.win = pick;
  state.autoPicked = true;
  document.querySelectorAll("#windowSeg button").forEach((b) => b.classList.toggle("active", b === btn));
}

async function loadCoverage(force = false) {
  const btn = $("#coverageBtn");
  btn.disabled = true;
  try {
    const qs = new URLSearchParams({ plan: state.plan });
    if (force) qs.set("force", "1");
    state.coverage = await (await fetch(`/api/coverage?${qs}`, { cache: "no-store" })).json();
    renderCoverage();
  } catch (err) {
    toast(`模型覆盖加载失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function renderCoverage() {
  const c = state.coverage;
  const tbody = $("#coverageTable tbody");
  const warn = $("#coverageWarn");
  if (!c || !c.ok) {
    $("#coverageSource").textContent = "";
    $("#coverageSummary").innerHTML = '<div class="empty">暂无覆盖数据</div>';
    tbody.innerHTML = "";
    warn.hidden = true;
    return;
  }

  $("#coverageSource").textContent =
    c.catalog.ok
      ? `官方目录 ${c.catalog.count} 个模型 · 缓存于 ${fmtTime(c.catalog.fetchedAt)}`
      : c.catalog.message || "官方目录不可用";

  warn.hidden = c.warnings.length === 0;
  warn.className = "notice";
  warn.textContent = c.warnings.join(" ");

  const s = c.summary;
  $("#coverageSummary").innerHTML = [
    ["本机用过的模型", `${s.usedCount} 个`],
    ["已收录价格", `${c.pricedCount} 个`],
    ["官方在售", s.advertisedCount == null ? "未知" : `${s.advertisedCount} 个`],
    ["用过但未收录价", `${s.usedUnpricedCount} 个`],
    ["在售但未收录价", `${s.advertisedUnpricedCount} 个`],
    ["有价但已下架", `${s.notAdvertisedCount} 个`],
  ]
    .map(([k, v]) => `<div class="item"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join("");

  tbody.innerHTML = "";
  for (const r of c.rows) {
    const tags = [];
    if (r.used) tags.push('<span class="tag used">在用</span>');
    if (!r.priced) tags.push('<span class="tag unknown">未收录价格</span>');
    if (r.unlimited) tags.push('<span class="tag free">免费</span>');
    if (r.peak) tags.push('<span class="tag peak">峰谷价</span>');
    if (r.priced && r.advertised === false) tags.push('<span class="tag">已下架</span>');
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><div class="model-name"><span>${escapeHtml(r.label)}</span></div><div class="basis">${escapeHtml(r.id)}</div></td>
      <td class="num">${r.windowLimits ? (r.unlimited ? "不限" : fmtMoney(r.windowLimits.rolling, 2)) : "—"}</td>
      <td class="num">${r.windowLimits ? (r.unlimited ? "不限" : fmtMoney(r.windowLimits.weekly, 2)) : "—"}</td>
      <td class="num">${r.windowLimits ? (r.unlimited ? "不限" : fmtMoney(r.windowLimits.monthly, 2)) : "—"}</td>
      <td><div class="model-name">${tags.join("")}</div></td>`;
    tbody.appendChild(tr);
  }
}

async function load(force = false) {
  const btn = $("#refreshBtn");
  btn.disabled = true;
  btn.textContent = "刷新中…";
  try {
    const qs = new URLSearchParams({ plan: state.plan });
    if (force) qs.set("force", "1");
    const res = await fetch(`/api/usage?${qs}`, { cache: "no-store" });
    state.data = await res.json();
    render();
    // Selecting the window is a convenience, never a prerequisite for drawing,
    // so a surprise in the payload cannot blank the whole dashboard.
    try {
      if (pinnedWindow) {
        state.win = pinnedWindow;
        state.autoPicked = false;
      } else {
        setAutoWindow();
      }
      renderModels();
      renderTotals();
    } catch (err) {
      console.error("tokencheck: 自动选择窗口失败", err);
      state.win = "rolling";
    }
    $("#healthDot").className = `dot ${state.data.official?.ok ? "ok" : "bad"}`;
    if (!$("#coverageCard").hidden) await loadCoverage(force);
  } catch (err) {
    // Never leave the dashboard silently blank: say what broke.
    console.error("tokencheck: 渲染失败", err);
    toast(`渲染失败：${err.message}`);
    $("#healthDot").className = "dot bad";
  } finally {
    btn.disabled = false;
    btn.textContent = "刷新";
  }
}

async function loadKey() {
  try {
    const info = await (await fetch("/api/key", { cache: "no-store" })).json();
    $("#keySource").textContent = info.hasKey ? `当前：${info.masked}（来源 ${info.source}）` : "当前：未配置";
    $("#configPath").textContent = info.configPath;
  } catch {
    /* ignore */
  }
}

/* ---------- renderers ---------- */

function renderOfficial() {
  const official = state.data?.official;
  const rings = $("#rings");
  const notice = $("#officialNotice");
  rings.innerHTML = "";
  notice.hidden = true;

  if (!official || !official.ok) {
    notice.hidden = false;
    notice.className = `notice ${official?.reason === "no-key" ? "" : "err"}`;
    notice.textContent = official?.message || "无法获取官方额度数据。";
    $("#officialSource").textContent = "";
    const labels = { rolling: "5 小时滚动", weekly: "本周", monthly: "本月" };
    for (const [key, label] of Object.entries(labels)) rings.appendChild(ringCard(label, null, null, key));
    return;
  }

  $("#officialSource").textContent = `官方接口 · ${new Date(official.fetchedAt).toLocaleTimeString("zh-CN")} · key ${official.keyMasked}`;
  const labels = { rolling: "5 小时滚动", weekly: "本周", monthly: "本月" };
  for (const [key, label] of Object.entries(labels)) {
    rings.appendChild(ringCard(label, official.usage?.[key], null, key));
  }
}

function ringCard(label, win, sub, key) {
  const el = document.createElement("div");
  el.className = "ring";
  const pct = win && Number.isFinite(win.percent) ? Math.min(100, Math.max(0, win.percent)) : null;
  const color = pct == null ? "#484f58" : pct >= 90 ? "#f85149" : pct >= 70 ? "#e3b341" : "#2f81f7";
  const r = 30;
  const c = 2 * Math.PI * r;
  const dash = pct == null ? 0 : (pct / 100) * c;

  el.innerHTML = `
    <svg viewBox="0 0 76 76" role="img" aria-label="${label} ${pct ?? "未知"}">
      <circle cx="38" cy="38" r="${r}" fill="none" stroke="#263140" stroke-width="8" />
      <circle cx="38" cy="38" r="${r}" fill="none" stroke="${color}" stroke-width="8"
              stroke-linecap="round" stroke-dasharray="${dash} ${c}" transform="rotate(-90 38 38)" />
      <text x="38" y="43" text-anchor="middle" font-size="16" font-weight="700" fill="#e6edf3">${pct == null ? "—" : `${Math.round(pct)}%`}</text>
    </svg>
    <div class="meta">
      <div class="label">${label}</div>
      <div class="value">${pct == null ? "无数据" : `${pct}% 已用`}</div>
      <div class="status ${win?.status === "rate-limited" ? "rate-limited" : "ok"}">${win?.status === "rate-limited" ? "已触发限流" : win ? "正常" : ""}</div>
      <div class="reset" data-reset="${win?.resetsAt || ""}">${fmtCountdown(win?.resetsAt)}</div>
    </div>`;
  return el;
}

/**
 * The official API reports one account-wide percentage per window, covering every
 * machine and client on the subscription; the local store only sees this opencode
 * install. Show both side by side so the gap is quantified, never hidden.
 */
function localWindowPercent(win) {
  const models = state.data?.local?.data?.models || [];
  let best = null;
  for (const m of models) {
    if (!m.known || m.unlimited) continue;
    // shareRatio is cost / that window's own allowance, computed server-side
    const ratio = m.shares?.[win]?.shareRatio;
    if (!Number.isFinite(ratio)) continue;
    if (best === null || ratio > best) best = ratio;
  }
  return best === null ? null : best * 100;
}

function renderReconcile() {
  const host = $("#reconcile");
  const official = state.data?.official;
  const local = state.data?.local;
  if (!official?.ok || !local?.ok) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }

  const labels = { rolling: "5 小时", weekly: "本周", monthly: "本月" };
  let gap = false;
  const items = [];
  for (const win of ["rolling", "weekly", "monthly"]) {
    const account = official.usage?.[win]?.percent;
    const mine = localWindowPercent(win);
    if (account == null && mine == null) continue;
    if (account != null && mine != null && account - mine >= 3) gap = true;
    items.push(
      `<div class="recon-item"><span class="k">${labels[win]}</span>` +
        `<span class="v">账号 ${fmtPercent(account)}</span>` +
        `<span class="v muted">本机 ${mine == null ? "—" : fmtPercent(mine)}</span></div>`,
    );
  }

  host.hidden = false;
  host.innerHTML =
    `<div class="recon-head">口径对账 · 账号口径含所有电脑/客户端，本机口径仅统计这台电脑的 opencode</div>` +
    items.join("") +
    (gap
      ? `<div class="recon-note">账号百分比高于本机估算：差额来自本机之外的用量（其他电脑 / 其他客户端）。</div>`
      : "");
}

function renderModels() {
  const local = state.data?.local;
  const tbody = $("#modelsTable tbody");
  tbody.innerHTML = "";
  if (!local || !local.ok) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">${local?.message || "无法读取本地 opencode 数据。"}</td></tr>`;
    $("#modelsHint").textContent = "";
    return;
  }

  const win = state.win;
  const models = (local.data.models || []).filter((m) => {
    if (win === "all") return true;
    // Always surface models whose allowance is not a plain dollar figure,
    // otherwise they silently vanish from narrower windows.
    if (m.unlimited || !m.known) return true;
    const w = m.windows[win];
    return w && (w.cost > 0 || w.calls > 0);
  });

  const totalCost = models.reduce((s, m) => s + (m.windows[win]?.cost || 0), 0);
  const clients = local.data.clients || [];
  const sourceNote =
    clients.length > 1
      ? " · 来源：" + clients.map((c) => `${escapeHtml(c.client)} ${fmtMoney(c.cost, 2)}`).join(" / ")
      : "";
  $("#modelsHint").textContent =
    `${models.length} 个模型 · ${state.data.plan === "plus" ? "Go Plus" : "Go"} 套餐 · ` +
    `本窗口合计 ${fmtMoney(totalCost, 4)} · 进度条 = 本窗口消耗 / 该窗口上限` +
    (state.autoPicked ? " · 已自动切到最紧的窗口" : "") +
    sourceNote;

  if (!models.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">该窗口内暂无 OpenCode Go 调用记录。</td></tr>`;
    return;
  }

  for (const m of models) {
    const w = m.windows[win];
    const cap = m.unlimited ? Infinity : (m.windowLimits?.[win] ?? m.monthlyLimit ?? Infinity);
    const share = m.shares?.[win]?.shareRatio ?? (Number.isFinite(cap) && cap > 0 ? w.cost / cap : 0);
    const pct = Number.isFinite(cap) ? Math.min(100, share * 100) : 0;
    const tr = document.createElement("tr");

    const tags = [];
    if (m.unlimited) tags.push('<span class="tag free">免费</span>');
    if (m.shares?.[win]?.hasPeakPricing) tags.push('<span class="tag peak">峰谷价</span>');
    if (!m.known) tags.push('<span class="tag unknown">未收录价格</span>');

    const limitText = m.unlimited
      ? "不限"
      : `${fmtMoney(w.cost, 4)} / ${fmtMoney(cap, 2)}`;

    // opencode's own recorded cost differs for peak-priced models, because it
    // never applies the peak multiplier. Surface both figures, scoped to the
    // window being viewed, instead of hiding the gap.
    const basisParts = [];
    if (!m.unlimited && Number.isFinite(cap)) {
      basisParts.push(`本窗口上限 ${fmtMoney(cap, 2)}（月额度的 ${Math.round((cap / m.monthlyLimit) * 100)}%）`);
    }
    if (m.known && !m.unlimited && Number.isFinite(w.recordedCost)) {
      if (Math.abs(w.cost - w.recordedCost) > 1e-9) {
        basisParts.push(`官方口径 ${fmtMoney(w.cost, 4)} / opencode 记录 ${fmtMoney(w.recordedCost, 4)}`);
      }
    }
    const basis = basisParts.length ? `<div class="basis">${basisParts.join(" · ")}</div>` : "";

    tr.innerHTML = `
      <td class="col-model"><div class="model-name"><span>${escapeHtml(m.label)}</span>${tags.join("")}</div>${basis}</td>
      <td class="col-bar">
        <div class="bar ${barClass(pct)}"><span style="width:${pct.toFixed(2)}%"></span><em>${m.unlimited ? "免费" : fmtPercent(pct)}</em></div>
      </td>
      <td class="num">${limitText}</td>
      <td class="num">${fmtTokens(w.input)}</td>
      <td class="num">${fmtTokens(w.output + w.reasoning)}</td>
      <td class="num">${fmtTokens(w.cacheRead)}</td>
      <td class="num">${w.calls}</td>
      <td class="num">${fmtTime(m.lastUsedAt)}</td>`;
    tbody.appendChild(tr);
  }
}

function renderDaily() {
  const local = state.data?.local;
  const host = $("#dailyChart");
  const daily = (local?.ok && local.data.daily) || [];
  if (!daily.length) {
    host.innerHTML = '<div class="empty">暂无数据</div>';
    return;
  }
  const days = daily.slice(-14);
  const max = Math.max(...days.map((d) => d.cost), 0.0001);
  const W = 560;
  const H = 190;
  const padL = 46;
  const padB = 24;
  const padT = 10;
  const bw = (W - padL - 8) / days.length;

  const bars = days
    .map((d, i) => {
      const h = ((d.cost / max) * (H - padB - padT)) || 0;
      const x = padL + i * bw + 2;
      const y = H - padB - h;
      return `<rect class="bar-rect" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3">
        <title>${d.date} · ${fmtMoney(d.cost, 4)} · ${d.calls} 次</title></rect>
        <text x="${(x + (bw - 4) / 2).toFixed(1)}" y="${H - padB + 13}" text-anchor="middle">${d.date.slice(8)}</text>`;
    })
    .join("");

  const gridY = [0, 0.5, 1]
    .map((f) => {
      const y = H - padB - f * (H - padB - padT);
      return `<line class="grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - 6}" y2="${y.toFixed(1)}" />
        <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${fmtMoney(max * f, max < 0.1 ? 3 : 2)}</text>`;
    })
    .join("");

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${gridY}${bars}</svg>`;
}

function renderTotals() {
  const local = state.data?.local;
  const host = $("#totals");
  if (!local?.ok) {
    host.innerHTML = '<div class="empty">暂无数据</div>';
    $("#totalsScope").textContent = "";
    return;
  }
  const win = state.win;
  const label = { rolling: "5 小时", weekly: "本周", monthly: "本月", all: "全部" }[win];
  const t = local.data.totals[win];
  $("#totalsScope").textContent = `${label}窗口`;

  const items = [
    [`${label}消耗`, fmtMoney(t.cost, 4)],
    [`${label}调用`, `${t.calls} 次`],
    [`${label}输入`, fmtTokens(t.input)],
    [`${label}输出`, fmtTokens(t.output + t.reasoning)],
    [`${label}缓存读`, fmtTokens(t.cacheRead)],
    [`${label}错误`, `${t.errors} 次`],
    ["累计消耗", fmtMoney(local.data.totals.all.cost, 2)],
    ["累计调用", `${local.data.totals.all.calls} 次`],
  ];
  host.innerHTML = items
    .map(([k, v]) => `<div class="item"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join("");
}

function renderCalls() {
  const tbody = $("#callsTable tbody");
  const calls = state.data?.recentCalls || [];
  tbody.innerHTML = "";
  if (!calls.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无调用记录</td></tr>';
    return;
  }
  for (const c of calls) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtTime(c.at)}</td>
      <td>${escapeHtml(c.label)}${c.tier ? ` <span class="tag peak">${escapeHtml(c.tier)}</span>` : ""}</td>
      <td>${escapeHtml((c.title || "—").slice(0, 28))}</td>
      <td class="num">${fmtTokens(c.tokens.input)}</td>
      <td class="num">${fmtTokens(c.tokens.output + c.tokens.reasoning)}</td>
      <td class="num">${fmtTokens(c.tokens.cacheRead)}</td>
      <td class="num">${fmtMoney(c.cost, 6)}</td>`;
    tbody.appendChild(tr);
  }
}

function renderSessions() {
  const tbody = $("#sessionsTable tbody");
  const sessions = (state.data?.local?.ok && state.data?.topSessions) || [];
  tbody.innerHTML = "";
  if (!sessions.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">暂无会话记录</td></tr>';
    $("#sessionsHint").textContent = "";
    return;
  }
  $("#sessionsHint").textContent = `按官方峰谷口径消耗排序 · 共 ${sessions.length} 个`;
  for (const s of sessions) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="col-model">${escapeHtml((s.title || "（无标题）").slice(0, 36))}</td>
      <td>${escapeHtml(s.label)}</td>
      <td class="num">${fmtMoney(s.cost, 4)}</td>
      <td class="num">${s.calls}</td>
      <td class="num">${fmtTokens(s.tokens.input)}</td>
      <td class="num">${fmtTokens(s.tokens.output + s.tokens.reasoning)}</td>
      <td class="num">${fmtTokens(s.tokens.cacheRead)}</td>
      <td class="num">${fmtTime(s.lastAt)}</td>`;
    tbody.appendChild(tr);
  }
}

function renderFooter() {
  const local = state.data?.local;
  $("#planPill").textContent = state.data?.plan === "plus" ? "Go Plus" : "Go";
  $("#updatedAt").textContent = state.data ? `更新于 ${fmtTime(state.data.now)}` : "—";
  if (local?.ok) {
    $("#footInfo").textContent =
      `本地库：${local.data.dbPath} · ${local.data.goRecordCount}/${local.data.recordCount} 条记录属于 OpenCode Go · ${local.data.sessionCount} 个会话`;
  } else {
    $("#footInfo").textContent = local?.message || "";
  }
}

function render() {
  renderOfficial();
  renderReconcile();
  renderModels();
  renderDaily();
  renderTotals();
  renderSessions();
  renderCalls();
  renderFooter();
  loadKey();
}

/* ---------- events ---------- */

document.addEventListener("click", (e) => {
  const seg = e.target.closest("#windowSeg button");
  if (seg) {
    state.win = seg.dataset.win;
    state.autoPicked = false;
    document.querySelectorAll("#windowSeg button").forEach((b) => b.classList.toggle("active", b === seg));
    renderModels();
    renderTotals();
  }
});

$("#coverageBtn").addEventListener("click", () => toggleCoverage());
$("#refreshBtn").addEventListener("click", () => load(true));
$("#keyBtn").addEventListener("click", () => {
  const card = $("#keyCard");
  card.hidden = !card.hidden;
  if (!card.hidden) $("#keyInput").focus();
});

async function toggleCoverage(force = false) {
  const card = $("#coverageCard");
  card.hidden = card.hidden === false && !force;
  if (card.hidden) return;
  if (force || !state.coverage) await loadCoverage(false);
  else renderCoverage();
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("#planSelect").addEventListener("change", async (e) => {
  state.plan = e.target.value;
  localStorage.setItem("tokencheck.plan", state.plan);
  await load(false);
  toast(`已切换到 ${state.plan === "plus" ? "Go Plus" : "Go"} 额度口径`);
});

$("#keySave").addEventListener("click", async () => {
  const apiKey = $("#keyInput").value.trim();
  const res = await fetch("/api/key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  const info = await res.json();
  $("#keyInput").value = "";
  toast(info.hasKey ? `已保存（${info.masked}）` : "已清除保存的 key");
  await load(true);
});

$("#keyClear").addEventListener("click", async () => {
  await fetch("/api/key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "" }),
  });
  $("#keyInput").value = "";
  toast("已清除保存的 key，将回退到 opencode 本地凭据");
  await load(true);
});

$("#planSelect").value = state.plan;

setInterval(() => {
  document.querySelectorAll("[data-reset]").forEach((el) => {
    if (el.dataset.reset) el.textContent = fmtCountdown(el.dataset.reset);
  });
}, 30_000);

setInterval(() => load(false), 60_000);
load(false).then(() => {
  if (pinnedWindow) {
    const btn = document.querySelector(`#windowSeg button[data-win="${pinnedWindow}"]`);
    document.querySelectorAll("#windowSeg button").forEach((b) => b.classList.toggle("active", b === btn));
    renderModels();
    renderTotals();
  }
  if (bootParams.has("coverage")) return toggleCoverage(true);
  return undefined;
});
