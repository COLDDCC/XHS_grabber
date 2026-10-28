// background.js — 社媒采集助手 · 后台服务工作线程
// 职责：接收页面抓取数据 → 按「平台:作品ID」去重入库(chrome.storage.local) →
// 记录互动快照 → 管理关键词搜索任务（平台×关键词依次开标签页）→
// 管理「在线解析下载」任务：把勾选素材的链接批量发给第三方在线去水印服务
// （xhs-download.online，免登录）解析出无水印图片/视频，再并发自动下载，按标题分文件夹。
"use strict";

const STORAGE_KEYS = {
  items: "smc_items_v1",
  keywords: "smc_keywords_v1",
  history: "smc_history_v1",
  snapshots: "smc_snapshots_v1",
  suggest: "smc_suggest_words_v1",
  comments: "smc_comments_v1",
  job: "smc_job_v1",
};

const TIMEOUT_ALARM = "smc_timeout";
const COMBO_TIMEOUT_MINUTES = 4;   // 单个 平台×关键词 的最长等待
const SNAPSHOT_LIMIT = 6000;
const HISTORY_LIMIT = 1000;
const DL_ALARM = "smc_dl_timeout";
const DL_TIMEOUT_MINUTES = 2;      // 单个链接解析的最长等待
const DL_CONCURRENCY = 4;          // 并发解析数（打包接口更稳；如被在线站限流可调回 3）
const DL_BASE_DIR = "小红书素材";   // 素材下载根目录（按笔记标题分文件夹）

// 在线去水印解析服务（第三方，免登录；返回 code/title/imgList/videoList/coverImage）
const ONLINE_API = "https://www.xhs-download.online/xhs-download-api";
const ONLINE_BATCH_API = "https://www.xhs-download.online/batch-xhs-download-api";
const DL_BATCH_PARSE = 5;        // 批量解析：一次请求解析 5 篇

const PLATFORMS = {
  xhs: { label: "小红书", urlPrefix: "https://www.xiaohongshu.com" },
};

const job = {
  mode: null, // 'search'
  active: false,
  // 搜索任务
  platforms: [],
  keywords: [],
  combos: [],
  comboIndex: -1,
  currentPlatform: "",
  currentKeyword: "",
  sort: "general",
  timeRangeSec: 0,
  typeFilter: "",
  maxPerKeyword: 150,
  minLikes: 0,
  minCollects: 0,
  minComments: 0,
  delaySec: 5,   // 每个页面之间的等待秒数（防风控）
  foreground: true, // 前台打开采集页（避免后台节流导致采集不全/卡住）
  linkQueue: [],
  linkIndex: -1,
  // 公共
  currentTabId: null,
  totalCollected: 0,
  startedAt: "",
  finished: false,
  finishedMessage: "",
};

const dl = {
  active: false,
  queue: [],       // [{ key, url }]
  current: 0,
  concurrency: DL_CONCURRENCY,
  inFlight: 0,     // 正在解析的数量（同步计数，限制并发）
  finished: false,
  total: 0,
  done: 0,         // 解析成功并触发下载
  failed: 0,       // 解析失败（在线服务取不到素材）
  doneKeys: {},    // 已处理的 key，防止重复触发
  lastError: "",          // 最近一条失败原因（便于弹窗提示）
  lastParser: "",         // 最近成功的解析接口名
  lastDownloadError: "",  // 最近一次下载失败的具体报错
  zipFallback: 0,         // 打包失败转为单文件下载的篇数
  lastZipError: "",       // 最近一次打包失败的报错
  parseMode: "fast",      // fast=极速(SSR直连优先) | safe=稳妥(在线服务优先)
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 存储 ----------
async function readAll() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.items,
    STORAGE_KEYS.keywords,
    STORAGE_KEYS.history,
    STORAGE_KEYS.snapshots,
    STORAGE_KEYS.suggest,
    STORAGE_KEYS.comments,
  ]);
  return {
    items: data[STORAGE_KEYS.items] || {},
    keywords: data[STORAGE_KEYS.keywords] || {},
    history: data[STORAGE_KEYS.history] || [],
    snapshots: data[STORAGE_KEYS.snapshots] || [],
    suggestWords: data[STORAGE_KEYS.suggest] || [],
    comments: data[STORAGE_KEYS.comments] || {},
  };
}

async function persistAll(items, keywords, history, snapshots) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.items]: items,
    [STORAGE_KEYS.keywords]: keywords,
    [STORAGE_KEYS.history]: history,
    [STORAGE_KEYS.snapshots]: snapshots,
  });
}

async function persistJob() {
  await chrome.storage.local.set({ [STORAGE_KEYS.job]: job });
}

// 保存评论（按 平台:笔记:评论 去重）
async function saveComments(entries) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.comments);
  const store = data[STORAGE_KEYS.comments] || {};
  let added = 0;
  (Array.isArray(entries) ? entries : []).forEach((c) => {
    if (!c || !c.comment_id || !c.note_id) return;
    const key = `${c.platform || "xhs"}:${c.note_id}:${c.comment_id}`;
    if (store[key]) return; // 已存在不覆盖
    store[key] = c;
    added += 1;
  });
  await chrome.storage.local.set({ [STORAGE_KEYS.comments]: store });
  return added;
}

// 保存下拉词（去重追加）
async function saveSuggestWords(words) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.suggest);
  const prev = data[STORAGE_KEYS.suggest] || [];
  const seen = new Set(prev.map((x) => x && x.word));
  const now = new Date().toISOString();
  (Array.isArray(words) ? words : []).forEach((w) => {
    w = String(w || "").trim();
    if (!w || seen.has(w)) return;
    seen.add(w);
    prev.push({ word: w, at: now });
  });
  await chrome.storage.local.set({ [STORAGE_KEYS.suggest]: prev });
  return prev;
}

// ---------- URL ----------
function buildSearchUrl(platform, keyword, sort, timeRangeSec) {
  if (platform === "xhs") {
    const params = new URLSearchParams();
    params.set("keyword", keyword);
    params.set("source", "web_search_result_notes");
    if (sort && sort !== "general") params.set("sort", sort);
    if (timeRangeSec && timeRangeSec > 0) params.set("time", String(timeRangeSec));
    return `https://www.xiaohongshu.com/search_result?${params.toString()}`;
  }
  return "";
}

// ---------- 入库 ----------
function appendSnapshot(snapshots, entry) {
  snapshots.push(entry);
  if (snapshots.length > SNAPSHOT_LIMIT) {
    snapshots.splice(0, snapshots.length - SNAPSHOT_LIMIT);
  }
}

async function mergeItems(items, keyword, platform, sourceType) {
  const { items: store, keywords, history, snapshots } = await readAll();
  const now = new Date().toISOString();
  let added = 0;
  for (const raw of items) {
    if (!raw || !raw.id || !raw.platform) continue;
    const p = raw.platform || platform;
    if (!p) continue;
    const key = `${p}:${raw.id}`;
    const existing = store[key];
    const item = {
      platform: p,
      id: String(raw.id),
      type: String(raw.type || "normal"),
      title: raw.title || "无标题",
      content: raw.content || "",
      author: raw.author || "未知用户",
      author_id: raw.author_id || "",
      author_avatar: raw.author_avatar || "",
      cover_url: raw.cover_url || "",
      image_urls: Array.isArray(raw.image_urls) ? raw.image_urls.slice(0, 30) : [],
      video_urls: Array.isArray(raw.video_urls) ? raw.video_urls.slice(0, 5) : [],
      stats: Object.assign(
        { likes: 0, collects: 0, comments: 0, shares: 0, views: 0 },
        raw.stats || {}
      ),
      post_time: raw.post_time || "",
      time_text: raw.time_text || "",
      url: raw.url || "",
      score: Number(raw.score) || 0,
      source: raw.source || sourceType || "search",
      keywords: [],
      first_seen: now,
      last_seen: now,
      captured_at: now,
    };
    let kw = keyword || "";
    if (sourceType === "author_feed" && !kw && item.author) kw = "@" + item.author;
    if (kw) kw = String(kw).trim();

    if (!existing) {
      if (kw) item.keywords = [kw];
      store[key] = item;
      added += 1;
      appendSnapshot(snapshots, {
        key,
        platform: p,
        keyword: kw,
        liked_count: item.stats.likes,
        collected_count: item.stats.collects,
        comment_count: item.stats.comments,
        share_count: item.stats.shares,
        at: now,
      });
    } else {
      const changed =
        (existing.stats.likes || 0) !== item.stats.likes ||
        (existing.stats.collects || 0) !== item.stats.collects ||
        (existing.stats.comments || 0) !== item.stats.comments ||
        (existing.stats.shares || 0) !== item.stats.shares;
      existing.keywords = existing.keywords || [];
      if (kw && !existing.keywords.includes(kw)) existing.keywords.push(kw);
      if (raw.type) existing.type = String(raw.type);
      existing.stats = item.stats;
      existing.score = item.score;
      existing.last_seen = now;
      if (item.cover_url) existing.cover_url = item.cover_url;
      if (item.title && item.title !== "无标题") existing.title = item.title;
      if (item.content) existing.content = item.content;
      if (item.url) existing.url = item.url;
      if (item.video_urls.length) existing.video_urls = item.video_urls;
      if (item.image_urls.length) existing.image_urls = item.image_urls;
      if (item.author && item.author !== "未知用户") existing.author = item.author;
      if (item.post_time) existing.post_time = item.post_time;
      if (changed) {
        appendSnapshot(snapshots, {
          key,
          platform: p,
          keyword: kw,
          liked_count: existing.stats.likes,
          collected_count: existing.stats.collects,
          comment_count: existing.stats.comments,
          share_count: existing.stats.shares,
          at: now,
        });
      }
    }
  }
  if (added > 0 && keyword) {
    history.unshift({ keyword, platform, added, at: now });
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  }
  await persistAll(store, keywords, history, snapshots);
  return added;
}

async function refreshKeywordIndex() {
  const { items, keywords, history, snapshots } = await readAll();
  const now = new Date().toISOString();
  const allKeywords = new Set();
  Object.values(items).forEach((it) => {
    (it.keywords || []).forEach((k) => allKeywords.add(k));
  });
  allKeywords.forEach((k) => {
    const prev = keywords[k] || { count: 0, last_seen: "" };
    keywords[k] = {
      count: Object.values(items).filter((it) => (it.keywords || []).includes(k)).length,
      last_seen: prev.last_seen || now,
    };
  });
  await persistAll(items, keywords, history, snapshots);
}

// ---------- 任务调度 ----------
async function sendToTabRetry(tabId, message, attempts = 24) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch (err) {
      await sleep(500);
    }
  }
  return false;
}

function scheduleTimeout(minutes) {
  chrome.alarms.create(TIMEOUT_ALARM, { delayInMinutes: minutes });
}

async function clearTimeoutAlarm() {
  await chrome.alarms.clear(TIMEOUT_ALARM);
}

async function finishJob(message) {
  if (!job.active) return;
  job.active = false;
  job.finished = true;
  job.finishedMessage = message || "采集完成";
  job.currentKeyword = "";
  job.currentTabId = null;
  await persistJob();
  await clearTimeoutAlarm();
  await refreshKeywordIndex();
}

async function stopJob(message) {
  job.active = false;
  job.finished = true;
  job.finishedMessage = message || "已手动停止采集";
  if (job.currentTabId != null) {
    try {
      await chrome.tabs.sendMessage(job.currentTabId, { type: "SMC_STOP" });
    } catch (err) { /* 忽略 */ }
  }
  job.currentTabId = null;
  await persistJob();
  await clearTimeoutAlarm();
  await refreshKeywordIndex();
}

// ---------- 在线解析下载（第三方在线服务，免登录，批量并发） ----------
function safeName(s) {
  return String(s || "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "untitled";
}

function imageExt(url) {
  const m = String(url || "").split("?")[0].split("!")[0].match(/\.(jpe?g|png|webp|gif|avif)$/i);
  return m ? m[1].toLowerCase() : "jpg";
}

// 把小红书 webp 缩略链接转成 sns-img-bd 原图 PNG 直链（3571x5052 级原图，可预览）
function toOriginalImageUrl(url) {
  if (!url) return "";
  let u = String(url).trim();
  try {
    const pu = new URL(u);
    if (/downloader-api\.bhwa233\.com/.test(pu.hostname) && pu.searchParams.get("url")) {
      u = pu.searchParams.get("url"); // 在线代理里解出真实 xhscdn 地址
    }
  } catch (e) { /* ignore */ }
  u = String(u).split("!")[0]; // 去掉 ! 变换后缀
  try {
    const p = new URL(u);
    if (/xhscdn\.com$/.test(p.hostname)) {
      let path = p.pathname.replace(/^\//, "");
      // 去掉开头的 时间戳/哈希 前缀（如 202608261443/xxxx32hex/）
      path = path.replace(/^\d{10,14}\/[0-9a-f]{32}\//, "");
      if (path && !/\s/.test(path) && path.length > 3) {
        return "https://sns-img-bd.xhscdn.com/" + path;
      }
    }
  } catch (e) { /* ignore */ }
  return "";
}

// 统一解析图片下载地址：优先原图 PNG，失败回退原 webp（用正确扩展名保证可预览）
function resolveImageUrl(u) {
  const orig = toOriginalImageUrl(u);
  if (orig) return { url: orig, ext: "png" };
  return { url: String(u), ext: imageExt(u) === "webp" ? "webp" : imageExt(u) };
}

async function persistDl() {
  await chrome.storage.local.set({ smc_dl_job_v1: dl });
}

// ---------- 多接口解析（按顺序轮询，哪个能用就用哪个） ----------
function hasMedia(obj) {
  return !!(
    obj &&
    ((Array.isArray(obj.imgList) && obj.imgList.length) ||
      (Array.isArray(obj.videoList) && obj.videoList.length) ||
      obj.coverImage)
  );
}

// 接口 2：wanyi-watermark 的匿名 SSR 解析方式（第三方开源项目，不碰你的账号）：
// 直接抓取笔记页 HTML，从 window.__INITIAL_STATE__ 提取 noteDetailMap 的图片/视频直链。
function parseXhsSsr(html, url) {
  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*(?:;\s*)?<\/script>/s);
  let state = null;
  if (m) {
    try {
      let jsonStr = m[1];
      jsonStr = jsonStr.replace(/:\s*undefined\s*([,}])/g, ": null$1");
      state = JSON.parse(jsonStr);
    } catch (e) { /* ignore */ }
  }
  if (!state) return null;
  const noteMap = ((state.note || {}).noteDetailMap) || {};
  const keys = Object.keys(noteMap);
  if (!keys.length) return null;
  let note = null;
  // 优先按 URL 里的 noteId 精确匹配
  const idm = String(url || "").match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/);
  if (idm) {
    if (!noteMap[idm[1]]) return null;
    note = noteMap[idm[1]].note;
  } else note = noteMap[keys[0]].note;
  if (!note) return null;

  const title = (note.title || "xhs").trim();
  const toHttps = (u) => {
    const s = String(u || "").trim();
    return s.startsWith("http://") ? "https://" + s.slice(7) : s;
  };
  const imgList = [];
  const imageList = Array.isArray(note.imageList) ? note.imageList : [];
  imageList.forEach((img) => {
    if (!img) return;
    let u = "";
    if (Array.isArray(img.infoList)) {
      const wb = img.infoList.find((i) => i && i.imageScene === "WB_DFT");
      if (wb && wb.url) u = wb.url;
    }
    if (!u) u = img.urlDefault || img.url || "";
    if (u) imgList.push(toHttps(u));
  });
  const videoList = [];
  const stream = ((note.video || {}).media || {}).stream || {};
  const h264 = Array.isArray(stream.h264) ? stream.h264 : [];
  const v = h264[0];
  if (v) {
    if (v.masterUrl) videoList.push(toHttps(v.masterUrl));
    (Array.isArray(v.backupUrls) ? v.backupUrls : []).forEach((u) => { if (u && !videoList.includes(toHttps(u))) videoList.push(toHttps(u)); });
  }
  const coverImage = imgList[0] || "";
  return {
    code: 0,
    title,
    content: String(note.desc || note.description || ""),
    type: String(note.type || ""),
    imgList,
    videoList,
    coverImage,
  };
}

async function fetchWanyiSsr(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": "https://www.xiaohongshu.com/",
      },
    });
    if (!resp || !resp.ok) return null;
    const html = await resp.text();
    return parseXhsSsr(html, resp.url || url);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 按顺序轮询所有解析接口，返回第一个有素材的结果，并带上各接口明细
async function parseWithFallback(url, purpose = "media") {
  const parsers = dl.parseMode === "safe"
    ? [
        { name: "xhs-download.online", fn: fetchOnlineParse },
        { name: "wanyi匿名SSR", fn: fetchWanyiSsr },
      ]
    : [
        { name: "wanyi匿名SSR", fn: fetchWanyiSsr },
        { name: "xhs-download.online", fn: fetchOnlineParse },
      ];
  let last = null;
  const detail = [];
  for (const p of parsers) {
    let obj = null;
    try {
      obj = await p.fn(url);
    } catch (e) { /* ignore */ }
    if (purpose === "content" ? !!String(obj && (obj.content || obj.desc) || "").trim() : hasMedia(obj)) {
      detail.push(`${p.name}:成功`);
      return { obj, parser: p.name, detail: detail.join("；") };
    }
    if (obj) {
      last = { obj, parser: p.name };
      detail.push(`${p.name}:返回空`);
    } else {
      detail.push(`${p.name}:请求失败`);
    }
  }
  return { obj: last ? last.obj : null, parser: last ? last.parser : "", detail: detail.join("；") };
}

// 调在线去水印服务解析单个链接；返回 {code,title,imgList,videoList,coverImage} 或 null
async function fetchOnlineParse(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(ONLINE_API + "?url=" + encodeURIComponent(url), {
      signal: controller.signal,
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.xhs-download.online/",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
    });
    if (!resp || !resp.ok) return null;
    const j = await resp.json();
    if (!j || typeof j.data !== "string") return null;
    const inner = JSON.parse(j.data);       // {data:"{...}"}
    const obj = JSON.parse(inner.data);     // {code,title,imgList,videoList,coverImage}
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 探测资源 Content-Type（用于跳过图文笔记被在线接口误报的"伪视频"链接）
async function probeContentType(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(url, { method: "HEAD", signal: controller.signal });
      return String(resp.headers.get("content-type") || "").toLowerCase() || null;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return null;
  }
}

async function downloadMaterial(url, filename) {
  // 依次尝试三种参数组合，哪种能出下载ID用哪种；都失败则记录精确报错
  const attempts = [
    { opts: { url, filename, conflictAction: "uniquify" }, label: "完整参数" },
    { opts: { url, filename }, label: "无冲突策略" },
    { opts: { url }, label: "默认文件名" },
  ];
  for (const a of attempts) {
    try {
      if (!chrome.downloads || !chrome.downloads.download) {
        dl.lastDownloadError = "缺少 downloads 权限，请删除扩展后重新加载";
        return false;
      }
      const id = await chrome.downloads.download(a.opts);
      if (id !== undefined && id !== null) return true;
      dl.lastDownloadError = `下载API(${a.label})未返回下载ID`;
    } catch (e) {
      dl.lastDownloadError = `下载API(${a.label})报错：${String((e && e.message) || e)}`;
    }
  }
  return false;
}

// ---------- 打包下载（每篇笔记一个 zip，减少请求数） ----------
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// 用在线站的打包接口把图片（封面+内页图，去重）合成 zip，返回 data URL；失败返回 null
async function buildNoteZip(obj, baseName) {
  const seen = new Set();
  const cover = obj && obj.coverImage;
  const rawImgs = obj && Array.isArray(obj.imgList) ? obj.imgList : [];
  const imgs = rawImgs.filter((u) => {
    if (!u) return false;
    const k = String(u);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const files = [];
  const coverInImgs = cover && imgs.some((u) => String(u) === String(cover));
  if (cover && !coverInImgs) {
    files.push({ url: cover, path: `${baseName}/封面.${imageExt(cover)}` });
  }
  imgs.slice(0, 40).forEach((u, i) => {
    files.push({ url: u, path: `${baseName}/图_${String(i + 1).padStart(2, "0")}.${imageExt(u)}` });
  });
  if (!files.length) return null;
  const ZIP_API = "https://www.xhs-download.online/batch-xhs-download-zip";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(2000 + attempt * 1000); // 重试前稍等
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const resp = await fetch(ZIP_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
        signal: controller.signal,
      });
      if (!resp || !resp.ok) {
        dl.lastZipError = `打包接口 HTTP ${resp && resp.status}`;
        continue;
      }
      const buf = await resp.arrayBuffer();
      if (!buf || !buf.byteLength) {
        dl.lastZipError = "打包接口返回空";
        continue;
      }
      dl.lastZipError = "";
      return "data:application/zip;base64," + arrayBufferToBase64(buf);
    } catch (e) {
      dl.lastZipError = `打包请求失败：${String((e && e.message) || e)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// 判断笔记是否有真实视频（图文笔记被在线接口误报的"视频"链接会返回图片，跳过）
async function pickRealVideoUrl(obj) {
  const vids = obj && Array.isArray(obj.videoList) ? obj.videoList.filter((u) => u && !/^blob:/.test(u)) : [];
  if (!vids.length) return null;
  if (obj.type === "video") return vids[0]; // SSR 已确认真实视频
  const ct = await probeContentType(vids[0]);
  if (ct && ct.startsWith("image/")) return null; // 伪视频
  return vids[0];
}

// 兜底：逐文件下载（打包接口不可用时的降级方案）
async function downloadItemFiles(obj, stored, baseName, base) {
  const files = [];
  const seenUrls = new Set();
  const cover = obj && obj.coverImage;
  const rawImgs = obj && Array.isArray(obj.imgList) ? obj.imgList : [];
  const imgs = rawImgs.filter((u) => {
    if (!u) return false;
    const k = String(u);
    if (seenUrls.has(k)) return false;
    seenUrls.add(k);
    return true;
  });
  const coverInImgs = cover && imgs.some((u) => String(u) === String(cover));
  if (cover && !coverInImgs) {
    const r = resolveImageUrl(cover);
    files.push({ url: r.url, name: `${base}/${baseName}_封面.${r.ext}` });
  }
  imgs.slice(0, 30).forEach((u, i) => {
    const r = resolveImageUrl(u);
    files.push({ url: r.url, name: `${base}/${baseName}_${String(i + 1).padStart(2, "0")}.${r.ext}` });
  });
  if (!files.length && stored) {
    (stored.image_urls || []).slice(0, 30).forEach((u, i) => {
      if (!u) return;
      const k = String(u);
      if (seenUrls.has(k)) return;
      seenUrls.add(k);
      files.push({ url: u, name: `${base}/${baseName}_${String(i + 1).padStart(2, "0")}.${imageExt(u)}` });
    });
  }
  const results = await Promise.all(files.map((f) => downloadMaterial(f.url, f.name)));
  return results.filter(Boolean).length;
}

// 解析并下载单个素材：图片打包成 zip（每篇一个），视频单独下载
// SSR 直连解析并发信号量（限制同时直连小红书页面的数量，防风控）
function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active += 1;
    const fn = queue.shift();
    fn().finally(() => { active -= 1; next(); });
  };
  return (fn) => new Promise((resolve) => {
    queue.push(() => fn().then(resolve, resolve));
    next();
  });
}
const ssrLimiter = createSemaphore(6);
const imageLimiter = createSemaphore(10); // 全局图片抓取并发上限

// ---------- 批量解析（5 篇一次请求，减少请求数） ----------
async function fetchOnlineBatch(urls) {
  const list = urls.slice(0, DL_BATCH_PARSE);
  if (!list.length) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const resp = await fetch(ONLINE_BATCH_API + "?url=" + encodeURIComponent(list.join(";")), {
      signal: controller.signal,
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.xhs-download.online/",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
    });
    if (!resp || !resp.ok) return null;
    const j = await resp.json();
    if (!j || !Array.isArray(j.data)) return null;
    return j.data.map((item) => {
      try {
        const inner = JSON.parse(item);
        const obj = JSON.parse(inner.data);
        return obj && typeof obj === "object" ? obj : null;
      } catch (e) { return null; }
    });
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 本地打包 zip（store 模式，无压缩，快） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// 把一组 {name, data:ArrayBuffer} 组装成 zip（store 模式）
function buildStoreZip(files) {
  const encoder = new TextEncoder();
  const now = new Date();
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const data = new Uint8Array(f.data);
    const crc = crc32(data);
    const lh = new Uint8Array(30);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true); // store
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    chunks.push(lh, nameBytes, data);
    const ch = new Uint8Array(46);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, dosTime, true);
    cdv.setUint16(14, dosDate, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.length, true);
    cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    central.push({ ch, nameBytes });
    offset += 30 + nameBytes.length + data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    chunks.push(c.ch, c.nameBytes);
    cdSize += 46 + c.nameBytes.length;
  }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, 0, true);
  chunks.push(eocd);
  return new Blob(chunks, { type: "application/zip" });
}

// 收集一篇笔记的图片（封面+内页图，去重），给出 zip 内路径
function collectImageEntries(obj, baseName) {
  const seen = new Set();
  const out = [];
  const cover = obj && obj.coverImage;
  const rawImgs = obj && Array.isArray(obj.imgList) ? obj.imgList : [];
  const imgs = rawImgs.filter((u) => {
    if (!u) return false;
    const k = String(u);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const coverInImgs = cover && imgs.some((u) => String(u) === String(cover));
  if (cover && !coverInImgs) {
    const r = resolveImageUrl(cover);
    out.push({ url: r.url, name: `${baseName}/封面.${r.ext}` });
  }
  imgs.slice(0, 40).forEach((u, i) => {
    const r = resolveImageUrl(u);
    out.push({ url: r.url, name: `${baseName}/图_${String(i + 1).padStart(2, "0")}.${r.ext}` });
  });
  return out;
}

// 限并发抓图（每篇最多 8 路并行，避免一次太多请求）
async function fetchImagesWithLimit(entries, limit) {
  const out = new Array(entries.length);
  let idx = 0;
  const worker = async () => {
    while (idx < entries.length) {
      const i = idx;
      idx += 1;
      try {
        await imageLimiter(async () => {
          const resp = await fetch(entries[i].url);
          if (resp && resp.ok) {
            const buf = await resp.arrayBuffer();
            if (buf && buf.byteLength) out[i] = { name: entries[i].name, data: buf };
          }
        });
      } catch (e) { /* ignore */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));
  return out.filter(Boolean);
}

// 本地并行抓图 + 本地打包 zip，返回 data URL；失败返回 null
async function buildLocalZip(obj, baseName) {
  const imageEntries = collectImageEntries(obj, baseName);
  if (!imageEntries.length) return null;
  const files = await fetchImagesWithLimit(imageEntries, 8);
  if (!files.length) return null;
  try {
    const zipBlob = buildStoreZip(files);
    const buf = await zipBlob.arrayBuffer();
    return "data:application/zip;base64," + arrayBufferToBase64(buf);
  } catch (e) {
    return null;
  }
}

// 下载单个素材（已解析好 obj；zip 优先本地打包，失败退服务器打包，再退逐文件）
async function processDownloadEntry(entry, parsed) {
  let obj = parsed.obj;
  const { items } = await readAll();
  let stored = items[entry.key];
  const fromCache = !!(parsed && parsed.fromCache);
  // 没有在线解析结果时，用库存里缓存的图片链接（已解析过 → 秒下）
  if (!hasMedia(obj) && stored && Array.isArray(stored.image_urls) && stored.image_urls.length) {
    obj = {
      title: stored.title || "",
      coverImage: stored.cover_url || "",
      imgList: stored.image_urls,
      videoList: stored.video_urls || [],
      type: stored.type || "",
    };
  }
  const title = (obj && obj.title) || (stored && stored.title) || entry.key;
  const baseName = safeName(title);
  const base = DL_BASE_DIR + "/" + baseName;

  const first = await doDownloadEntry(entry, obj, stored, baseName, base);
  let ok = first.ok;
  // 缓存数据失效（如链接过期）→ 重新解析再试一次
  if (!ok && fromCache) {
    const reparsed = await parseWithFallback(entry.url);
    if (hasMedia(reparsed.obj)) {
      const second = await doDownloadEntry(entry, reparsed.obj, stored, baseName, base);
      ok = second.ok;
      obj = reparsed.obj;
      if (reparsed.parser) dl.lastParser = reparsed.parser;
    }
  }
  if (!ok) { /* 继续走下面的错误判断 */ }
  return finishDownloadEntry(entry, parsed, obj, stored, baseName, base, ok);
}

// 实际下载：zip 优先本地打包，失败退服务器打包，再退逐文件
async function doDownloadEntry(entry, obj, stored, baseName, base) {
  let zipOk = false;
  let videoOk = false;
  if (hasMedia(obj)) {
    // 1) 本地并行抓图 + 本地打包（快）
    let zipDataUrl = await buildLocalZip(obj, baseName);
    if (!zipDataUrl) {
      zipDataUrl = await buildNoteZip(obj, baseName); // 2) 服务器打包兜底
    }
    if (zipDataUrl) {
      zipOk = await downloadMaterial(zipDataUrl, `${DL_BASE_DIR}/${baseName}.zip`);
    }
    // 3) 真实视频单独下载（图文笔记的伪视频会被类型校验跳过）
    const v = await pickRealVideoUrl(obj);
    if (v) {
      videoOk = await downloadMaterial(v, `${base}/${baseName}_视频.mp4`);
    }
  }
  // 4) 打包没成功 → 必须退回逐文件下载图片，保证不丢图
  let filesOk = 0;
  if (!zipOk) {
    filesOk = await downloadItemFiles(hasMedia(obj) ? obj : null, stored, baseName, base);
    if (hasMedia(obj)) dl.zipFallback += 1;
  }
  return { ok: zipOk || videoOk || filesOk > 0 };
}

// 收尾：回写库存 + 错误信息
async function finishDownloadEntry(entry, parsed, obj, stored, baseName, base, ok) {
  if (stored && obj && (obj.imgList || obj.videoList || obj.coverImage || obj.title)) {
    const updated = Object.assign({}, stored);
    // 缓存存「原图直链」（sns-img-bd，不带时间戳、不过期），重复下载走缓存秒下且不会失效
    if (Array.isArray(obj.imgList) && obj.imgList.length) {
      updated.image_urls = obj.imgList.slice(0, 30).map((u) => toOriginalImageUrl(u) || u);
    }
    if (Array.isArray(obj.videoList) && obj.videoList.length) updated.video_urls = obj.videoList.slice(0, 5);
    if (obj.coverImage) updated.cover_url = toOriginalImageUrl(obj.coverImage) || obj.coverImage;
    if (obj.title) updated.title = obj.title;
    if (obj.content) updated.content = obj.content;
    updated.last_seen = new Date().toISOString();
    const all = await readAll();
    all.items[entry.key] = updated;
    await persistAll(all.items, all.keywords, all.history, all.snapshots);
  }
  if (ok > 0) {
    if (parsed.parser) dl.lastParser = parsed.parser;
  } else if (!hasMedia(obj)) {
    dl.lastError = "素材获取失败（可能需登录/链接失效）";
  } else {
    dl.lastError = `已获取素材但下载失败：${dl.lastDownloadError || "网络或浏览器异常"}（可重试）`;
  }
  return ok > 0;
}

// 处理一批（≤5 篇）：批量解析一次 → 逐篇下载
async function processDlBatch(batch) {
  const entries = batch.filter((e) => !dl.doneKeys[e.key]);
  if (!entries.length) return;
  const parsedMap = {};
  const allItems = (await readAll()).items || {};
  // 0) 已解析过的笔记直接用缓存图片链接（跳过解析 → 秒下）；缓存失效会自动重新解析
  const cachedKeys = entries.filter((e) => {
    const it = allItems[e.key];
    return it && Array.isArray(it.image_urls) && it.image_urls.length > 0;
  });
  cachedKeys.forEach((e) => { parsedMap[e.key] = { obj: null, parser: "缓存", fromCache: true }; });
  const ssrFirst = dl.parseMode !== "safe";
  const toParse = entries.filter((e) => !parsedMap[e.key]);
  // 1) 首选来源（fast=SSR 直连，~1秒/篇；safe=在线批量，~10秒/篇）
  if (ssrFirst) {
    await Promise.all(toParse.map((e) => ssrLimiter(async () => {
      const obj = await fetchWanyiSsr(e.url);
      if (hasMedia(obj)) parsedMap[e.key] = { obj, parser: "wanyi匿名SSR" };
    })));
  } else {
    const batchResults = await fetchOnlineBatch(toParse.map((e) => e.url));
    if (batchResults && batchResults.length) {
      toParse.forEach((e, i) => {
        const obj = batchResults[i];
        if (hasMedia(obj)) parsedMap[e.key] = { obj, parser: "xhs-download.online批量" };
      });
    }
  }
  // 2) 没解析到的用另一个来源补
  const needOther = toParse.filter((e) => !parsedMap[e.key]);
  if (needOther.length) {
    if (ssrFirst) {
      const batchResults = await fetchOnlineBatch(needOther.map((e) => e.url));
      if (batchResults && batchResults.length) {
        needOther.forEach((e, i) => {
          const obj = batchResults[i];
          if (hasMedia(obj)) parsedMap[e.key] = { obj, parser: "xhs-download.online批量" };
        });
      }
    } else {
      await Promise.all(needOther.map((e) => ssrLimiter(async () => {
        const obj = await fetchWanyiSsr(e.url);
        if (hasMedia(obj)) parsedMap[e.key] = { obj, parser: "wanyi匿名SSR" };
      })));
    }
  }
  // 3) 仍失败的逐篇兜底
  for (const e of entries) {
    if (parsedMap[e.key]) continue;
    parsedMap[e.key] = await parseWithFallback(e.url);
  }
  // 3) 批内并行下载（全局图片并发已限流，安全）
  await Promise.all(entries.map(async (e) => {
    if (dl.doneKeys[e.key]) return;
    dl.doneKeys[e.key] = true;
    const parsed = parsedMap[e.key] || { obj: null, parser: "", detail: "" };
    let ok = false;
    try {
      ok = await processDownloadEntry(e, parsed);
    } catch (err) { /* ignore */ }
    if (ok) dl.done += 1;
    else dl.failed += 1;
  }));
}

function spawnDl() {
  while (dl.active && dl.inFlight < dl.concurrency && dl.current < dl.queue.length) {
    const batch = dl.queue.slice(dl.current, dl.current + DL_BATCH_PARSE);
    dl.current += batch.length;
    dl.inFlight += 1;
    (async () => {
      try {
        await processDlBatch(batch);
      } catch (e) { /* ignore */ }
      dl.inFlight -= 1;
      await persistDl();
      spawnDl();
    })();
  }
  if (dl.active && dl.current >= dl.queue.length && dl.inFlight === 0) {
    dl.active = false;
    dl.finished = true;
    persistDl();
  }
}

// ---- 链接采集任务 ----
async function startNextLink() {
  if (!job.active || job.mode !== "links") return;
  if (job.linkIndex + 1 >= job.linkQueue.length) {
    await finishJob(`链接采集完成：共收录 ${job.totalCollected} 条新内容。`);
    return;
  }
  // 防风控：链接之间随机等 3~8 秒
  if (job.linkIndex >= 0 && Number(job.delaySec) > 0) {
    await sleep((Number(job.delaySec) + Math.random() * 5) * 1000);
  }
  job.linkIndex += 1;
  const url = job.linkQueue[job.linkIndex];
  job.finished = false;
  job.finishedMessage = "";
  await persistJob();
  const tab = await chrome.tabs.create({ url, active: !!job.foreground });
  job.currentTabId = tab.id;
  await persistJob();
  scheduleTimeout(COMBO_TIMEOUT_MINUTES);
  await sendToTabRetry(tab.id, { type: "SMC_START_LINK", platform: "xhs", max: 5 });
}

// ---- 评论采集任务 ----
async function startNextComment() {
  if (!job.active || job.mode !== "comments") return;
  if (job.linkIndex + 1 >= job.linkQueue.length) {
    await finishJob(`评论采集完成：共收录 ${job.totalCollected} 条高赞评论（${job.linkQueue.length} 篇笔记）`);
    return;
  }
  // 防风控：笔记之间随机等 5~25 秒（delaySec=0 表示不等待，测试用）
  if (job.linkIndex >= 0 && Number(job.delaySec) > 0) {
    await sleep((Number(job.delaySec) + Math.random() * 15) * 1000);
  }
  job.linkIndex += 1;
  const url = job.linkQueue[job.linkIndex];
  job.finished = false;
  job.finishedMessage = "";
  const m = String(url || "").match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/);
  job.currentNoteId = m ? m[1] : "";
  await persistJob();
  const tab = await chrome.tabs.create({ url, active: !!job.foreground });
  job.currentTabId = tab.id;
  await persistJob();
  scheduleTimeout(COMBO_TIMEOUT_MINUTES);
  await sendToTabRetry(tab.id, {
    type: "SMC_START_COMMENTS",
    platform: "xhs",
    noteId: job.currentNoteId,
    minLikes: Number(job.minLikes) || 0,
    maxComments: Number(job.maxPerNote) || 50,
  });
}

// ---- 搜索任务 ----
async function startNextCombo() {
  if (!job.active || job.mode !== "search") return;
  if (job.comboIndex + 1 >= job.combos.length) {
    await finishJob(`搜索采集完成：共收录 ${job.totalCollected} 条新内容（${job.keywords.length} 个关键词）`);
    return;
  }
  // 防风控：除第一个页面外，每个页面之间随机等待（delaySec ~ delaySec+20 秒）
  if (job.comboIndex >= 0 && Number(job.delaySec) > 0) {
    const base = Number(job.delaySec);
    await sleep((base + Math.random() * 20) * 1000);
  }
  job.comboIndex += 1;
  const combo = job.combos[job.comboIndex];
  job.currentPlatform = combo.platform;
  job.currentKeyword = combo.keyword;
  job.finished = false;
  job.finishedMessage = "";
  await persistJob();

  const url = buildSearchUrl(combo.platform, combo.keyword, job.sort, job.timeRangeSec);
  if (!url) {
    startNextCombo();
    return;
  }
  const tab = await chrome.tabs.create({ url, active: !!job.foreground });
  job.currentTabId = tab.id;
  await persistJob();
  scheduleTimeout(COMBO_TIMEOUT_MINUTES);

  await sendToTabRetry(tab.id, {
    type: "SMC_START_SEARCH",
    platform: combo.platform,
    keyword: combo.keyword,
    max: job.maxPerKeyword,
    minLikes: job.minLikes,
    minCollects: job.minCollects,
    minComments: job.minComments,
    timeRangeSec: job.timeRangeSec,
    typeFilter: job.typeFilter,
  });
}

// ---------- 定时器 / 标签页事件 ----------
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DL_ALARM) {
    if (!dl.active) return;
    dl.active = false;
    dl.finished = true;
    dl.failed += Math.max(0, dl.total - dl.done - dl.failed); // 超时未完成的按失败计
    persistDl();
    return;
  }
  if (alarm.name !== TIMEOUT_ALARM || !job.active) return;
  const tabId = job.currentTabId;
  job.currentTabId = null;
  if (tabId != null) {
    try { chrome.tabs.remove(tabId); } catch (err) { /* 忽略 */ }
  }
  if (job.mode === "search") startNextCombo();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (job.active && job.currentTabId === tabId) {
    job.currentTabId = null;
    if (job.mode === "search") startNextCombo();
    else if (job.mode === "author") finishJob(`博主主页采集完成：共收录 ${job.totalCollected} 条新内容。`);
    else if (job.mode === "links") startNextLink();
    else if (job.mode === "suggest") {
      const words = job.suggestWords || [];
      await saveSuggestWords(words);
      await finishJob(`下拉词采集已结束：共 ${words.length} 个联想词`);
    }
    else if (job.mode === "comments") startNextComment();
  }
});

// 重定向后重新下发会话指令（短链跳转 / SPA 导航）
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!job.active || job.currentTabId !== tabId) return;
  // 只在导航开始(loading)时重发，避免 complete 反复重发导致会话重置
  if (changeInfo.status !== "loading") return;
  if (job.mode === "search") {
    sendToTabRetry(tabId, {
      type: "SMC_START_SEARCH",
      platform: job.currentPlatform,
      keyword: job.currentKeyword,
      max: job.maxPerKeyword,
      minLikes: job.minLikes,
      minCollects: job.minCollects,
      minComments: job.minComments,
      timeRangeSec: job.timeRangeSec,
      typeFilter: job.typeFilter,
    });
  } else if (job.mode === "author") {
    sendToTabRetry(tabId, {
      type: "SMC_START_AUTHOR",
      platform: "xhs",
      keyword: "",
      author: String(job.currentKeyword || "").replace(/^@/, "") || "博主",
      max: job.maxPerKeyword,
    });
  } else if (job.mode === "links") {
    sendToTabRetry(tabId, { type: "SMC_START_LINK", platform: "xhs", max: 5 });
  } else if (job.mode === "suggest") {
    sendToTabRetry(tabId, { type: "SMC_START_SUGGEST", seeds: job.seeds, maxPerSeed: job.maxPerSeed || 20 });
  } else if (job.mode === "comments") {
    sendToTabRetry(tabId, {
      type: "SMC_START_COMMENTS",
      platform: "xhs",
      noteId: job.currentNoteId,
      minLikes: Number(job.minLikes) || 0,
      maxComments: Number(job.maxPerNote) || 50,
    });
  }
});

// ---------- 消息处理 ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message && message.type) {
        case "SMC_ITEMS": {
          const keyword = (message.keyword || "").trim();
          const platform = message.platform || "";
          const items = Array.isArray(message.items) ? message.items : [];
          // 只要有数据就入库；关键词为空时（详情页采集）不写历史，但素材照常保存
          const added = items.length ? await mergeItems(items, keyword, platform, message.sourceType) : 0;
          if (job.active && job.currentTabId === (sender.tab && sender.tab.id)) {
            job.totalCollected += added;
            await persistJob();
          }
          sendResponse({ ok: true, added });
          break;
        }
        case "SMC_SCROLL_FINISHED": {
          if (
            job.active &&
            job.mode === "search" &&
            message.platform === job.currentPlatform &&
            message.keyword === job.currentKeyword &&
            job.currentTabId != null
          ) {
            const tabId = job.currentTabId;
            job.currentTabId = null; // 先置空，避免 onRemoved 重复推进
            try { await chrome.tabs.remove(tabId); } catch (err) { /* 忽略 */ }
            await startNextCombo();
          } else if (
            job.active &&
            job.mode === "author" &&
            sender.tab && sender.tab.id === job.currentTabId
          ) {
            const tabId = job.currentTabId;
            job.currentTabId = null;
            try { await chrome.tabs.remove(tabId); } catch (err) { /* 忽略 */ }
            await finishJob(`博主主页采集完成：共收录 ${job.totalCollected} 条新内容。`);
          } else if (
            job.active &&
            job.mode === "links" &&
            sender.tab && sender.tab.id === job.currentTabId
          ) {
            const tabId = job.currentTabId;
            job.currentTabId = null;
            try { await chrome.tabs.remove(tabId); } catch (err) { /* 忽略 */ }
            await startNextLink();
          }
          sendResponse({ ok: true });
          break;
        }
        case "SMC_SUGGEST_PROGRESS": {
          if (job.active && job.mode === "suggest") {
            job.suggestIndex = Number(message.seedIndex) || 0;
            job.suggestWords = Array.isArray(message.words) ? message.words.slice() : job.suggestWords;
            job.currentKeyword = message.seed || job.currentKeyword;
            job.totalCollected = job.suggestWords.length;
            await persistJob();
          }
          sendResponse({ ok: true });
          break;
        }
        case "SMC_SUGGEST_FINISHED": {
          if (job.active && job.mode === "suggest") {
            const words = (Array.isArray(message.words) && message.words.length)
              ? message.words.slice()
              : (job.suggestWords || []);
            await saveSuggestWords(words);
            job.suggestWords = words;
            job.totalCollected = words.length;
            await finishJob(`下拉词采集完成：共 ${words.length} 个联想词（${job.seeds.length} 个种子词）`);
          }
          sendResponse({ ok: true });
          break;
        }
        case "SMC_COMMENTS_FINISHED": {
          if (
            job.active &&
            job.mode === "comments" &&
            sender.tab && sender.tab.id === job.currentTabId
          ) {
            const minLikes = Number(job.minLikes) || 0;
            const maxPerNote = Number(job.maxPerNote) || 50;
            const comments = (Array.isArray(message.comments) ? message.comments : [])
              .filter((c) => (Number(c.like_count) || 0) >= minLikes)
              .slice(0, maxPerNote);
            const noteTitle = String(message.noteTitle || "").trim() || job.currentNoteId || "未知笔记";
            const noteId = String(message.noteId || job.currentNoteId || "");
            const token = String(comments[0] && (comments[0].xsec_token || "") || "");
            const noteUrl = "https://www.xiaohongshu.com/explore/" + noteId +
              (token ? "?xsec_token=" + encodeURIComponent(token) + "&xsec_source=pc_feed" : "");
            const entries = comments.map((c) => Object.assign({}, c, {
              platform: "xhs",
              note_id: noteId,
              note_title: noteTitle,
              note_url: noteUrl,
              is_hot: (Number(c.like_count) || 0) >= minLikes,
              captured_at: new Date().toISOString(),
            }));
            const added = await saveComments(entries);
            job.totalCollected += added;
            job.currentKeyword = message.noteId || job.currentKeyword;
            const tabId = job.currentTabId;
            job.currentTabId = null; // 先置空，避免 onRemoved 重复推进
            try { await chrome.tabs.remove(tabId); } catch (err) { /* 忽略 */ }
            await persistJob();
            await startNextComment();
          }
          sendResponse({ ok: true });
          break;
        }
        case "SMC_START_AUTHOR": {
          if (job.active) {
            sendResponse({ ok: false, error: "已有采集任务在进行中" });
            break;
          }
          const url = String(message.url || "").trim();
          if (!/xiaohongshu\.com\/user\/profile\//.test(url)) {
            sendResponse({ ok: false, error: "请输入正确的小红书博主主页链接（…/user/profile/…）" });
            break;
          }
          const max = Math.max(1, Number(message.max) || 100);
          const authorName = String(message.author || "博主").trim() || "博主";
          Object.assign(job, {
            mode: "author",
            active: true,
            platforms: [],
            keywords: [],
            combos: [],
            comboIndex: -1,
            currentPlatform: "xhs",
            currentKeyword: "@" + authorName,
            sort: "general",
            timeRangeSec: 0,
            typeFilter: "",
            maxPerKeyword: max,
            minLikes: 0,
            minCollects: 0,
            minComments: 0,
            delaySec: Number(message.delaySec) || 2,
            foreground: message.foreground !== false,
            currentTabId: null,
            totalCollected: 0,
            startedAt: new Date().toISOString(),
            finished: false,
            finishedMessage: "",
          });
          await persistJob();
          const tab = await chrome.tabs.create({ url, active: !!job.foreground });
          job.currentTabId = tab.id;
          await persistJob();
          scheduleTimeout(COMBO_TIMEOUT_MINUTES);
          await sendToTabRetry(tab.id, {
            type: "SMC_START_AUTHOR",
            platform: "xhs",
            keyword: "",
            author: authorName,
            max,
          });
          sendResponse({ ok: true });
          break;
        }
        case "SMC_START_SEARCH": {
          if (job.active) {
            sendResponse({ ok: false, error: "已有采集任务在进行中" });
            break;
          }
          const platforms = (message.platforms || [])
            .map((p) => String(p).trim())
            .filter((p) => PLATFORMS[p]);
          const keywords = (message.keywords || [])
            .map((k) => String(k).trim())
            .filter((k) => k.length > 0);
          if (!platforms.length) {
            sendResponse({ ok: false, error: "请至少选择一个平台" });
            break;
          }
          if (!keywords.length) {
            sendResponse({ ok: false, error: "请至少输入一个关键词" });
            break;
          }
          const combos = [];
          keywords.forEach((k) => platforms.forEach((p) => combos.push({ platform: p, keyword: k })));
          Object.assign(job, {
            mode: "search",
            active: true,
            platforms,
            keywords,
            combos,
            comboIndex: -1,
            currentPlatform: "",
            currentKeyword: "",
            sort: message.sort || "general",
            timeRangeSec: Number(message.timeRangeSec) || 0,
            typeFilter: message.typeFilter || "",
            maxPerKeyword: Number(message.maxPerKeyword) || 150,
            minLikes: Number(message.minLikes) || 0,
            minCollects: Number(message.minCollects) || 0,
            minComments: Number(message.minComments) || 0,
            delaySec: Number(message.delaySec) || 0,
            foreground: message.foreground !== false,
            currentTabId: null,
            totalCollected: 0,
            startedAt: new Date().toISOString(),
            finished: false,
            finishedMessage: "",
          });
          await persistJob();
          await startNextCombo();
          sendResponse({ ok: true });
          break;
        }
        case "SMC_START_SUGGEST": {
          if (job.active) {
            sendResponse({ ok: false, error: "已有采集任务在进行中" });
            break;
          }
          const seeds = (message.seeds || [])
            .map((x) => String(x).trim())
            .filter(Boolean);
          if (!seeds.length) {
            sendResponse({ ok: false, error: "请至少输入一个种子词" });
            break;
          }
          Object.assign(job, {
            mode: "suggest",
            active: true,
            seeds,
            suggestIndex: 0,
            suggestWords: [],
            maxPerSeed: Number(message.maxPerSeed) || 20,
            currentKeyword: seeds[0],
            foreground: message.foreground !== false,
            currentTabId: null,
            totalCollected: 0,
            startedAt: new Date().toISOString(),
            finished: false,
            finishedMessage: "",
          });
          await persistJob();
          const tab = await chrome.tabs.create({
            url: "https://www.xiaohongshu.com/search_result?keyword=" + encodeURIComponent(seeds[0]),
            active: !!job.foreground,
          });
          job.currentTabId = tab.id;
          await persistJob();
          scheduleTimeout(COMBO_TIMEOUT_MINUTES);
          await sendToTabRetry(tab.id, { type: "SMC_START_SUGGEST", seeds, maxPerSeed: job.maxPerSeed });
          sendResponse({ ok: true });
          break;
        }
        case "SMC_START_LINK": {
          if (job.active) {
            sendResponse({ ok: false, error: "已有采集任务在进行中" });
            break;
          }
          const links = (message.links || [])
            .map((l) => String(l).trim())
            .filter((l) => /xiaohongshu\.com\/(?:explore|discovery\/item)\/[A-Za-z0-9]+/.test(l));
          if (!links.length) {
            sendResponse({ ok: false, error: "请粘贴小红书笔记链接（…/explore/… 或 …/discovery/item/…）" });
            break;
          }
          Object.assign(job, {
            mode: "links",
            active: true,
            platforms: [],
            keywords: [],
            combos: [],
            comboIndex: -1,
            currentPlatform: "xhs",
            currentKeyword: "链接采集",
            sort: "general",
            timeRangeSec: 0,
            typeFilter: "",
            maxPerKeyword: 5,
            minLikes: 0,
            minCollects: 0,
            minComments: 0,
            delaySec: message.delaySec === 0 ? 0 : (Number(message.delaySec) || 3),
            foreground: message.foreground !== false,
            linkQueue: links,
            linkIndex: -1,
            currentTabId: null,
            totalCollected: 0,
            startedAt: new Date().toISOString(),
            finished: false,
            finishedMessage: "",
          });
          await persistJob();
          await startNextLink();
          sendResponse({ ok: true, total: links.length });
          break;
        }
        case "SMC_START_COMMENTS": {
          if (job.active) {
            sendResponse({ ok: false, error: "已有采集任务在进行中" });
            break;
          }
          const links = (message.links || [])
            .map((l) => String(l).trim())
            .filter((l) => /xiaohongshu\.com\/(?:explore|discovery\/item)\/[A-Za-z0-9]+/.test(l));
          if (!links.length) {
            sendResponse({ ok: false, error: "请粘贴小红书笔记链接（…/explore/…）" });
            break;
          }
          Object.assign(job, {
            mode: "comments",
            active: true,
            platforms: [],
            keywords: [],
            combos: [],
            comboIndex: -1,
            currentPlatform: "xhs",
            currentKeyword: "评论采集",
            sort: "general",
            timeRangeSec: 0,
            typeFilter: "",
            maxPerNote: Math.max(1, Number(message.maxPerNote) || 50),
            minLikes: Math.max(0, Number(message.minLikes) || 0),
            delaySec: message.delaySec === 0 ? 0 : (Number(message.delaySec) || 10),
            foreground: message.foreground !== false,
            linkQueue: links,
            linkIndex: -1,
            currentNoteId: "",
            currentTitle: "",
            currentTabId: null,
            totalCollected: 0,
            startedAt: new Date().toISOString(),
            finished: false,
            finishedMessage: "",
          });
          await persistJob();
          await startNextComment();
          sendResponse({ ok: true, total: links.length });
          break;
        }
        case "SMC_START_DL": {
          if (dl.active) {
            sendResponse({ ok: false, error: "已有解析下载任务在进行中，请等待完成" });
            break;
          }
          const entries = (message.entries || [])
            .map((e) => ({ key: String((e && e.key) || "").trim(), url: String((e && e.url) || "").trim() }))
            .filter((e) => e.key && e.url);
          if (!entries.length) {
            sendResponse({ ok: false, error: "请先勾选要解析的素材" });
            break;
          }
          const { items } = await readAll();
          const queue = [];
          const seen = new Set();
          for (const e of entries) {
            if (seen.has(e.key)) continue;
            seen.add(e.key);
            const it = items[e.key];
            if (!it) continue;
            queue.push({ key: e.key, url: it.url || e.url });
          }
          if (!queue.length) {
            sendResponse({ ok: false, error: "勾选的素材没有可解析的链接" });
            break;
          }
          // 读取用户设置的解析模式（极速/稳妥）
          let parseMode = "fast";
          try {
            const st = await chrome.storage.local.get("smc_settings_v1");
            parseMode = (st && st.smc_settings_v1 && st.smc_settings_v1.parseMode) || "fast";
          } catch (e) { /* ignore */ }
          Object.assign(dl, {
            active: true,
            parseMode: parseMode === "safe" ? "safe" : "fast",
            queue,
            current: 0,
            concurrency: Math.max(1, Number(message.concurrency) || DL_CONCURRENCY),
            inFlight: 0,
            finished: false,
            total: queue.length,
            done: 0,
            failed: 0,
            doneKeys: {},
            lastError: "",
            lastParser: "",
            lastDownloadError: "",
            zipFallback: 0,
            lastZipError: "",
          });
          await persistDl();
          chrome.alarms.create(DL_ALARM, {
            delayInMinutes: Math.max(1, Math.ceil(queue.length / dl.concurrency) * DL_TIMEOUT_MINUTES),
          });
          spawnDl();
          sendResponse({ ok: true, total: queue.length });
          break;
        }
        case "SMC_GET_DL_JOB": {
          sendResponse({ ok: true, job: { ...dl } });
          break;
        }
        case "SMC_STOP_DL": {
          dl.active = false;
          dl.finished = true;
          dl.failed += Math.max(0, dl.total - dl.done - dl.failed);
          await persistDl();
          await chrome.alarms.clear(DL_ALARM);
          sendResponse({ ok: true });
          break;
        }
        case "SMC_STOP": {
          await stopJob(message && message.message);
          sendResponse({ ok: true });
          break;
        }
        case "SMC_GET_SUMMARY": {
          const { keywords, history } = await readAll();
          sendResponse({ ok: true, job: { ...job }, keywords, history });
          break;
        }
        case "SMC_FILL_CONTENT": {
          const keys = Array.isArray(message.keys) ? message.keys : [];
          const all = await readAll();
          const need = keys
            .map((k) => all.items[k])
            .filter((it) => it && it.url && !(it.content || "").trim());
          let filled = 0, failed = 0;
          const updates = [];
          const errors = [];
          // Sequential requests keep request pressure low and avoid losing a whole batch.
          for (const it of need) {
            try {
              let c = "";
              const tabs = await chrome.tabs.query({ url: "https://*.xiaohongshu.com/*" });
              for (const tab of tabs) {
                try {
                  const result = await chrome.tabs.sendMessage(tab.id, { type: "SMC_READ_CONTENT", noteId: it.id });
                  if (result && result.ok && result.content) { c = result.content; break; }
                } catch (e) { /* Older tabs need a refresh after extension update. */ }
              }
              if (!c.trim()) {
                const parsed = await parseWithFallback(it.url, "content");
                c = String(parsed && parsed.obj && (parsed.obj.content || parsed.obj.desc) || "");
              }
              if (c.trim()) { updates.push({ key: `${it.platform}:${it.id}`, content: c }); filled++; }
              else { failed++; errors.push({ id: it.id, error: "未读取到正文；请在已登录的小红书网页打开此笔记，等待正文显示后重试导出。可能需要登录、验证，或笔记本身没有正文。" }); }
            } catch (e) { failed++; errors.push({ id: it.id, error: String(e.message || e) }); }
          }
          if (updates.length) {
            // Re-read storage so this export does not overwrite newly collected notes.
            const latest = await readAll();
            for (const update of updates) {
              if (latest.items[update.key]) latest.items[update.key].content = update.content;
            }
            await persistAll(latest.items, latest.keywords, latest.history, latest.snapshots);
          }
          sendResponse({ ok: true, filled, failed, total: need.length, errors });
          break;
        }
        case "SMC_GET_ITEMS": {
          const { items, snapshots } = await readAll();
          const platform = (message.platform || "").trim();
          const keyword = (message.keyword || "").trim();
          let list = Object.values(items);
          if (platform) list = list.filter((it) => it.platform === platform);
          if (keyword) list = list.filter((it) => (it.keywords || []).includes(keyword));
          const byKey = {};
          snapshots.forEach((s) => {
            if (!s || !s.key) return;
            (byKey[s.key] = byKey[s.key] || []).push(s);
          });
          const enriched = list.map((it) => {
            const sn = (byKey[it.platform + ":" + it.id] || [])
              .slice()
              .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
            let delta = null;
            if (sn.length >= 2) {
              const last = sn[sn.length - 1];
              const prev = sn[sn.length - 2];
              delta = {
                liked: (last.liked_count || 0) - (prev.liked_count || 0),
                collected: (last.collected_count || 0) - (prev.collected_count || 0),
                comments: (last.comment_count || 0) - (prev.comment_count || 0),
              };
            }
            return Object.assign({}, it, { delta });
          });
          sendResponse({ ok: true, items: enriched });
          break;
        }
        case "SMC_GET_SUGGEST": {
          const d = await chrome.storage.local.get(STORAGE_KEYS.suggest);
          sendResponse({ ok: true, words: d[STORAGE_KEYS.suggest] || [] });
          break;
        }
        case "SMC_CLEAR_SUGGEST": {
          await chrome.storage.local.set({ [STORAGE_KEYS.suggest]: [] });
          sendResponse({ ok: true });
          break;
        }
        case "SMC_DEDUP_ITEMS": {
          const { items, keywords, history, snapshots } = await readAll();
          const groups = new Map();
          Object.keys(items).forEach((key) => {
            const it = items[key];
            if (!it) return;
            const m = String(it.url || "").match(/\/explore\/([A-Za-z0-9]+)/);
            const norm = m ? "url:" + m[1] : (it.title ? "t:" + it.title + "|" + (it.author || "") : "");
            if (!norm) return;
            if (!groups.has(norm)) groups.set(norm, []);
            groups.get(norm).push(key);
          });
          const richness = (it) =>
            (Array.isArray(it.image_urls) ? it.image_urls.length : 0) * 2 +
            (Array.isArray(it.video_urls) ? it.video_urls.length : 0) * 2 +
            (it.content ? 1 : 0) + (it.cover_url ? 1 : 0);
          let removed = 0;
          let merged = 0;
          for (const g of groups.values()) {
            if (g.length < 2) continue;
            g.sort((a, b) => richness(items[b]) - richness(items[a]) ||
              String(items[a].first_seen || "").localeCompare(String(items[b].first_seen || "")));
            const keep = items[g[0]];
            keep.keywords = keep.keywords || [];
            keep.stats = keep.stats || {};
            for (let i = 1; i < g.length; i++) {
              const it = items[g[i]];
              (it.keywords || []).forEach((kw) => { if (!keep.keywords.includes(kw)) keep.keywords.push(kw); });
              if (!keep.content && it.content) keep.content = it.content;
              if (!(keep.image_urls || []).length && (it.image_urls || []).length) keep.image_urls = it.image_urls;
              if (!(keep.video_urls || []).length && (it.video_urls || []).length) keep.video_urls = it.video_urls;
              if (!keep.cover_url && it.cover_url) keep.cover_url = it.cover_url;
              ["likes", "collects", "comments", "shares", "views"].forEach((sk) => {
                keep.stats[sk] = Math.max(keep.stats[sk] || 0, (it.stats || {})[sk] || 0);
              });
              keep.score = Math.max(Number(keep.score) || 0, Number(it.score) || 0);
              delete items[g[i]];
              removed += 1;
            }
            merged += 1;
          }
          await persistAll(items, keywords, history, snapshots);
          sendResponse({ ok: true, removed, merged });
          break;
        }
        case "SMC_GET_COMMENTS": {
          const d = await chrome.storage.local.get(STORAGE_KEYS.comments);
          let all = Object.values(d[STORAGE_KEYS.comments] || {});
          const minLikes = Number(message.minLikes) || 0;
          if (minLikes > 0) all = all.filter((c) => (Number(c.like_count) || 0) >= minLikes);
          all.sort((a, b) => (Number(b.like_count) || 0) - (Number(a.like_count) || 0));
          sendResponse({ ok: true, comments: all });
          break;
        }
        case "SMC_CLEAR_COMMENTS": {
          await chrome.storage.local.set({ [STORAGE_KEYS.comments]: {} });
          sendResponse({ ok: true });
          break;
        }
        case "SMC_CLEAR_ITEMS": {
          const empty = {};
          const k = {};
          await persistAll(empty, k, [], []);
          await persistJob();
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "未知消息类型" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true; // 异步响应
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(STORAGE_KEYS.job).then((data) => {
    if (data && data[STORAGE_KEYS.job] && data[STORAGE_KEYS.job].active) {
      Object.assign(job, data[STORAGE_KEYS.job], { active: false, finished: true, finishedMessage: "上次任务已结束" });
      persistJob();
    }
  });
});
