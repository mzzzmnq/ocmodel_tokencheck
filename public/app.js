"use strict";

const state = {
  win: "rolling",
  data: null,
  plan: localStorage.getItem("tokencheck.plan") || "go",
};

const $ = (sel) => document.querySelector(sel);

/* ---------- formatting ---------- */

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
    $("#healthDot").className = `dot ${state.data.official?.ok ? "ok" : "bad"}`;
  } catch (err) {
    toast(`加载失败：${err.message}`);
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
  $("#modelsHint").textContent =
    `${models.length} 个模型 · ${state.data.plan === "plus" ? "Go Plus" : "Go"} 套餐 · ` +
    `本窗口合计 ${fmtMoney(totalCost, 4)} · 进度条 = 本窗口消耗 / 该模型总额度`;

  if (!models.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">该窗口内暂无 OpenCode Go 调用记录。</td></tr>`;
    return;
  }

  for (const m of models) {
    const w = m.windows[win];
    const share = m.shares?.[win]?.shareRatio ?? (m.monthlyLimit ? w.cost / m.monthlyLimit : 0);
    const pct = m.unlimited ? 0 : Math.min(100, share * 100);
    const tr = document.createElement("tr");

    const tags = [];
    if (m.unlimited) tags.push('<span class="tag free">免费</span>');
    if (m.shares?.[win]?.hasPeakPricing) tags.push('<span class="tag peak">峰谷价</span>');
    if (!m.known) tags.push('<span class="tag unknown">未收录价格</span>');

    const limitText = m.unlimited
      ? "不限"
      : `${fmtMoney(w.cost, 4)} / ${fmtMoney(m.monthlyLimit, 0)}`;

    // opencode's own recorded cost differs for peak-priced models, because it
    // never applies the peak multiplier. Surface the gap instead of hiding it.
    let basis = "";
    if (m.known && !m.unlimited && Number.isFinite(m.costBasis?.opencodeRecorded)) {
      const rec = m.costBasis.opencodeRecorded;
      const off = m.costBasis.official;
      const gap = Math.abs(off - rec);
      if (gap > 1e-9) {
        basis = `<div class="basis">本窗口官方口径 ${fmtMoney(w.costRaw, 4)}（opencode 记录 ${fmtMoney(rec, 4)}）</div>`;
      }
    }

    tr.innerHTML = `
      <td class="col-model"><div class="model-name"><span>${m.label}</span>${tags.join("")}</div>${basis}</td>
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
      <td>${c.label}${c.tier ? ` <span class="tag peak">${c.tier}</span>` : ""}</td>
      <td>${(c.title || "—").slice(0, 28)}</td>
      <td class="num">${fmtTokens(c.tokens.input)}</td>
      <td class="num">${fmtTokens(c.tokens.output + c.tokens.reasoning)}</td>
      <td class="num">${fmtTokens(c.tokens.cacheRead)}</td>
      <td class="num">${fmtMoney(c.cost, 6)}</td>`;
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
  renderModels();
  renderDaily();
  renderTotals();
  renderCalls();
  renderFooter();
  loadKey();
}

/* ---------- events ---------- */

document.addEventListener("click", (e) => {
  const seg = e.target.closest("#windowSeg button");
  if (seg) {
    state.win = seg.dataset.win;
    document.querySelectorAll("#windowSeg button").forEach((b) => b.classList.toggle("active", b === seg));
    renderModels();
    renderTotals();
  }
});

$("#refreshBtn").addEventListener("click", () => load(true));
$("#keyBtn").addEventListener("click", () => {
  const card = $("#keyCard");
  card.hidden = !card.hidden;
  if (!card.hidden) $("#keyInput").focus();
});

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
load(false);
