// trend.js — 趋势分析纯函数（无 DOM 依赖，便于测试）
// 用浏览器原生 Intl.Segmenter 做中文分词 + 简化 TF-IDF，近似桌面版 jieba 分析。

const XHS_STOP_WORDS = new Set(("一个 我们 你们 他们 她们 它们 这个 那个 这些 那些 什么 怎么 可以 没有 还是 因为 所以 但是 如果 就是 非常 真的 已经 现在 然后 还有 或者 关于 对于 通过 进行 使用 用户 内容 笔记 分享 大家 自己 东西 时候 这样 那样 一些 很多 不是 不要 不会 不能 应该 可能 知道 觉得 看到 感觉 比较 有点 特别 其实 不过 虽然 而且 以及 并且 即使 随着 由于 因此 此外 同时 最后 首先 其中 之间 以上 以下 相关 部分 其他 所有 每个 任何 一种 各种 来自 根据 按照 比如 例如 需要 必须 能够 正在 将要 只是 还是 就是 对 从 在 于 到 把 被 让 给 向 为 以 用 由 中 上 下 里 外 前 后 等 都 也 又 就 才 再 更 最 很 太 好 是 的 了 着 过 吗 呢 啊 吧 呀 嘛 哦 嗯 与 和 或 及").split(/\s+/));

function xhsSegmentChinese(text) {
  const tokens = [];
  try {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      const seg = new Intl.Segmenter("zh", { granularity: "word" });
      for (const part of seg.segment(text)) {
        if (!part.isWordLike) continue;
        const w = part.segment.trim().toLowerCase();
        if (!w || !/[\u4e00-\u9fa5]/.test(w)) continue;
        tokens.push(w);
      }
    } else {
      // 极老浏览器兜底：双字组合
      const chars = text.replace(/[^\u4e00-\u9fa5]/g, "");
      for (let i = 0; i < chars.length - 1; i += 1) tokens.push(chars.slice(i, i + 2));
    }
  } catch (e) {
    /* ignore */
  }
  return tokens.filter((w) => w.length >= 2 && w.length <= 6 && !XHS_STOP_WORDS.has(w));
}

function xhsAnalyzeTrend(notes) {
  if (!Array.isArray(notes) || !notes.length) return null;
  const N = notes.length;
  const df = {};
  const tf = {};
  let totalLikes = 0;
  let totalCollects = 0;
  let totalComments = 0;
  let maxLikes = 0;
  for (const n of notes) {
    totalLikes += Number(n.liked_count) || 0;
    totalCollects += Number(n.collected_count) || 0;
    totalComments += Number(n.comment_count) || 0;
    maxLikes = Math.max(maxLikes, Number(n.liked_count) || 0);
    const text = `${n.title || ""} ${n.content || ""}`;
    const seen = new Set();
    for (const w of xhsSegmentChinese(text)) {
      tf[w] = (tf[w] || 0) + 1;
      seen.add(w);
    }
    seen.forEach((w) => { df[w] = (df[w] || 0) + 1; });
  }
  const terms = Object.keys(tf)
    .map((w) => ({
      word: w,
      weight: tf[w] * (Math.log((N + 1) / ((df[w] || 0) + 1)) + 1),
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 15);
  return {
    total: N,
    avgLikes: Math.round(totalLikes / N),
    avgCollects: Math.round(totalCollects / N),
    avgComments: Math.round(totalComments / N),
    maxLikes,
    terms,
  };
}
