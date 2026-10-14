// hook.js — 注入小红书页面【主世界】(world: MAIN) 的抓取钩子
// 职责：拦截页面自身的 fetch / XHR 请求，解析小红书搜索接口返回数据，
// 提取「互动数据 + 封面/图片链接」，通过 postMessage 传给隔离世界的 content.js 转发后台。
(() => {
  if (window.__smcHookInstalled) return;
  window.__smcHookInstalled = true;

  const POST = { source: "SMC_HOOK" };

  // ---------- 站点识别（仅小红书） ----------
  function siteOf(url) {
    if (!url) return "";
    try {
      const u = new URL(url, location.href);
      return /xiaohongshu\.com$/.test(u.hostname) ? "xhs" : "";
    } catch (e) { /* ignore */ }
    return "";
  }

  // ---------- 计数解析 ----------
  function parseCount(value) {
    if (value === null || value === undefined || value === "") return 0;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "number") return Math.max(0, Math.floor(value));
    let text = String(value).trim().replace(/,/g, "").replace(/\+/g, "");
    const multipliers = { "千": 1000, "万": 10000, "亿": 100000000, "k": 1000, "w": 10000 };
    let multiplier = 1;
    const lower = text.toLowerCase();
    for (const [suffix, factor] of Object.entries(multipliers)) {
      if (lower.includes(suffix)) {
        multiplier = factor;
        text = lower.replace(suffix, "");
        break;
      }
    }
    const m = text.match(/\d+(?:\.\d+)?/);
    return m ? Math.max(0, Math.floor(parseFloat(m[0]) * multiplier)) : 0;
  }

  // ---------- 时间 ----------
  function xhsTimeFromNoteId(noteId) {
    if (!noteId || noteId.length < 8) return "";
    const ts = parseInt(noteId.slice(0, 8), 16);
    if (!Number.isFinite(ts) || ts <= 1500000000 || ts >= 2000000000) return "";
    return new Date(ts * 1000).toISOString();
  }
  function timeText(iso) {
    if (!iso) return "时间未知";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "时间未知";
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- URL 清洗 ----------
  function cleanXhsImage(url) {
    if (!url) return "";
    // 注意：xhscdn 的图片 URL 带 ! 后缀（如 !nc_n_webp_mw_1）才能稳定加载，保留原样。
    return String(url).trim();
  }

  // ---------- 通用递归查找 ----------
  function walk(obj, pred, out, depth) {
    if (depth > 12 || obj === null || obj === undefined) return;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (item && typeof item === "object" && pred(item)) out.push(item);
        else walk(item, pred, out, depth + 1);
      }
    } else if (typeof obj === "object") {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v === "object") {
          if (pred(v)) out.push(v);
          else walk(v, pred, out, depth + 1);
        }
      }
    }
  }

  // ---------- 笔记解析 ----------
  function makeItem(src) {
    return {
      platform: "xhs",
      id: "",
      title: "",
      content: "",
      author: "",
      author_id: "",
      author_avatar: "",
      cover_url: "",
      image_urls: [],
      video_urls: [],
      stats: { likes: 0, collects: 0, comments: 0, shares: 0, views: 0 },
      post_time: "",
      url: "",
      score: 0,
      source: src || "search",
    };
  }
  function finalizeItem(it, keyword) {
    it.score = (it.stats.likes || 0) + (it.stats.collects || 0) * 1.5 + (it.stats.comments || 0) * 2;
    it.time_text = timeText(it.post_time);
    if (keyword) it.keyword = keyword;
    return it;
  }

  function parseXhsNote(noteId, card, src, itemToken) {
    const it = makeItem(src);
    if (!noteId) return null;
    // 兼容 snake_case（搜索接口）和 camelCase（博主主页接口）两种字段
    const pick = (obj, keys) => {
      for (const k of keys) {
        const v = obj && obj[k];
        if (v !== undefined && v !== null && v !== "") return v;
      }
      return "";
    };
    const interact = (card && (card.interact_info || card.interactInfo)) || {};
    const user = (card && card.user) || {};
    const cover = (card && card.cover) || {};
    const imageList = (card && (card.image_list || card.imageList)) || [];
    const video = (card && card.video) || {};
    it.id = String(noteId);
    it.type = String((card && (card.type || (card.note_info && card.note_info.type))) || "normal");
    it.title = String(pick(card, ["display_title", "displayTitle", "title"]) || "无标题").trim();
    it.content = String(pick(card, ["desc", "description"]) || "");
    it.author = String(pick(user, ["nickname", "nickName"]) || "未知用户").trim();
    it.author_id = String(user.user_id || user.userId || "");
    it.author_avatar = cleanXhsImage((user.avatar || "").split("?")[0]) || "";
    let coverUrl = pick(cover, ["url_default", "urlDefault", "url_pre", "urlPre", "url"]);
    if (!coverUrl && Array.isArray(cover.infoList)) {
      const dft = cover.infoList.find((i) => i && (i.imageScene === "WB_DFT" || i.imageScene === "WB_PRV"));
      coverUrl = (dft && dft.url) || "";
    }
    if (!coverUrl && imageList[0]) coverUrl = pick(imageList[0], ["url_default", "urlDefault", "url", "url_pre", "urlPre"]);
    it.cover_url = cleanXhsImage(coverUrl);
    it.stats.likes = parseCount(pick(interact, ["liked_count", "likedCount"]));
    it.stats.collects = parseCount(pick(interact, ["collected_count", "collectedCount"]));
    it.stats.comments = parseCount(pick(interact, ["comment_count", "commentCount"]));
    it.stats.shares = parseCount(pick(interact, ["share_count", "shareCount", "shared_count"]));
    it.image_urls = imageList
      .map((im) => cleanXhsImage(pick(im, ["url_default", "urlDefault", "url", "url_pre", "urlPre"])))
      .filter(Boolean);
    try {
      const streams = video && video.media && video.media.stream ? video.media.stream : {};
      const h264 = streams.h264 || [];
      const v = h264[0];
      if (v) {
        const candidates = [];
        if (v.masterUrl) candidates.push(v.masterUrl);
        (Array.isArray(v.backupUrls) ? v.backupUrls : []).forEach((u) => { if (u) candidates.push(u); });
        candidates.forEach((u) => {
          if (u && !it.video_urls.includes(u)) it.video_urls.push(u);
        });
      }
    } catch (e) { /* ignore */ }
    if (card && card.time) {
      const t = Number(card.time);
      if (Number.isFinite(t) && t > 0) {
        const d = new Date(t);
        it.post_time = Number.isNaN(d.getTime()) ? xhsTimeFromNoteId(noteId) : d.toISOString();
      } else {
        it.post_time = xhsTimeFromNoteId(noteId);
      }
    } else {
      it.post_time = xhsTimeFromNoteId(noteId);
    }
    const xsec = itemToken || pick(card, ["xsec_token", "xsecToken"]) || (card.note_info && card.note_info.xsec_token) || "";
    it.url = `https://www.xiaohongshu.com/explore/${noteId}${xsec ? "?xsec_token=" + encodeURIComponent(xsec) + "&xsec_source=pc_feed" : ""}`;
    return finalizeItem(it);
  }

  function handleXhsSearch(payload) {
    if (!payload || !payload.data || !Array.isArray(payload.data.items)) return [];
    const items = [];
    const noteLike = (card) => card && typeof card === "object" && (card.display_title || card.title || card.image_list || card.interact_info || card.note_id || card.noteId);
    for (const item of payload.data.items) {
      if (!item || typeof item !== "object") continue;
      const card = item.note_card || item;
      if (!noteLike(card)) continue;
      const nid = String(item.id || item.note_id || card.note_id || card.noteId || "");
      if (!nid) continue;
      const parsed = parseXhsNote(nid, card, "search", item.xsec_token);
      if (parsed) items.push(parsed);
    }
    // 兜底：接口结构变化时，用通用遍历找笔记卡片形状
    if (!items.length) {
      const found = [];
      walk(payload, (o) => o && typeof o === "object" && (o.note_id || o.noteId) && (o.interact_info || o.image_list || o.display_title || o.title), found, 0);
      const seen = new Set();
      found.forEach((o) => {
        const nid = String(o.note_id || o.noteId || "");
        if (!nid || seen.has(nid)) return;
        seen.add(nid);
        const parsed = parseXhsNote(nid, o, "search", o.xsec_token);
        if (parsed) items.push(parsed);
      });
    }
    return items;
  }

  function handleXhsFeed(payload, src) {
    const items = [];
    if (payload && payload.data) {
      if (Array.isArray(payload.data.items)) {
        for (const item of payload.data.items) {
          if (!item || !item.note_card) continue;
          const parsed = parseXhsNote(item.note_card.note_id || item.note_card.noteId, item.note_card, src, item.xsec_token);
          if (parsed) items.push(parsed);
        }
      }
      if (Array.isArray(payload.data.notes)) {
        for (const note of payload.data.notes) {
          if (!note || typeof note !== "object") continue;
          const card = (note.note_card && typeof note.note_card === "object")
            ? note.note_card
            : ((note.noteCard && typeof note.noteCard === "object") ? note.noteCard : note);
          const nid = String(card.note_id || card.noteId || note.id || note.note_id || note.noteId || "");
          if (!nid) continue;
          const token = note.xsec_token || note.xsecToken || card.xsec_token || card.xsecToken
            || (card.note_info && card.note_info.xsec_token) || "";
          const parsed = parseXhsNote(nid, card, src, token);
          if (parsed) items.push(parsed);
        }
      }
    }
    return items;
  }

  // ---------- 搜索联想词（下拉词） ----------
  function suggestSeedOf(url) {
    try {
      const u = new URL(url, location.href);
      return decodeURIComponent(u.searchParams.get("keyword") || "");
    } catch (e) { return ""; }
  }
  function handleXhsSuggest(payload) {
    if (!payload || typeof payload !== "object") return [];
    let arr = [];
    if (payload.data && Array.isArray(payload.data.sug_items)) arr = payload.data.sug_items;
    else if (Array.isArray(payload.sug_items)) arr = payload.sug_items;
    else if (payload.data && Array.isArray(payload.data.items)) arr = payload.data.items;
    const words = [];
    const seen = new Set();
    const push = (w) => {
      w = String(w || "").trim();
      if (!w || seen.has(w)) return;
      seen.add(w);
      words.push(w);
    };
    arr.forEach((it) => {
      if (!it || typeof it !== "object") return;
      push(it.text);
      push(it.word);
      push(it.name);
      if (Array.isArray(it.suggest_words)) {
        it.suggest_words.forEach((sw) => {
          if (sw && typeof sw === "object") push(sw.text || sw.word || sw.name);
          else push(sw);
        });
      }
    });
    // 兜底：直接是字符串数组
    if (!words.length) {
      arr.forEach((it) => {
        if (typeof it === "string") push(it);
      });
    }
    return words;
  }
  function postSuggest(platform, words, seed) {
    try {
      window.postMessage(Object.assign({}, POST, { type: "SUGGEST", platform, words, seed: seed || "" }), "*");
    } catch (e) { /* ignore */ }
  }

  // ---------- 评论（v2/comment/page） ----------
  function handleXhsComments(payload) {
    if (!payload || typeof payload !== "object" || !payload.data) return [];
    const arr = Array.isArray(payload.data.comments) ? payload.data.comments : [];
    const out = [];
    const seen = new Set();
    arr.forEach((c) => {
      if (!c || typeof c !== "object") return;
      const cid = String(c.id || "");
      if (!cid || seen.has(cid)) return;
      seen.add(cid);
      const user = c.user_info || c.userInfo || {};
      out.push({
        comment_id: cid,
        note_id: String(c.note_id || c.noteId || ""),
        content: String(c.content || ""),
        like_count: parseCount(c.like_count === undefined || c.like_count === null ? c.likeCount : c.like_count),
        create_time: c.create_time || c.createTime || 0,
        nickname: String(user.nickname || ""),
        user_id: String(user.user_id || user.userId || ""),
        avatar: cleanXhsImage(String(user.avatar || "").split("?")[0]) || "",
        sub_comment_count: Number(c.sub_comment_count === undefined || c.sub_comment_count === null ? c.subCommentCount : c.sub_comment_count) || 0,
      });
    });
    return out;
  }
  function postComments(platform, comments, noteId, xsecToken) {
    try {
      window.postMessage(Object.assign({}, POST, { type: "COMMENTS", platform, comments, noteId: noteId || "", xsecToken: xsecToken || "" }), "*");
    } catch (e) { /* ignore */ }
  }

  // ---------- 接口分发 ----------
  function handleResponse(url, json) {
    if (!json || typeof json !== "object") return;
    if (!siteOf(url)) return;

    if (/\/api\/sns\/web\/v\d+\/search\/notes/i.test(url)) {
      const items = handleXhsSearch(json);
      try {
        const f = items[0] || {};
        console.log(
          "[社媒采集] xhs 搜索接口命中，解析", items.length, "条",
          "，首条：图片", (f.image_urls || []).length,
          "，url:", String(url).slice(0, 120)
        );
      } catch (e) { /* ignore */ }
      if (items.length) postItems("xhs", items, "search");
      return;
    }
    if (/\/api\/sns\/web\/v\d+\/feed/i.test(url)) {
      const items = handleXhsFeed(json, "detail");
      if (items.length) postItems("xhs", items, "detail");
      return;
    }
    if (/\/api\/sns\/web\/v\d+\/user_posted/i.test(url)) {
      const items = handleXhsFeed(json, "author_feed");
      if (items.length) postItems("xhs", items, "author_feed");
      return;
    }
    // 评论：接口路径命中 或 返回结构命中（不依赖具体路径，页面能显示就一定能抓）
    if (/comment\/page/i.test(url) || (json.data && Array.isArray(json.data.comments))) {
      const comments = handleXhsComments(json);
      const m = String(url).match(/note_id=([^&]+)/);
      const noteId = m ? decodeURIComponent(m[1]) : "";
      const tm = String(url).match(/xsec_token=([^&]+)/);
      const xsecToken = tm ? decodeURIComponent(tm[1]) : "";
      if (comments.length) postComments("xhs", comments, noteId, xsecToken);
      return;
    }
    // 下拉词：接口路径命中 或 返回结构命中（sug_items）
    if (
      /sug\/recommend/i.test(url) ||
      /search\/suggest/i.test(url) ||
      (json.data && Array.isArray(json.data.sug_items)) ||
      Array.isArray(json.sug_items)
    ) {
      const words = handleXhsSuggest(json);
      if (words.length) postSuggest("xhs", words, suggestSeedOf(url));
      return;
    }
  }

  function postItems(platform, items, sourceType) {
    try {
      window.postMessage(Object.assign({}, POST, { type: "ITEMS", platform, items, sourceType }), "*");
    } catch (e) { /* ignore */ }
  }

  // ---------- 拦截 fetch ----------
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      const responsePromise = origFetch.apply(this, args);
      if (responsePromise && typeof responsePromise.then === "function") {
        responsePromise.then((response) => {
          try {
            if (response && response.clone && typeof response.json === "function") {
              const url = (response.url || "").split("#")[0];
              if (!siteOf(url)) return;
              response.clone().json().then((j) => handleResponse(url, j)).catch(() => {});
            }
          } catch (e) { /* ignore */ }
        }).catch(() => {});
      }
      return responsePromise;
    };
  }

  // ---------- 拦截 XMLHttpRequest ----------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try { this.__smcHookUrl = url; } catch (e) { /* ignore */ }
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const respUrl = (this.responseURL || this.__smcHookUrl || "").split("#")[0];
        if (!siteOf(respUrl)) return;
        const text = this.responseText;
        if (!text) return;
        handleResponse(respUrl, JSON.parse(text));
      } catch (e) { /* ignore */ }
    });
    return origSend.apply(this, args);
  };

  // ---------- 页面初始状态提取（兜底） ----------
  function pageTypeFromUrl() {
    const p = location.pathname;
    if (/\/user\/profile\//.test(p)) return "author";
    if (/\/explore\//.test(p) || /\/discovery\/item\//.test(p)) return "work";
    if (/\/search_result/.test(p)) return "search";
    return "home";
  }
  function initialId() {
    const p = location.pathname;
    const m = p.match(/\/(?:explore|discovery\/item)\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function tryExtractFromWindow() {
    const pageType = pageTypeFromUrl();
    const id = initialId();
    const items = [];
    const globals = [
      window.__INITIAL_STATE__,
      window._ROUTER_DATA,
      window.__APOLLO_STATE__,
      window._SSR_DATA,
      window.RENDER_DATA,
      window.__NEXT_DATA__,
    ];
    const seen = new Set();
    for (const g of globals) {
      if (!g) continue;
      // 结构1：{note_id, note_card} / {note: note_card} / 直接是笔记对象 / camelCase {id, noteCard}
      const found = [];
      walk(g, (o) => o && typeof o === "object" && (
        o.note_card ||
        (o.note && (o.note.note_id || o.note.noteId || o.note.display_title || o.note.displayTitle)) ||
        (o.noteCard && (o.noteCard.noteId || o.noteCard.note_id || o.noteCard.displayTitle || o.noteCard.display_title))
      ) && (o.note_id || o.noteId || o.note || o.noteCard), found, 0);
      found.forEach((o) => {
        const card = o.note_card || o.note || o.noteCard || o;
        const nid = String(o.note_id || o.noteId || card.note_id || card.noteId || card.id || "");
        if (!nid || seen.has(nid)) return;
        seen.add(nid);
        const parsed = parseXhsNote(nid, card, pageType === "author" ? "author_feed" : "detail");
        if (parsed) items.push(parsed);
      });
      // 结构2：直接带 image_list/imageList 的笔记对象（详情页/博主 SSR 常见结构）
      const found2 = [];
      walk(g, (o) => o && typeof o === "object" && ((Array.isArray(o.image_list) && o.image_list.length) || (Array.isArray(o.imageList) && o.imageList.length)) && (o.title || o.desc || o.display_title || o.displayTitle) && (o.interact_info || o.interactInfo || o.user), found2, 0);
      found2.forEach((o) => {
        const nid = String(o.note_id || o.noteId || id || "");
        if (!nid || seen.has(nid)) return;
        seen.add(nid);
        const parsed = parseXhsNote(nid, o, "detail");
        if (parsed) items.push(parsed);
      });
    }
    if (items.length) postItems("xhs", items, pageType === "author" ? "author_feed" : "detail");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(tryExtractFromWindow, 600);
    });
  } else {
    setTimeout(tryExtractFromWindow, 600);
  }
  window.addEventListener("load", () => {
    setTimeout(tryExtractFromWindow, 1200);
  });

  // 收到采集端指令：直接拉一次联想接口（兜底，页面输入框未触发时也能取词）
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "SMC_COLLECTOR" || msg.type !== "SUGGEST_REQUEST") return;
    try {
      fetch("/api/sns/web/v1/sug/recommend?keyword=" + encodeURIComponent(String(msg.keyword || "")) + "&lang=zh");
    } catch (e) { /* ignore */ }
  });
})();
