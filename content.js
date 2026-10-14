// content.js — 隔离世界：接收主世界 hook.js 解析好的数据，转发给后台；
// 负责采集会话状态（搜索）、自动滚动、最低门槛过滤。
(() => {
  if (window.__smcCollectorInstalled) return;
  window.__smcCollectorInstalled = true;

  const state = {
    session: null, // {type:'search'|'author', platform, keyword, minLikes, minCollects, minComments, max, timeRangeSec, stopScroll}
    seenIds: new Set(),
    buffer: [], // 无会话时缓存博主/详情数据，等会话启动后补发（防竞态丢数据）
    suggestSession: null, // {type:'suggest', seeds, index, words, pendingSeed, pendingWords, stop}
    commentsSession: null, // {active, noteId, minLikes, maxComments, seen, comments, stop}
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function siteFromUrl(url) {
    try {
      const u = new URL(url);
      return /xiaohongshu\.com$/.test(u.hostname) ? "xhs" : "";
    } catch (e) { /* ignore */ }
    return "";
  }

  function keywordFromUrl(url) {
    try {
      const u = new URL(url);
      return /xiaohongshu\.com$/.test(u.hostname) ? (u.searchParams.get("keyword") || "").trim() : "";
    } catch (e) { /* ignore */ }
    return "";
  }

  function sendMessage(message) {
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) { /* 扩展上下文不可用时忽略 */ }
  }

  function bufferIncoming(platform, items, sourceType) {
    const now = Date.now();
    state.buffer = state.buffer.filter((b) => now - b.at < 60000);
    state.buffer.push({ platform, items, sourceType, at: now });
    if (state.buffer.length > 200) state.buffer.splice(0, state.buffer.length - 200);
  }

  function flushBuffer() {
    const now = Date.now();
    state.buffer = state.buffer.filter((b) => now - b.at < 60000);
    const flushed = state.buffer;
    state.buffer = [];
    flushed.forEach((b) => forwardIfSession(b.platform, b.items, b.sourceType));
  }

  // 统一转发：有会话则过滤+转发；无会话且是博主/详情数据则缓存
  function forwardIfSession(platform, items, sourceType) {
    if (!state.session) {
      if (sourceType === "author_feed" || sourceType === "detail") bufferIncoming(platform, items, sourceType);
      return;
    }
    const isSearchSession = state.session.type === "search";
    let arr = Array.isArray(items) ? items : [];
    if (state.session.platform === platform) {
      if (isSearchSession) {
        // 最低互动门槛
        arr = arr.filter(
          (n) =>
            (n.stats.likes || 0) >= state.session.minLikes &&
            (n.stats.collects || 0) >= state.session.minCollects &&
            (n.stats.comments || 0) >= state.session.minComments
        );
        // 时间范围过滤（按发布时间，兜底页面参数不生效的情况）
        if (state.session.timeRangeSec > 0) {
          const cutoff = Date.now() - state.session.timeRangeSec * 1000;
          arr = arr.filter((n) => {
            if (!n.post_time) return true;
            const t = new Date(n.post_time).getTime();
            return Number.isFinite(t) && t >= cutoff;
          });
        }
        // 类型筛选：全部 / 图文 / 视频
        if (state.session.typeFilter === "video") {
          arr = arr.filter((n) => n.type === "video" || ((n.video_urls || []).length > 0));
        } else if (state.session.typeFilter === "image") {
          arr = arr.filter((n) => n.type !== "video" && ((n.video_urls || []).length === 0));
        }
      }
      // 上限（搜索 & 博主通用）
      const remaining = Math.max(0, state.session.max - state.seenIds.size);
      if (remaining <= 0) return;
      arr = arr.slice(0, remaining);
    }
    arr = arr.filter((n) => n && n.id);
    if (!arr.length) return;
    arr.forEach((n) => state.seenIds.add(`${platform}:${n.id}`));
    try {
      console.log(
        "[社媒采集] 转发",
        platform,
        (state.session && state.session.keyword) || keywordFromUrl(location.href) || "",
        arr.length,
        "条，已收",
        state.seenIds.size,
        "/",
        state.session.max
      );
    } catch (e) { /* ignore */ }
    sendMessage({
      type: "SMC_ITEMS",
      platform,
      keyword: (state.session && state.session.keyword) || keywordFromUrl(location.href) || "",
      sourceType: sourceType || "search",
      items: arr,
      pageUrl: location.href,
    });
  }

  // 接收主世界 hook 的消息
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "SMC_HOOK") return;
    const platform = msg.platform;
    if (msg.type === "COMMENTS") {
      const sess = state.commentsSession;
      if (!sess || !sess.active) return;
      (msg.comments || []).forEach((c) => {
        if (!c || !c.comment_id || sess.seen.has(c.comment_id)) return;
        sess.seen.add(c.comment_id);
        if ((Number(c.like_count) || 0) < sess.minLikes) return;
        if (sess.comments.length >= sess.maxComments) return;
        sess.comments.push(Object.assign({}, c, {
          note_id: sess.noteId || msg.noteId || "",
          xsec_token: msg.xsecToken || c.xsec_token || "",
        }));
      });
      return;
    }
    if (msg.type === "SUGGEST") {
      if (state.suggestSession && state.suggestSession.pendingSeed) {
        const arr = state.suggestSession.pendingWords;
        (msg.words || []).forEach((w) => {
          w = String(w || "").trim();
          if (w && !arr.includes(w)) arr.push(w);
        });
      }
      return;
    }
    if (msg.type !== "ITEMS") return;
    forwardIfSession(platform, msg.items, msg.sourceType);
  });

  // 分段随机滚动：滚一段停一下，偶尔滚到底/点「加载更多」，更像真人
  function scrollSegmented() {
    try {
      // 分段：随机滚一段（不是每次跳到底）
      const delta = 500 + Math.random() * 1500;
      window.scrollBy(0, delta);
      // 偶尔滚到底触发懒加载
      if (Math.random() < 0.3) {
        window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight);
      }
      // 可滚动容器也分段滚一段
      const els = document.querySelectorAll("body *");
      for (const el of els) {
        if (el.scrollHeight > el.clientHeight + 80 && el.scrollTop < el.scrollHeight - el.clientHeight - 200) {
          el.scrollTop += 300 + Math.random() * 700;
        }
      }
      window.dispatchEvent(new Event("scroll"));
      document.dispatchEvent(new Event("scroll"));
    } catch (e) { /* ignore */ }
    // 偶尔点「加载更多」
    if (Math.random() < 0.15) {
      try {
        const btns = Array.from(document.querySelectorAll("button, [role=button], span, div"));
        for (const b of btns) {
          const t = (b.innerText || "").trim();
          if (t && t.length < 12 && /加载更多|查看更多|展开/.test(t) && b.offsetParent !== null) {
            try { b.click(); } catch (e) { /* ignore */ }
            break;
          }
        }
      } catch (e) { /* ignore */ }
    }
  }

  // ---- 自动滚动加载更多（搜索 / 博主会话） ----
  async function autoScrollSearch() {
    const sess = state.session;
    if (!sess) return;
    let idleStreak = 0;
    let lastCount = state.seenIds.size;
    let iterations = 0;
    const roundLimit = 20; // 每轮最多 20 条
    let roundStart = state.seenIds.size;
    const graceUntil = Date.now() + 15000; // 前 15 秒不因「暂无内容」退出（页面加载慢）
    // 最多滚动 160 次，防止个别页面无限加载
    while (
      state.session === sess &&
      !sess.stopScroll &&
      state.seenIds.size < sess.max &&
      iterations < 160
    ) {
      iterations += 1;
      scrollSegmented();
      await sleep(1500 + Math.random() * 2500); // 每步 1.5~4 秒随机
      if (state.session !== sess || sess.stopScroll) break;
      const count = state.seenIds.size;
      if (count > lastCount) {
        idleStreak = 0;
      } else if (Date.now() < graceUntil) {
        idleStreak = 0; // 还在宽限期：继续等页面出数据
      } else {
        idleStreak += 1;
      }
      lastCount = count;
      // 宽限期后连续 8 次无新内容才结束
      if (idleStreak >= 8) break;
      // 每收满 20 条，长暂停 5~25 秒（多轮、随机间隔，降低风控信号）
      if (state.seenIds.size - roundStart >= roundLimit) {
        roundStart = state.seenIds.size;
        await sleep(5000 + Math.random() * 20000);
        if (state.session !== sess || sess.stopScroll) break;
      }
    }
    if (state.session === sess) state.session = null;
    try {
      console.log("[社媒采集] 页面采集结束", sess.keyword || "", "共收", state.seenIds.size, "条 / 上限", sess.max);
    } catch (e) { /* ignore */ }
    sendMessage({
      type: "SMC_SCROLL_FINISHED",
      platform: sess.platform,
      keyword: sess.keyword || keywordFromUrl(location.href),
    });
  }

  // ---- 下拉词采集：模拟输入触发联想 + 兜底直接拉接口 ----
  function requestSuggestWords(seed) {
    try {
      const input = document.querySelector("#search-input") ||
        document.querySelector("input[placeholder*='搜']") ||
        document.querySelector("input[type='search']") ||
        document.querySelector(".search-input input") ||
        document.querySelector("input.input");
      if (input) {
        input.focus();
        const proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
        const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
        if (setter && setter.set) setter.set.call(input, seed);
        else input.value = seed;
        const evts = ["keydown", "keyup", "input", "change", "compositionend", "focus"];
        evts.forEach((name) => {
          try { input.dispatchEvent(new Event(name, { bubbles: true })); } catch (e) { /* ignore */ }
        });
        try { input.blur(); input.focus(); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    window.postMessage({ source: "SMC_COLLECTOR", type: "SUGGEST_REQUEST", keyword: seed }, "*");
  }

  async function runSuggestQueue() {
    const sess = state.suggestSession;
    if (!sess) return;
    while (sess && !sess.stop && sess.index < sess.seeds.length) {
      const seed = sess.seeds[sess.index];
      sess.pendingSeed = seed;
      sess.pendingWords = [];
      requestSuggestWords(seed);
      // 等待联想词返回（每种子词最多尝试 3 次，共约 10 秒）
      for (let attempt = 0; attempt < 3 && state.suggestSession === sess && sess.pendingSeed === seed; attempt++) {
        await sleep(3500);
        if (state.suggestSession !== sess || sess.pendingSeed !== seed) break;
        if (sess.pendingWords.length) break;
        requestSuggestWords(seed);
      }
      if (state.suggestSession === sess && sess.pendingSeed === seed) {
        (sess.pendingWords || []).forEach((w) => {
          if (!sess.words.includes(w)) sess.words.push(w);
        });
        sess.pendingSeed = null;
        sess.pendingWords = [];
        try {
          console.log("[社媒采集] 下拉词", seed, "→", sess.words.length, "个");
        } catch (e) { /* ignore */ }
        sendMessage({
          type: "SMC_SUGGEST_PROGRESS",
          seed,
          seedIndex: sess.index,
          total: sess.seeds.length,
          words: sess.words.slice(),
        });
        sess.index += 1;
        if (!sess.stop && sess.index < sess.seeds.length) {
          await sleep(4000 + Math.random() * 6000); // 词与词之间随机等待，降低风控信号
        }
      }
    }
    if (state.suggestSession === sess) {
      sendMessage({ type: "SMC_SUGGEST_FINISHED", words: (sess && sess.words) || [] });
      state.suggestSession = null;
    }
  }

  // ---- 评论采集：滚动 + 点「查看全部评论」触发页面原生评论接口 ----
  function clickViewAllComments() {
    try {
      const btns = Array.from(document.querySelectorAll("button, [role=button], span, div"));
      for (const b of btns) {
        const t = (b.innerText || "").trim();
        if (!t || t.length > 18) continue;
        if (/查看全部评论|查看更多回复|展开|加载更多|查看评论/.test(t) && b.offsetParent !== null) {
          try { b.click(); } catch (e) { /* ignore */ }
          return;
        }
      }
    } catch (e) { /* ignore */ }
  }

  async function runCommentsCollect() {
    const sess = state.commentsSession;
    if (!sess) return;
    let idle = 0;
    let lastCount = 0;
    const startedAt = Date.now();
    const graceUntil = startedAt + 12000; // 页面加载缓冲
    const maxMs = 90000; // 每篇最多采 90 秒，避免一直滚动
    for (let i = 0; i < 40 && state.commentsSession === sess && !sess.stop; i++) {
      if (Date.now() - startedAt > maxMs) break;
      scrollSegmented();
      clickViewAllComments();
      await sleep(1500 + Math.random() * 2000);
      if (state.commentsSession !== sess || sess.stop) break;
      const count = sess.comments.length;
      if (count > lastCount) idle = 0;
      else if (Date.now() < graceUntil) idle = 0;
      else idle += 1;
      lastCount = count;
      // 到底了（连续 5 轮无新评论）或收满上限就结束
      if (sess.comments.length >= sess.maxComments || idle >= 5) break;
    }
    let title = "";
    try {
      title = (document.title || "").replace(/[_\-].*小红书.*$/i, "").trim();
    } catch (e) { /* ignore */ }
    if (state.commentsSession === sess) {
      sendMessage({
        type: "SMC_COMMENTS_FINISHED",
        noteId: sess.noteId,
        noteTitle: title || sess.noteId,
        comments: sess.comments.slice(),
      });
      state.commentsSession = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "SMC_READ_CONTENT") {
      const match = location.pathname.match(/\/(?:explore|discovery\/item|search_result)\/([a-zA-Z0-9]+)/);
      if (!match || match[1] !== String(msg.noteId)) {
        sendResponse({ ok: false });
        return;
      }
      const el = document.querySelector('#detail-desc .note-text, #detail-desc, .note-content .desc');
      const content = el ? String(el.innerText || el.textContent || "").trim() : "";
      sendResponse({ ok: !!content, content });
      return;
    }

    if (msg && (msg.type === "SMC_START_SEARCH" || msg.type === "SMC_START_AUTHOR")) {
      const isAuthor = msg.type === "SMC_START_AUTHOR";
      const platform = msg.platform || siteFromUrl(location.href);
      const keyword = (msg.keyword || "").trim();
      const sessType = isAuthor ? "author" : "search";
      // 幂等：同一类型+关键词的会话已在进行，忽略重发（onUpdated 会触发多次）
      if (
        state.session &&
        state.session.type === sessType &&
        state.session.platform === platform &&
        state.session.keyword === keyword
      ) {
        sendResponse({ ok: true, already: true });
        return true;
      }
      state.session = {
        type: sessType,
        platform,
        keyword,
        minLikes: Number(msg.minLikes) || 0,
        minCollects: Number(msg.minCollects) || 0,
        minComments: Number(msg.minComments) || 0,
        max: Number(msg.max) || 200,
        timeRangeSec: Number(msg.timeRangeSec) || 0,
        typeFilter: msg.typeFilter || "",
        stopScroll: false,
      };
      state.seenIds.clear();
      flushBuffer(); // 补发会话就绪前已到达的数据
      autoScrollSearch();
      sendResponse({ ok: true });
      return true;
    }
    if (msg && msg.type === "SMC_START_LINK") {
      const platform = msg.platform || siteFromUrl(location.href);
      state.session = {
        type: "link",
        platform,
        keyword: "",
        minLikes: 0,
        minCollects: 0,
        minComments: 0,
        max: Number(msg.max) || 5,
        timeRangeSec: 0,
        typeFilter: "",
        stopScroll: false,
      };
      state.seenIds.clear();
      flushBuffer(); // 补发会话就绪前已到达的详情数据
      // 详情页数据到达后稍等即结束本页，交给后台开下一条链接
      setTimeout(() => {
        if (state.session && state.session.type === "link" && !state.session.stopScroll) {
          state.session = null;
          sendMessage({ type: "SMC_SCROLL_FINISHED", platform, keyword: "" });
        }
      }, 8000);
      sendResponse({ ok: true });
      return true;
    }
    if (msg && msg.type === "SMC_START_SUGGEST") {
      const platform = msg.platform || siteFromUrl(location.href);
      if (state.suggestSession) {
        sendResponse({ ok: true, already: true });
        return true;
      }
      state.suggestSession = {
        type: "suggest",
        platform,
        seeds: (msg.seeds || []).map((x) => String(x).trim()).filter(Boolean),
        index: 0,
        words: [],
        pendingSeed: null,
        pendingWords: [],
        stop: false,
      };
      sendResponse({ ok: true });
      runSuggestQueue();
      return true;
    }
    if (msg && msg.type === "SMC_START_COMMENTS") {
      const platform = msg.platform || siteFromUrl(location.href);
      if (state.commentsSession && state.commentsSession.active) {
        sendResponse({ ok: true, already: true });
        return true;
      }
      state.commentsSession = {
        active: true,
        platform,
        noteId: String(msg.noteId || ""),
        minLikes: Number(msg.minLikes) || 0,
        maxComments: Number(msg.maxComments) || 50,
        seen: new Set(),
        comments: [],
        stop: false,
      };
      sendResponse({ ok: true });
      runCommentsCollect();
      return true;
    }
    if (msg && msg.type === "SMC_STOP") {
      if (state.session) state.session.stopScroll = true;
      state.session = null;
      if (state.suggestSession) state.suggestSession.stop = true;
      state.suggestSession = null;
      if (state.commentsSession) state.commentsSession.stop = true;
      state.commentsSession = null;
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
})();
