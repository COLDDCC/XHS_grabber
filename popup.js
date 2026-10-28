// popup.js — 社媒采集助手 · 弹窗逻辑
const $ = (id) => document.getElementById(id);

if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
  document.body.innerHTML =
    '<div style="padding:40px 24px;text-align:center;color:#888;font-size:13px;line-height:2.2">' +
    '<div style="font-size:32px;margin-bottom:10px">⚠️</div>' +
    '当前不是扩展运行环境（缺少 chrome.runtime）。<br>' +
    '请先在 Chrome 扩展页（chrome://extensions）<br>' +
    '加载「社媒采集助手」文件夹，<br>' +
    '再点击浏览器工具栏的 📕 图标打开本面板。<br>' +
    '<span style="color:#c00">不要直接双击打开 popup.html 文件。</span>' +
    '</div>';
  throw new Error("extension context not available");
}

const PLATFORM_LABEL = { xhs: "小红书" };
function setStatus(msg, cls) {
  const line = $("statusLine");
  if (line) {
    line.textContent = msg;
    line.className = cls || "status-line";
  }
  const lib = $("libraryStatus");
  if (lib) {
    lib.textContent = msg;
    lib.className = cls || "status-line";
  }
}

function safeName(s) {
  return String(s || "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "untitled";
}

function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: false, error: "无响应" });
        }
      });
    } catch (err) {
      resolve({ ok: false, error: String(err) });
    }
  });
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const state = {
  summary: null,
  items: [],
  keywordFilter: "",
  platformFilter: "",
  sortFilter: "score",
  trendKeyword: "",
  checked: new Set(), // 素材库勾选的 key（platform:id）
};

// ---------- 表单实时自动保存（重开插件自动恢复） ----------
const FORM_FIELDS = [
  "keywordsInput", "sortSelect", "timeSelect", "maxInput", "delayInput",
  "minLikesInput", "minCollectsInput", "minCommentsInput", "captureTypeSelect", "silentCb",
  "authorUrlInput", "authorMaxInput", "linkInput",
  "suggestInput", "suggestMaxInput",
  "commentLinksInput", "commentMinLikesInput", "commentMaxInput",
  "keywordFilter", "minLikesFilter", "sortFilter",
  "commentMinLikesFilter",
];
let formSaveTimer = null;
function saveForm() {
  const data = {};
  FORM_FIELDS.forEach((id) => {
    const el = $(id);
    if (!el) return;
    data[id] = el.type === "checkbox" ? el.checked : el.value;
  });
  try { chrome.storage.local.set({ smc_form_v1: data }); } catch (e) { /* ignore */ }
}
function scheduleSaveForm() {
  clearTimeout(formSaveTimer);
  formSaveTimer = setTimeout(saveForm, 300);
}
function loadForm() {
  try {
    chrome.storage.local.get("smc_form_v1", (data) => {
      const f = (data && data.smc_form_v1) || {};
      FORM_FIELDS.forEach((id) => {
        const el = $(id);
        if (!el || !(id in f)) return;
        if (el.type === "checkbox") el.checked = !!f[id];
        else el.value = f[id];
      });
    });
  } catch (e) { /* ignore */ }
}
FORM_FIELDS.forEach((id) => {
  const el = $(id);
  if (!el) return;
  const evt = el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input";
  el.addEventListener(evt, scheduleSaveForm);
});

// ---------- 状态 ----------
function renderStatus() {
  const line = $("statusLine");
  const job = state.summary && state.summary.job ? state.summary.job : null;
  if (!job || !job.active) {
    if (job && job.finished && job.finishedMessage) {
      line.textContent = job.finishedMessage;
      line.className = "status-line done";
    } else {
      line.textContent = "空闲。登录后即可开始采集。";
      line.className = "status-line";
    }
    $("startBtn").disabled = false;
    ["stopBtn", "authorStopBtn", "linkStopBtn", "suggestStopBtn", "commentStopBtn"].forEach((id) => {
      const b = $(id); if (b) b.disabled = true;
    });
    return;
  }
  if (job.mode === "author") {
    line.textContent = `博主采集中：「${job.currentKeyword}」，本次新增 ${job.totalCollected} 条…`;
  } else if (job.mode === "links") {
    line.textContent = `链接采集中：第 ${job.linkIndex + 1}/${job.linkQueue.length} 条，本次新增 ${job.totalCollected} 条…`;
  } else if (job.mode === "suggest") {
    line.textContent = `下拉词采集中：「${job.currentKeyword}」，已得 ${job.totalCollected} 个联想词（${(job.suggestIndex || 0) + 1}/${job.seeds.length} 个种子）…`;
  } else if (job.mode === "comments") {
    line.textContent = `评论采集中：第 ${job.linkIndex + 1}/${job.linkQueue.length} 篇，已收 ${job.totalCollected} 条高赞评论…`;
  } else {
    const done = job.comboIndex + 1;
    const total = job.combos.length;
    const label = PLATFORM_LABEL[job.currentPlatform] || job.currentPlatform;
    line.textContent = `采集中：${label}「${job.currentKeyword}」（${done}/${total} 组合），本次新增 ${job.totalCollected} 条…`;
  }
  line.className = "status-line running";
  $("startBtn").disabled = true;
  ["stopBtn", "authorStopBtn", "linkStopBtn", "suggestStopBtn", "commentStopBtn"].forEach((id) => {
    const b = $(id); if (b) b.disabled = false;
  });
}

async function stopCollection() {
  await sendMessage({ type: "SMC_STOP", message: "已手动停止采集" });
  await refreshSummary();
  await refreshItems();
  refreshSuggestWords();
  refreshComments();
}

function keywordOptionsHtml(selected) {
  const keywords = state.summary ? Object.keys(state.summary.keywords || {}) : [];
  keywords.sort((a, b) => ((state.summary.keywords[b] || {}).last_seen || "").localeCompare((state.summary.keywords[a] || {}).last_seen || ""));
  const opts = [`<option value="">全部关键词</option>`];
  keywords.forEach((k) => {
    const count = (state.summary.keywords[k] || {}).count || 0;
    opts.push(`<option value="${esc(k)}"${k === selected ? " selected" : ""}>${esc(k)}（${count}）</option>`);
  });
  return opts.join("");
}

function renderKeywordSelects() {
  const prev = state.keywordFilter;
  $("keywordFilter").innerHTML = keywordOptionsHtml(prev);
  if (prev) $("keywordFilter").value = prev;

  const prevTrend = state.trendKeyword;
  $("trendKeyword").innerHTML = keywordOptionsHtml(prevTrend);
  if (prevTrend) $("trendKeyword").value = prevTrend;
}

function renderTotalBadge() {
  $("totalBadge").textContent = `共 ${state.items.length} 条`;
}

function deltaLineHtml(it) {
  const d = it.delta;
  if (!d) return "";
  const parts = [];
  if (d.liked > 0) parts.push(`赞+${d.liked}`);
  if (d.collected > 0) parts.push(`藏+${d.collected}`);
  if (d.comments > 0) parts.push(`评+${d.comments}`);
  if (!parts.length) return "";
  return `<div class="delta-line">📈 较上次采集：${parts.join("  ")}</div>`;
}

function statsHtml(it) {
  const s = it.stats || {};
  let html = "";
  html += `<span>👍 <b>${s.likes || 0}</b></span>`;
  html += `<span>⭐ <b>${s.collects || 0}</b></span>`;
  html += `<span>💬 <b>${s.comments || 0}</b></span>`;
  if (s.shares) html += `<span>↗ <b>${s.shares}</b></span>`;
  if (s.views) html += `<span>▶ <b>${s.views}</b></span>`;
  return html;
}

function renderItems() {
  const listEl = $("itemList");
  let items = state.items.slice();
  const key = state.sortFilter;
  items.sort((a, b) => {
    if (key === "post_time" || key === "captured_at") {
      return String(b[key] || "").localeCompare(String(a[key] || ""));
    }
    const av = key === "likes" || key === "collects" || key === "comments" || key === "shares" || key === "views"
      ? (a.stats ? (a.stats[key] || 0) : 0)
      : (Number(a.score) || 0);
    const bv = key === "likes" || key === "collects" || key === "comments" || key === "shares" || key === "views"
      ? (b.stats ? (b.stats[key] || 0) : 0)
      : (Number(b.score) || 0);
    return bv - av;
  });
  if (!items.length) {
    listEl.innerHTML = `<div class="empty">暂无数据。用「采集」页搜索关键词或采集链接后，素材会出现在这里。</div>`;
    return;
  }
  const minLikes = Number($("minLikesFilter") ? $("minLikesFilter").value : 0) || 0;
  let visible = items.filter((it) => (it.stats && (Number(it.stats.likes) || 0)) >= minLikes);
  if (!visible.length) {
    listEl.innerHTML = `<div class="empty">当前筛选条件下没有符合的内容。</div>`;
    return;
  }
  const rankCls = (i) => (i === 0 ? "rank-1" : i === 1 ? "rank-2" : i === 2 ? "rank-3" : "rank-n");
  listEl.innerHTML = visible
    .map((it, i) => {
      const cover = it.cover_url
        ? `<img class="cover" src="${esc(it.cover_url)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'" />`
        : `<div class="cover"></div>`;
      const plat = PLATFORM_LABEL[it.platform] || it.platform;
      const actions = [];
      actions.push(`<button class="mini" data-act="open" data-key="${esc(it.platform + ":" + it.id)}">↗ 打开</button>`);
      actions.push(`<button class="mini" data-act="copy" data-key="${esc(it.platform + ":" + it.id)}">⧉ 复制链接</button>`);
      return `
      <div class="note-card" data-key="${esc(it.platform + ":" + it.id)}">
        <input type="checkbox" class="note-check" data-key="${esc(it.platform + ":" + it.id)}"${state.checked.has(it.platform + ":" + it.id) ? " checked" : ""} />
        <div class="rank-badge ${rankCls(i)}">#${i + 1}</div>
        ${cover}
        <div class="note-info">
          <div class="note-title">${esc(it.title)}</div>
          <div class="note-meta">
            <span><span class="plat-tag plat-${esc(it.platform)}">${plat}</span> @${esc(it.author)}</span>
            <span>${esc(it.time_text || "")}</span>
          </div>
          <div class="note-stats">${statsHtml(it)}<span class="score-chip">热度 ${(Number(it.score) || 0).toFixed(0)}</span></div>
          ${deltaLineHtml(it)}
          <div class="actions">${actions.join("")}</div>
        </div>
      </div>`;
    })
    .join("");
}

function renderHistory() {
  const listEl = $("historyList");
  const history = (state.summary && state.summary.history) || [];
  if (!history.length) {
    listEl.innerHTML = `<div class="empty">暂无采集历史。</div>`;
    return;
  }
  listEl.innerHTML = history
    .slice(0, 100)
    .map((h) => {
      const kw = (h.keyword || "").length > 12 ? h.keyword.slice(0, 12) + "…" : h.keyword || "";
      const plat = PLATFORM_LABEL[h.platform] || "";
      return `<div class="history-row">
        <span class="kw">${plat ? "[" + plat + "] " : ""}${esc(kw)}</span>
        <span class="add">+${h.added || 0} 条</span>
        <span class="at">${esc(formatTime(h.at))}</span>
      </div>`;
    })
    .join("");
}

// ---------- 趋势 ----------
async function refreshTrend() {
  const keyword = state.trendKeyword;
  const resp = await sendMessage({ type: "SMC_GET_ITEMS", keyword });
  if (resp && resp.ok) {
    renderTrendWith(keyword, resp.items || []);
  } else {
    $("trendReport").innerHTML = `<div class="empty">读取数据失败。</div>`;
  }
}

function renderTrendWith(keyword, items) {
  const report = $("trendReport");
  if (!keyword) {
    report.innerHTML = `<div class="empty">请先选择一个关键词，再点「刷新报告」。</div>`;
    return;
  }
  // 适配旧版分析函数的数据形状
  const notes = items.map((it) => ({
    title: it.title || "",
    content: it.content || "",
    liked_count: (it.stats && it.stats.likes) || 0,
    collected_count: (it.stats && it.stats.collects) || 0,
    comment_count: (it.stats && it.stats.comments) || 0,
  }));
  const data = xhsAnalyzeTrend(notes);
  if (!data) {
    report.innerHTML = `<div class="empty">该关键词暂无数据。</div>`;
    return;
  }
  const escKw = esc(keyword);
  const maxWeight = data.terms.length ? data.terms[0].weight : 1;
  const rankCls = (i) => (i === 0 ? "" : i === 1 ? "r2" : i === 2 ? "r3" : "rn");
  const rows = data.terms
    .map((t, i) => {
      const pct = maxWeight > 0 ? Math.round((t.weight / maxWeight) * 100) : 0;
      return `<tr>
        <td><span class="rank-badge-mini ${rankCls(i)}">#${i + 1}</span></td>
        <td class="term-word">${esc(t.word)}</td>
        <td><div class="term-bar-bg"><div class="term-bar" style="width:${pct}%"></div></div></td>
        <td class="term-weight">${t.weight.toFixed(4)} (${pct}%)</td>
      </tr>`;
    })
    .join("");
  report.innerHTML = `
    <div class="trend-title">📊 搜索词【${escKw}】历史分析报告</div>
    <div class="trend-scope">本报告仅统计通过「${escKw}」采集入库的内容，不与其他关键词混合。</div>
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-num">${data.total}</div><div class="kpi-desc">📚 入库总数</div></div>
      <div class="kpi-card"><div class="kpi-num">${data.avgLikes}</div><div class="kpi-desc">👍 平均点赞</div></div>
      <div class="kpi-card"><div class="kpi-num">${data.avgCollects}</div><div class="kpi-desc">⭐ 平均收藏</div></div>
      <div class="kpi-card"><div class="kpi-num">${data.avgComments}</div><div class="kpi-desc">💬 平均评论</div></div>
      <div class="kpi-card"><div class="kpi-num">${data.maxLikes}</div><div class="kpi-desc">🔥 单帖最高赞</div></div>
    </div>
    <div style="font-size:13px;font-weight:700;color:#333;margin-bottom:6px;">🔥 高频关键词分布 (Top 15)</div>
    <table class="terms-table">
      <tr><th width="14%">排名</th><th width="22%">关键词</th><th>权重分布</th><th width="24%" align="right">权重(TF-IDF)</th></tr>
      ${rows}
    </table>`;
}

// ---------- 数据刷新 ----------
async function refreshSummary() {
  const resp = await sendMessage({ type: "SMC_GET_SUMMARY" });
  if (resp && resp.ok) {
    state.summary = resp;
    renderStatus();
    renderKeywordSelects();
    renderHistory();
  }
}

async function refreshItems() {
  const resp = await sendMessage({
    type: "SMC_GET_ITEMS",
    platform: state.platformFilter,
    keyword: state.keywordFilter,
  });
  if (resp && resp.ok) {
    state.items = resp.items || [];
    renderItems();
    renderTotalBadge();
  }
}

function itemByKey(key) {
  return state.items.find((it) => `${it.platform}:${it.id}` === key) || null;
}

async function openItem(key) {
  const it = itemByKey(key);
  if (!it) return;
  const url = it.url || `https://www.xiaohongshu.com/explore/${it.id}`;
  await chrome.tabs.create({ url, active: true });
}

async function copyItem(key) {
  const it = itemByKey(key);
  if (!it) return;
  const link = it.url || `https://www.xiaohongshu.com/explore/${it.id}`;
  try {
    await navigator.clipboard.writeText(link);
    setStatus("已复制链接 ✅", "status-line done");
  } catch (err) {
    setStatus("复制失败：" + String(err && err.message || err), "");
  }
}

// ---------- 事件 ----------
$("startBtn").addEventListener("click", async () => {
  const platforms = ["xhs"]; // 仅小红书
  const raw = $("keywordsInput").value;
  const keywords = raw.split(/[,，\n;；]+/).map((k) => k.trim()).filter(Boolean);
  if (!keywords.length) {
    $("statusLine").textContent = "请先输入至少一个关键词。";
    $("statusLine").className = "status-line";
    return;
  }
  const resp = await sendMessage({
    type: "SMC_START_SEARCH",
    platforms,
    keywords,
    sort: $("sortSelect").value,
    timeRangeSec: Number($("timeSelect").value) || 0,
    typeFilter: $("captureTypeSelect") ? $("captureTypeSelect").value : "",
    maxPerKeyword: Number($("maxInput").value) || 150,
    minLikes: Number($("minLikesInput").value) || 0,
    minCollects: Number($("minCollectsInput").value) || 0,
    minComments: Number($("minCommentsInput").value) || 0,
    delaySec: Number($("delayInput").value) || 0,
    foreground: $("silentCb") ? !$("silentCb").checked : false,
  });
  if (!resp || !resp.ok) {
    $("statusLine").textContent = `无法开始：${resp && resp.error ? resp.error : "未知错误"}`;
    $("statusLine").className = "status-line";
  } else {
    await refreshSummary();
  }
});

$("authorBtn").addEventListener("click", async () => {
  const url = $("authorUrlInput").value.trim();
  if (!url) {
    $("statusLine").textContent = "请先粘贴博主主页链接（…/user/profile/…）。";
    $("statusLine").className = "status-line";
    return;
  }
  const resp = await sendMessage({
    type: "SMC_START_AUTHOR",
    url,
    max: Number($("authorMaxInput").value) || 100,
    author: "",
    foreground: $("silentCb") ? !$("silentCb").checked : false,
  });
  if (!resp || !resp.ok) {
    $("statusLine").textContent = `无法开始博主采集：${resp && resp.error ? resp.error : "未知错误"}`;
    $("statusLine").className = "status-line";
  } else {
    await refreshSummary();
  }
});

$("linkBtn").addEventListener("click", async () => {
  const raw = $("linkInput").value;
  const links = raw.split(/[\n\r;，]+/).map((l) => l.trim()).filter((l) => /xiaohongshu\.com\/(?:explore|discovery\/item)\/[A-Za-z0-9]+/.test(l));
  if (!links.length) {
    $("statusLine").textContent = "请粘贴小红书笔记链接（…/explore/… 或 …/discovery/item/…）。";
    $("statusLine").className = "status-line";
    return;
  }
  const resp = await sendMessage({
    type: "SMC_START_LINK",
    links,
    foreground: $("silentCb") ? !$("silentCb").checked : false,
  });
  if (!resp || !resp.ok) {
    $("statusLine").textContent = `无法开始链接采集：${resp && resp.error ? resp.error : "未知错误"}`;
    $("statusLine").className = "status-line";
  } else {
    await refreshSummary();
  }
});

$("stopBtn").addEventListener("click", stopCollection);
$("authorStopBtn").addEventListener("click", stopCollection);
$("linkStopBtn").addEventListener("click", stopCollection);
$("suggestStopBtn").addEventListener("click", stopCollection);
$("commentStopBtn").addEventListener("click", stopCollection);

// ---------- 导出（勾选优先；XLSX） ----------
const EXPORT_HEADER = ["平台", "关键词", "作品ID", "标题", "正文", "作者", "作者ID", "点赞", "收藏", "评论", "分享", "播放", "热度分", "发布时间", "采集时间", "链接", "视频下载链接", "原图数量"];

function buildExportRows(items) {
  const rows = items.map((it) => [
    PLATFORM_LABEL[it.platform] || it.platform,
    (it.keywords || []).join("|"),
    it.id,
    it.title,
    it.content || "",
    it.author,
    it.author_id,
    it.stats ? it.stats.likes : 0,
    it.stats ? it.stats.collects : 0,
    it.stats ? it.stats.comments : 0,
    it.stats ? it.stats.shares : 0,
    it.stats ? it.stats.views : 0,
    (it.score || 0).toFixed(1),
    it.post_time || it.time_text || "",
    it.captured_at || it.first_seen || "",
    it.url || "",
    (it.video_urls || [])[0] || "",
    (it.image_urls || []).length,
  ]);
  return rows;
}

// 勾选了就只导出勾选的，否则导出当前列表
function itemsToExport() {
  if (state.checked.size) {
    return state.items.filter((it) => state.checked.has(`${it.platform}:${it.id}`));
  }
  return state.items;
}

function exportFilename(ext) {
  const prefix = state.checked.size ? "smc_勾选" : (state.keywordFilter ? "smc_" + safeName(state.keywordFilter) : "smc_all");
  return prefix + "_" + Date.now() + "." + ext;
}

// ---------- XLSX（手写生成：列宽锁定 customWidth、表头加粗居中、正文自动换行） ----------
function xlsxEscape(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
const XLSX_CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function xlsxCrc32(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ XLSX_CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function xlsxBuildZip(files) {
  const encoder = new TextEncoder();
  const now = new Date();
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : encoder.encode(String(f.data));
    const crc = xlsxCrc32(data);
    const lh = new Uint8Array(30); const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true); dv.setUint16(8, 0, true);
    dv.setUint16(10, dosTime, true); dv.setUint16(12, dosDate, true); dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true); dv.setUint16(26, nameBytes.length, true); dv.setUint16(28, 0, true);
    chunks.push(lh, nameBytes, data);
    const ch = new Uint8Array(46); const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true); cdv.setUint16(4, 20, true); cdv.setUint16(6, 20, true); cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true); cdv.setUint16(12, dosTime, true); cdv.setUint16(14, dosDate, true); cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.length, true); cdv.setUint32(24, data.length, true); cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true); cdv.setUint16(32, 0, true); cdv.setUint16(34, 0, true); cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true); cdv.setUint32(42, offset, true);
    central.push({ ch, nameBytes });
    offset += 30 + nameBytes.length + data.length;
  }
  const cdStart = offset; let cdSize = 0;
  for (const c of central) { chunks.push(c.ch, c.nameBytes); cdSize += 46 + c.nameBytes.length; }
  const eocd = new Uint8Array(22); const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, cdStart, true); ev.setUint16(20, 0, true);
  chunks.push(eocd);
  return new Blob(chunks, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function buildXlsxBlob(header, rows, widths, sheetName) {
  const allRows = [header, ...rows];
  let sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lastCol = letters[(header ? header.length : 0) - 1] || "A";
  sheet += `<dimension ref="A1:${lastCol}${allRows.length}"/>`;
  sheet += '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  sheet += '<sheetFormatPr baseColWidth="8" defaultRowHeight="15"/>';
  sheet += "<cols>";
  widths.forEach((w, i) => { sheet += `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`; });
  sheet += "</cols><sheetData>";
  allRows.forEach((row, ri) => {
    const rn = ri + 1;
    // 行高固定 20，正文不换行（表格整齐，长正文点击单元格可看完整）
    sheet += `<row r="${rn}" ht="20" customHeight="1">`;
    row.forEach((cell, ci) => {
      const style = ri === 0 ? ' s="1"' : ""; // 表头：加粗 + 居中
      sheet += `<c r="${letters[ci]}${rn}" t="inlineStr"${style}><is><t xml:space="preserve">${xlsxEscape(cell)}</t></is></c>`;
    });
    sheet += "</row>";
  });
  sheet += "</sheetData></worksheet>";
  const files = {
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + xlsxEscape(sheetName || "导出") + '" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    "xl/styles.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs></styleSheet>',
    "xl/worksheets/sheet1.xml": sheet,
  };
  return xlsxBuildZip(Object.keys(files).map((name) => ({ name, data: files[name] })));
}

function exportXlsxBlob(items) {
  const widths = [8, 16, 12, 32, 60, 12, 16, 10, 10, 10, 10, 10, 10, 20, 20, 44, 40, 10];
  return buildXlsxBlob(EXPORT_HEADER, buildExportRows(items), widths, "素材");
}

const COMMENT_EXPORT_HEADER = ["笔记标题", "笔记链接", "评论内容", "点赞数", "评论时间", "评论者", "是否高赞", "采集时间"];
function buildCommentExportRows(comments) {
  return comments.map((c) => [
    c.note_title || "",
    (c.note_url) || "",
    c.content || "",
    Number(c.like_count) || 0,
    c.create_time ? formatTime(new Date(Number(c.create_time) * 1000).toISOString()) : "",
    c.nickname || "",
    (c.is_hot || (Number(c.like_count) || 0) >= 100) ? "是" : "否",
    formatTime(c.captured_at || ""),
  ]);
}
function exportCommentsXlsxBlob(comments) {
  const widths = [28, 40, 60, 10, 20, 16, 10, 20];
  return buildXlsxBlob(COMMENT_EXPORT_HEADER, buildCommentExportRows(comments), widths, "评论");
}

$("exportXlsxBtn").addEventListener("click", async () => {
  let items = itemsToExport();
  if (!items.length) {
    setStatus(state.checked.size ? "勾选的素材里没有可导出的数据。" : "当前筛选下没有可导出的数据。");
    return;
  }
  let contentWarning = "";
  // 导出前自动补齐缺失正文（素材采集方式不同，正文可能没存上）
  const missing = items.filter((it) => it.url && !(it.content || "").trim());
  if (missing.length) {
    setStatus(`正在补齐正文（${missing.length} 篇，约 ${Math.ceil(missing.length * 3 / 60)} 分钟，请勿关闭弹窗）…`, "status-line running");
    try {
      const resp = await sendMessage({
        type: "SMC_FILL_CONTENT",
        keys: missing.map((it) => `${it.platform}:${it.id}`),
      });
      if (resp && resp.ok) {
        if (resp.blocked) contentWarning = `；小红书要求登录或验证，已停止补齐（${resp.failed} 篇正文为空）。请在网页完成验证后重新导出`;
        else if (resp.failed) contentWarning = `；${resp.failed} 篇正文仍为空（链接过期、已删除或本身无正文）`;
        const r2 = await sendMessage({
          type: "SMC_GET_ITEMS",
          platform: state.platformFilter,
          keyword: state.keywordFilter,
        });
        if (r2 && r2.ok) {
          state.items = r2.items || [];
          items = itemsToExport();
        }
      }
      else { contentWarning = "；正文补齐失败，请重试"; }
    } catch (e) { contentWarning = "；正文补齐中断，请重试"; }
  }
  try {
    const blob = exportXlsxBlob(items);
    const objectUrl = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url: objectUrl, filename: exportFilename("xlsx"), saveAs: true });
      setStatus(`已导出 ${items.length} 条${state.checked.size ? "（勾选）" : "（全部）"} Excel。${contentWarning}`, contentWarning ? "status-line" : "status-line done");
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch (err) {
    setStatus(`导出失败：${err && err.message || err}`);
  }
});

// ===== 在线解析下载（勾选即自动跑：插件调第三方在线去水印服务批量解析，无水印图片/视频按标题分文件夹下载） =====
let lastDlDone = "";

function checkedEntries() {
  return state.items
    .filter((it) => state.checked.has(`${it.platform}:${it.id}`) && it.url)
    .map((it) => ({ key: `${it.platform}:${it.id}`, url: it.url }))
    .slice(0, 300);
}

async function startDl(entries) {
  if (!entries || !entries.length) {
    setStatus("请先勾选要下载的素材，再点「解析下载勾选素材」开始下载。");
    return false;
  }
  const resp = await sendMessage({ type: "SMC_START_DL", entries, concurrency: 3 });
  if (!resp || !resp.ok) {
    setStatus(`无法开始解析：${(resp && resp.error) || "未知错误"}`);
    return false;
  }
  setStatus(`已开始下载 ${entries.length} 条素材…`, "status-line done");
  return true;
}

$("dlBatchBtn").addEventListener("click", async () => {
  const entries = checkedEntries();
  if (!entries.length) {
    setStatus("请先勾选要解析的素材。");
    return;
  }
  await startDl(entries);
});



$("stopDlBtn").addEventListener("click", async () => {
  await sendMessage({ type: "SMC_STOP_DL" });
  setStatus("已停止解析下载。", "status-line done");
});

$("clearItemsBtn").addEventListener("click", async () => {
  if (!confirm("确定清空全部素材？")) return;
  await sendMessage({ type: "SMC_CLEAR_ITEMS" });
  await refreshSummary();
  await refreshItems();
  setStatus("素材已清空。", "status-line done");
});

// 静默采集：后台打开采集页，插件界面保持打开可看进度
$("silentCb") && $("silentCb").addEventListener("change", async (e) => {
  try {
    const st = await new Promise((resolve) => chrome.storage.local.get("smc_settings_v1", resolve));
    const set = (st && st.smc_settings_v1) || {};
    set.silent = e.target.checked;
    await chrome.storage.local.set({ smc_settings_v1: set });
  } catch (err) { /* ignore */ }
});

// 解析模式：极速（SSR直连）/ 稳妥（在线服务）
$("parseModeSelect") && $("parseModeSelect").addEventListener("change", async (e) => {
  const mode = e.target.value === "safe" ? "safe" : "fast";
  try {
    await chrome.storage.local.set({ smc_settings_v1: { parseMode: mode } });
    setStatus(
      mode === "safe"
        ? "已切换为「稳妥」模式。"
        : "已切换为「极速」模式。",
      "status-line done"
    );
  } catch (err) { /* ignore */ }
});

$("itemList").addEventListener("click", async (e) => {
  if (e.target.closest(".note-check")) return; // 勾选不触发展开
  const btn = e.target.closest("button[data-act]");
  if (btn) {
    e.stopPropagation();
    const act = btn.dataset.act;
    const key = btn.dataset.key;
    if (act === "open") await openItem(key);
    else if (act === "copy") await copyItem(key);
    return;
  }
  const card = e.target.closest(".note-card");
  if (card) await openItem(card.dataset.key);
});

$("itemList").addEventListener("change", (e) => {
  const cb = e.target.closest(".note-check");
  if (!cb) return;
  const key = cb.dataset.key;
  if (cb.checked) state.checked.add(key);
  else state.checked.delete(key);
});

$("selectAllCb").addEventListener("change", (e) => {
  const keys = state.items.map((it) => `${it.platform}:${it.id}`);
  if (e.target.checked) keys.forEach((k) => state.checked.add(k));
  else keys.forEach((k) => state.checked.delete(k));
  renderItems();
});

$("keywordFilter").addEventListener("change", (e) => {
  state.keywordFilter = e.target.value;
  refreshItems();
});
$("sortFilter").addEventListener("change", (e) => {
  state.sortFilter = e.target.value;
  renderItems();
});
$("minLikesFilter") && $("minLikesFilter").addEventListener("input", () => renderItems());


$("trendKeyword").addEventListener("change", (e) => {
  state.trendKeyword = e.target.value;
  if (state.trendKeyword) refreshTrend();
});
$("trendRefreshBtn").addEventListener("click", () => refreshTrend());

function switchTab(tab) {
  $("tabCaptureBtn").classList.toggle("active", tab === "capture");
  $("tabLibraryBtn").classList.toggle("active", tab === "library");
  $("tabTrendBtn").classList.toggle("active", tab === "trend");
  $("tabCommentsBtn").classList.toggle("active", tab === "comments");
  $("capturePanel").classList.toggle("hidden", tab !== "capture");
  $("libraryPanel").classList.toggle("hidden", tab !== "library");
  $("trendPanel").classList.toggle("hidden", tab !== "trend");
  $("commentsPanel").classList.toggle("hidden", tab !== "comments");
  // 记住上次停留的页面，重开插件自动回到这里
  try { chrome.storage.local.set({ smc_ui_v1: { lastTab: tab } }); } catch (e) { /* ignore */ }
  if (tab === "trend" && state.trendKeyword) refreshTrend();
}
$("tabCaptureBtn").addEventListener("click", () => switchTab("capture"));
$("tabLibraryBtn").addEventListener("click", () => switchTab("library"));
$("tabTrendBtn").addEventListener("click", () => switchTab("trend"));
$("tabCommentsBtn").addEventListener("click", () => switchTab("comments"));

// 采集页二级分段导航：一屏一屏切换，记住上次选择
(function () {
  const cards = document.querySelectorAll(".capture-card");
  const tabs = document.querySelectorAll(".capture-tab");
  function setCaptureMode(mode) {
    const m = mode || "keyword";
    cards.forEach((c) => c.classList.toggle("hidden", c.getAttribute("data-capture") !== m));
    tabs.forEach((t) => t.classList.toggle("active", t.getAttribute("data-mode") === m));
    try { chrome.storage.local.set({ smc_capture_mode: m }); } catch (e) { /* ignore */ }
  }
  tabs.forEach((t) => t.addEventListener("click", () => setCaptureMode(t.getAttribute("data-mode"))));
  try {
    chrome.storage.local.get("smc_capture_mode", (d) => {
      const m = d && d.smc_capture_mode;
      setCaptureMode(["keyword", "author", "link", "suggest", "comment"].includes(m) ? m : "keyword");
    });
  } catch (e) { /* ignore */ }
})();

// ---------- 任务状态 ----------
function updateTaskBanner() {
  const banner = $("taskBanner");
  if (!banner) return;
  let text = "";
  let mode = "active";
  const job = state.summary && state.summary.job;
  if (job && job.active) {
    if (job.mode === "author") text = `⏳ 博主采集中：「${job.currentKeyword}」，本次新增 ${job.totalCollected} 条`;
    else if (job.mode === "links") text = `🔗 链接采集中：${job.linkIndex + 1}/${job.linkQueue.length}，新增 ${job.totalCollected} 条`;
    else if (job.mode === "suggest") text = `🔤 下拉词采集中：「${job.currentKeyword}」，已得 ${job.totalCollected} 个联想词（${(job.suggestIndex || 0) + 1}/${job.seeds.length} 个种子）`;
    else if (job.mode === "comments") text = `💬 评论采集中：${(job.linkIndex || 0) + 1}/${job.linkQueue.length} 篇，已收 ${job.totalCollected} 条高赞评论`;
    else text = `⏳ 采集中：「${job.currentKeyword}」（${job.comboIndex + 1}/${job.combos.length}），本次新增 ${job.totalCollected} 条`;
  } else if (job && job.finished && job.finishedMessage) {
    text = "✅ " + job.finishedMessage;
    mode = "done";
  }
  banner.textContent = text;
  banner.className = "task-banner " + (text ? mode : "hidden");
}

// ---------- 评论库 ----------
let commentChecked = new Set();
function commentStatus(msg, cls) {
  const el = $("commentsStatus");
  if (el) { el.textContent = msg; el.className = "status-line " + (cls || ""); }
}
function commentKey(c) {
  return `${c.platform || "xhs"}:${c.note_id}:${c.comment_id}`;
}
function commentByKey(key) {
  return (state.comments || []).find((c) => commentKey(c) === key);
}
async function refreshComments() {
  const minLikes = Number($("commentMinLikesFilter") ? $("commentMinLikesFilter").value : 0) || 0;
  const resp = await sendMessage({ type: "SMC_GET_COMMENTS", minLikes });
  state.comments = (resp && resp.ok && resp.comments) || [];
  renderComments();
}
function renderComments() {
  const listEl = $("commentList");
  const list = state.comments || [];
  if (!list.length) {
    listEl.innerHTML = `<div class="empty">暂无评论。</div>`;
    return;
  }
  listEl.innerHTML = list
    .map((c) => {
      const key = commentKey(c);
      const hot = c.is_hot || (Number(c.like_count) || 0) >= 100;
      const t = c.create_time ? formatTime(new Date(Number(c.create_time) * 1000).toISOString()) : "";
      return `
      <div class="comment-card" data-key="${esc(key)}">
        <input type="checkbox" class="comment-check" data-key="${esc(key)}"${commentChecked.has(key) ? " checked" : ""} />
        <div class="comment-main">
          <div class="comment-meta">
            <span class="comment-like">👍 ${Number(c.like_count) || 0}</span>
            ${hot ? `<span class="hot-badge">🔥 高赞</span>` : ""}
            <span class="comment-nick">@${esc(c.nickname || "匿名")}</span>
            <span class="comment-time">${esc(t)}</span>
          </div>
          <div class="comment-content">${esc(c.content || "")}</div>
          <div class="comment-note">📝 ${esc(c.note_title || c.note_id || "未知笔记")} · <a href="#" data-key="${esc(key)}" data-act="open">打开笔记</a></div>
          <div class="actions">
            <button class="mini" data-act="copy" data-key="${esc(key)}">⧉ 复制</button>
          </div>
        </div>
      </div>`;
    })
    .join("");
}
$("commentBtn").addEventListener("click", async () => {
  const raw = $("commentLinksInput").value;
  const links = raw.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (!links.length) { commentStatus("请先粘贴至少一条笔记链接。", ""); return; }
  $("commentBtn").disabled = true;
  try {
    const resp = await sendMessage({
      type: "SMC_START_COMMENTS",
      links,
      minLikes: Number($("commentMinLikesInput").value) || 0,
      maxPerNote: Number($("commentMaxInput").value) || 50,
      foreground: $("silentCb") ? !$("silentCb").checked : false,
    });
    if (resp && resp.ok) commentStatus(`已开始评论采集（${resp.total || links.length} 篇），正在打开笔记…`, "running");
    else commentStatus("启动失败：" + ((resp && resp.error) || "未知错误"), "");
  } finally {
    $("commentBtn").disabled = false;
  }
});
$("commentMinLikesFilter").addEventListener("input", () => refreshComments());
$("exportCommentsBtn").addEventListener("click", async () => {
  const list = commentChecked.size
    ? (state.comments || []).filter((c) => commentChecked.has(commentKey(c)))
    : (state.comments || []);
  if (!list.length) { commentStatus("没有可导出的评论。", ""); return; }
  try {
    const blob = exportCommentsXlsxBlob(list);
    const objectUrl = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url: objectUrl, filename: "smc_评论_" + Date.now() + ".xlsx", saveAs: true });
      commentStatus(`已导出 ${list.length} 条评论 XLSX ✅`, "done");
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch (err) {
    commentStatus("导出失败：" + String(err && err.message || err), "");
  }
});
$("clearCommentsBtn").addEventListener("click", async () => {
  const resp = await sendMessage({ type: "SMC_CLEAR_COMMENTS" });
  commentChecked.clear();
  if ($("selectAllCommentsCb")) $("selectAllCommentsCb").checked = false;
  await refreshComments();
  commentStatus(resp && resp.ok ? "评论已清空。" : "清空失败。", resp && resp.ok ? "done" : "");
});
$("selectAllCommentsCb").addEventListener("change", (e) => {
  const keys = (state.comments || []).map((c) => commentKey(c));
  if (e.target.checked) keys.forEach((k) => commentChecked.add(k));
  else keys.forEach((k) => commentChecked.delete(k));
  renderComments();
});
$("commentList").addEventListener("click", async (e) => {
  if (e.target.closest(".comment-check")) return;
  const btn = e.target.closest("button[data-act]");
  if (btn) {
    e.stopPropagation();
    const act = btn.dataset.act;
    const key = btn.dataset.key;
    if (act === "copy") await copyComment(key);
    else if (act === "open") openCommentNote(key);
    return;
  }
  const link = e.target.closest("a[data-act]");
  if (link) { e.preventDefault(); openCommentNote(link.dataset.key); }
});
$("commentList").addEventListener("change", (e) => {
  const cb = e.target.closest(".comment-check");
  if (!cb) return;
  const key = cb.dataset.key;
  if (cb.checked) commentChecked.add(key);
  else commentChecked.delete(key);
});
async function copyComment(key) {
  const c = commentByKey(key);
  if (!c) return;
  const text = `点赞 ${Number(c.like_count) || 0} · @${c.nickname || "匿名"}\n${c.content || ""}\n${c.note_title || ""}\n${c.note_url || ""}`;
  try {
    await navigator.clipboard.writeText(text);
    commentStatus("已复制该评论 ✅", "done");
  } catch (err) {
    commentStatus("复制失败：" + String(err && err.message || err), "");
  }
}
function openCommentNote(key) {
  const c = commentByKey(key);
  if (!c) return;
  chrome.tabs.create({ url: c.note_url || `https://www.xiaohongshu.com/explore/${c.note_id}`, active: true });
}

// ---------- 下拉词 ----------
async function refreshSuggestWords() {
  const resp = await sendMessage({ type: "SMC_GET_SUGGEST" });
  const words = (resp && resp.ok && resp.words) || [];
  const listEl = $("suggestWordsList");
  if (!listEl) return;
  if (!words.length) {
    $("suggestResult").classList.add("hidden");
    listEl.innerHTML = "";
    return;
  }
  $("suggestResult").classList.remove("hidden");
  listEl.innerHTML = words
    .map((x) => `<span class="chip">${esc(x.word)}</span>`)
    .join("");
}
function suggestStatus(msg, cls) {
  const el = $("suggestStatus");
  if (el) { el.textContent = msg; el.className = "status-line " + (cls || ""); }
}
$("suggestBtn").addEventListener("click", async () => {
  const raw = $("suggestInput").value;
  const seeds = raw.split(/[,，\n;；]+/).map((x) => x.trim()).filter(Boolean);
  if (!seeds.length) {
    suggestStatus("请先输入至少一个种子词。", "");
    return;
  }
  $("suggestBtn").disabled = true;
  try {
    const resp = await sendMessage({
      type: "SMC_START_SUGGEST",
      seeds,
      maxPerSeed: Number($("suggestMaxInput").value) || 20,
      foreground: $("silentCb") ? !$("silentCb").checked : false,
    });
    if (resp && resp.ok) {
      suggestStatus("已开始下拉词采集，正在打开小红书搜索页…", "running");
    } else {
      suggestStatus("启动失败：" + ((resp && resp.error) || "未知错误"), "");
    }
  } finally {
    $("suggestBtn").disabled = false;
  }
});
$("copySuggestBtn").addEventListener("click", async () => {
  const resp = await sendMessage({ type: "SMC_GET_SUGGEST" });
  const words = (resp && resp.ok && resp.words || []).map((x) => x.word).filter(Boolean);
  if (!words.length) { suggestStatus("还没有联想词可复制。", ""); return; }
  try {
    await navigator.clipboard.writeText(words.join("\n"));
    suggestStatus("已复制 " + words.length + " 个联想词 ✅", "done");
  } catch (err) {
    suggestStatus("复制失败：" + String(err && err.message || err), "");
  }
});
$("useSuggestBtn").addEventListener("click", async () => {
  const resp = await sendMessage({ type: "SMC_GET_SUGGEST" });
  const words = (resp && resp.ok && resp.words || []).map((x) => x.word).filter(Boolean);
  if (!words.length) { suggestStatus("还没有联想词可加入。", ""); return; }
  const cur = $("keywordsInput").value.split(/[,，\n;；]+/).map((x) => x.trim()).filter(Boolean);
  const merged = Array.from(new Set(cur.concat(words)));
  $("keywordsInput").value = merged.join("\n");
  suggestStatus("已把 " + words.length + " 个联想词加入「关键词搜索采集」。", "done");
});
$("clearSuggestBtn").addEventListener("click", async () => {
  const resp = await sendMessage({ type: "SMC_CLEAR_SUGGEST" });
  await refreshSuggestWords();
  suggestStatus(resp && resp.ok ? "已清空。" : "清空失败。", resp && resp.ok ? "done" : "");
});

// ---------- 素材库去重 ----------
$("dedupItemsBtn").addEventListener("click", async () => {
  const resp = await sendMessage({ type: "SMC_DEDUP_ITEMS" });
  if (resp && resp.ok) {
    if (resp.removed > 0) {
      setStatus(`去重完成：合并 ${resp.removed} 条重复笔记 ✅`, "status-line done");
    } else {
      setStatus("去重完成：没有发现重复笔记 🎉", "status-line done");
    }
    await refreshItems();
  } else {
    setStatus("去重失败：" + ((resp && resp.error) || "未知错误"), "");
  }
});

// ---------- 初始化 ----------
(async function init() {
  // 读取设置（解析模式 / 前台打开采集页）
  try {
    const st = await new Promise((resolve) => chrome.storage.local.get("smc_settings_v1", resolve));
    const set = (st && st.smc_settings_v1) || {};
    const sel = $("parseModeSelect");
    if (sel) sel.value = set.parseMode === "safe" ? "safe" : "fast";
    const fg = $("silentCb");
    if (fg) fg.checked = set.silent !== false;
  } catch (e) { /* ignore */ }
  loadForm(); // 恢复上次填的内容
  await refreshSummary();
  await refreshItems();
  refreshSuggestWords();
  refreshComments();
  // 恢复到上次停留的页面
  try {
    const ui = await new Promise((resolve) => chrome.storage.local.get("smc_ui_v1", resolve));
    const lastTab = (ui && ui.smc_ui_v1 && ui.smc_ui_v1.lastTab) || "";
    if (["capture", "library", "comments", "trend"].includes(lastTab)) switchTab(lastTab);
  } catch (e) { /* ignore */ }
  setInterval(async () => {
    await refreshSummary();
    updateTaskBanner();
    // 素材解析下载任务状态（在线详情页解析 + 自动下载）
    const dr = await sendMessage({ type: "SMC_GET_DL_JOB" });
    if (dr && dr.ok && dr.job) {
      const dj = dr.job;
      if ($("stopDlBtn")) $("stopDlBtn").disabled = !(dj && dj.active);
      if (dj.active) {
        setStatus(`素材下载中：${dj.done + dj.failed}/${dj.total} 条已处理${dj.failed ? `，${dj.failed} 条失败` : ""}${dj.lastError ? `（${dj.lastError}）` : ""}…`, "status-line running");
      } else if (dj.finished && dj.total > 0 && lastDlDone !== dj.total + ":" + dj.done + ":" + dj.failed) {
        lastDlDone = dj.total + ":" + dj.done + ":" + dj.failed;
        setStatus(`素材下载完成：共 ${dj.total} 条（${dj.done} 条已下载${dj.zipFallback ? `，${dj.zipFallback} 篇已改为单文件下载` : ""}${dj.failed ? `，${dj.failed} 条失败（${dj.lastError || "可勾选重试"}）` : ""}）。`, "status-line done");
      }
    }
    if (state.summary && state.summary.job && !state.summary.job.active) {
      await refreshItems();
      if (!$("trendPanel").classList.contains("hidden") && state.trendKeyword) refreshTrend();
      if (state.summary.job.finished && state.summary.job.mode === "suggest") refreshSuggestWords();
      if (state.summary.job.mode === "comments") refreshComments();
    }
  }, 2000);
})();
