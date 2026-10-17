// 素材库两个子页的回归测试（T-034）。
//
// 表情包与黑话都曾经「库里一有数据就整页崩」：两页把拼好的整段 <tr> 交给 table()，
// 而 table() 的契约是「每行一个单元格数组」（core.js:227 就是 cells.map(...)），
// 于是只要 entries 非空就抛 TypeError，页面上什么表格都没有。
// 下面的用例不检查行构造函数返回什么形状，只让页面真的把库里的数据画成表格：
// 形状错了、少一列、令牌丢了，任意一条都会红。
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { loadConsoleScripts, slangFixture, stickerFixture } from './support/console-harness.js';

// loadConsoleScripts 会连 app.js 的 boot() 一起跑，首屏渲染的请求可能和用例抢跑：
// 照 console-pages.test.js 的做法先等它落地，再手动渲染要看的那一页。
const loaded = async base => {
  const result = loadConsoleScripts(base);
  await new Promise(resolve => setTimeout(resolve, 150));
  return result;
};

// 切换子页在应用里是「改 assetsState.tab 再重绘」，重绘最后落到 pages.assets()。
// 这里直接做第二步，省掉 boot() 那轮与本次断言无关的渲染。
const renderTab = (context, tab) => {
  vm.runInContext(`assetsState.tab = '${tab}'; assetsState.filter = 'all'; assetsState.entry = null;`, context);
  return context.__pages.assets();
};

test('the sticker library draws one row per picture instead of losing the page', async t => {
  const { server } = stickerFixture(t);
  await server.start();
  t.after(() => server.stop());
  const { context } = await loaded(`http://127.0.0.1:${server.address().port}`);

  const html = await context.__pages.assets(); // 默认页签就是表情包

  assert.match(html, /<table class="tbl">/);
  assert.equal(html.match(/<tr>/g).length, 4, '表头一行 + 三张图各一行');
  assert.match(html, /data-act="stickerEdit"/);
  assert.match(html, /data-act="stickerDelete"/);
  for (const id of ['cand01', 'conf02', 'man03']) assert.match(html, new RegExp(`data-id="${id}"`), `少了 ${id} 这一行`);
  // <img> 带不了请求头，缩略图只能靠网址上的 ?token= 拿字节——改行构造函数时最容易丢的就是它。
  assert.match(html, /src="\/api\/stickers\/image\?id=cand01&token=[^"]+"/);
  // conf02 没有 desc 只有 note，也没有 tags：这两格走的是备注与破折号分支。
  assert.match(html, /鼓掌的猫/);
  assert.match(html, /群里最爱的狗头/);
  assert.ok(!html.includes('undefined'), '不能把 undefined 画进单元格');
  // 「出现 / 用过 / 来源 / 操作」四格要 nowrap，但那是单元格内部的 <span>，不是 <td class="nowrap">。
  assert.match(html, /<span class="nowrap">/);
  assert.ok(!html.includes('<td class="nowrap">'), '单元格里不能再嵌一层 <td>');
});

test('the slang library draws one row per term, scoped groups and all', async t => {
  const { server, store } = slangFixture(t);
  await server.start();
  t.after(() => server.stop());
  store.upsertSlang({ content: 'yyds', meaning: '永远的神', status: 'confirmed', groups: ['20000'], now: 1800000000000 });
  store.upsertSlang({ content: 'awsl', meaning: '啊我死了', status: 'candidate', now: 1800000000000 });
  const { context } = await loaded(`http://127.0.0.1:${server.address().port}`);

  const html = await renderTab(context, 'slang');

  assert.match(html, /<table class="tbl">/);
  assert.equal(html.match(/<tr>/g).length, 3, '表头一行 + 两个词条各一行');
  assert.match(html, /<strong>yyds<\/strong>/);
  assert.match(html, /<strong>awsl<\/strong>/);
  assert.match(html, /data-act="slangEdit"/);
  // 绑了群的词条显示群号，没绑的显示「全局」：这一列是两页里唯一按数组渲染的。
  assert.match(html, /<td>20000<\/td>/);
  assert.match(html, /<td><span class="muted">全局<\/span><\/td>/);
  assert.ok(!html.includes('<td class="nowrap">'), '单元格里不能再嵌一层 <td>');
});

test('a term that carries no groups field falls back to global instead of throwing', async t => {
  const { server } = slangFixture(t);
  await server.start();
  t.after(() => server.stop());
  const { context } = await loaded(`http://127.0.0.1:${server.address().port}`);

  // /api/slang 的每条记录都带 groups（空数组也算），所以「字段缺失」只能直接喂给行构造函数：
  // 少了这个兜底，row.groups.length 就是 TypeError，而页面本身永远走不到这一支。
  const cells = vm.runInContext(`slangRow({ id: 'x1', term: '绝了', meaning: '太好了', status: 'confirmed', count: 2 })`, context);
  assert.ok(Array.isArray(cells), '行必须是单元格数组，不是拼好的 <tr>');
  assert.equal(cells.length, 6);
  assert.match(cells[3], /全局/);
  const scoped = vm.runInContext(`slangRow({ id: 'x2', term: 'awsl', status: 'candidate', groups: ['20000'] })`, context);
  assert.match(scoped[3], /20000/);
  assert.doesNotMatch(scoped[3], /全局/);
});

test('an empty sticker library keeps the empty state instead of an empty table', async t => {
  const { server, store } = stickerFixture(t);
  await server.start();
  t.after(() => server.stop());
  const { context } = await loaded(`http://127.0.0.1:${server.address().port}`);

  // 让库变成 0 张：只删记录，临时目录照旧交给夹具的 t.after 清。
  for (const id of ['cand01', 'conf02', 'man03']) store.deleteSticker(id);
  const html = await context.__pages.assets();

  assert.match(html, /这一分类下没有图片/);
  assert.ok(!html.includes('<table'), '没有数据就不该出表格');
  assert.ok(!html.includes('alert-err'), '空库不是错误');
});

test('an empty slang library keeps the empty state instead of an empty table', async t => {
  const { server } = slangFixture(t); // 只有一条群消息，一条词条都没有
  await server.start();
  t.after(() => server.stop());
  const { context } = await loaded(`http://127.0.0.1:${server.address().port}`);

  const html = await renderTab(context, 'slang');

  assert.match(html, /这一分类下没有词条/);
  assert.ok(!html.includes('<table'), '没有数据就不该出表格');
  assert.ok(!html.includes('alert-err'), '空库不是错误');
});
