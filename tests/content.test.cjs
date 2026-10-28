const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = readFileSync(require('node:path').join(__dirname, '../background.js'), 'utf8');
const parser = source.slice(source.indexOf('async function parseWithFallback'), source.indexOf('// 调在线去水印服务'));
(async () => {
  let secondCalls = 0;
  const context = vm.createContext({ dl: { parseMode: 'safe' }, hasMedia: o => !!o?.imgList?.length,
    fetchOnlineParse: async () => ({ imgList: ['cover.jpg'] }),
    fetchWanyiSsr: async () => { secondCalls++; return { content: '完整正文\n第二行' }; }
  });
  vm.runInContext(parser, context);
  assert.equal((await context.parseWithFallback('https://example.test', 'content')).obj.content, '完整正文\n第二行');
  assert.equal(secondCalls, 1, 'media-only result must not stop content fallback');
  secondCalls = 0;
  assert.equal((await context.parseWithFallback('https://example.test')).obj.imgList[0], 'cover.jpg');
  assert.equal(secondCalls, 0, 'media download retains its original success criterion');
  const ssr = source.slice(source.indexOf('function parseXhsSsr'), source.indexOf('async function fetchWanyiSsr'));
  vm.runInContext(ssr, context);
  const html = '<script>window.__INITIAL_STATE__=' + JSON.stringify({ note: { noteDetailMap: { abc: { note: { title: '测试', desc: '正文', imageList: [] } } } } }) + '</script>';
  assert.equal(context.parseXhsSsr(html, 'https://www.xiaohongshu.com/explore/abc').content, '正文');
  assert.equal(context.parseXhsSsr(html, 'https://www.xiaohongshu.com/explore/other'), null, 'never export another note as target');
  const dlFn = source.slice(source.indexOf('async function doDownloadEntry'), source.indexOf('// 收尾：回写库存'));
  assert.ok(!/\bpurpose\b/.test(dlFn), 'doDownloadEntry must not reference the parser-only purpose variable');
  console.log('Passed: content fallback, media fallback, SSR matching and mismatched note rejection');
})().catch(e => { console.error(e); process.exitCode = 1; });
