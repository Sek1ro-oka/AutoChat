/**
 * 分享卡片（T-063）的离线单测：不联网、不碰桥接，只测纯逻辑。
 *
 * 重点保三件容易回归的事：
 *   1. 内网地址必须拒（曾经因为正则里多写了个 `$`，127.0.0.1 一路穿透）；
 *   2. B站链接/BV号要能认出来；
 *   3. 卡片字段裁剪 + 封面上 https（http 封面在部分网络下会让卡片变灰块）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNewsArk, extractPageMeta, formatCount, formatDuration, parseBilibili, parseSafeUrl
} from '../src/share-card.js';

test('内网/非 http(s) 的地址一律拒', () => {
  for (const bad of [
    'http://127.0.0.1:3100', 'http://localhost:3000', 'http://10.0.0.5/x', 'http://192.168.1.1',
    'http://172.16.0.1', 'http://169.254.1.1', 'http://[::1]:80', 'http://0.0.0.0',
    'file:///c:/windows/win.ini', 'ftp://example.com/x', 'javascript:alert(1)',
    'http://intranet' // 没有点，多半是内网主机名
  ]) {
    assert.equal(parseSafeUrl(bad), null, `${bad} 应该被拒`);
  }
  assert.ok(parseSafeUrl('https://www.bilibili.com/video/BV1nJ4t67EG4'));
  assert.ok(parseSafeUrl('http://example.com/a'));
});

test('B站链接与 BV/av 号都能认', () => {
  assert.deepEqual(parseBilibili('BV1nJ4t67EG4'), { kind: 'video', bvid: 'BV1nJ4t67EG4' });
  assert.deepEqual(parseBilibili('看这个 https://www.bilibili.com/video/BV1nJ4t67EG4?p=1 好笑'), { kind: 'video', bvid: 'BV1nJ4t67EG4' });
  assert.deepEqual(parseBilibili('av12345'), { kind: 'video', aid: 12345 });
  assert.deepEqual(parseBilibili('https://www.bilibili.com/bangumi/play/ep123'), { kind: 'bangumi', id: 'ep123' });
  assert.equal(parseBilibili('https://www.youtube.com/watch?v=abc'), null);
});

test('数字与时长格式化', () => {
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(12345), '1.2万');
  assert.equal(formatCount(272000), '27.2万');
  assert.equal(formatCount(123456789), '1.2亿');
  assert.equal(formatDuration(324), '5:24');
  assert.equal(formatDuration(3725), '1:02:05');
});

test('ark 组包：字段裁剪、封面升 https、uin 是数字', () => {
  const ark = buildNewsArk({
    title: 'x'.repeat(300),
    desc: 'd',
    jumpUrl: 'https://www.bilibili.com/video/BV1',
    preview: 'http://i0.hdslb.com/a.jpg',
    tag: '哔哩哔哩',
    uin: '3928753720'
  });
  assert.equal(ark.app, 'com.tencent.structmsg');
  assert.equal(ark.view, 'news');
  assert.equal(ark.meta.news.title.length, 120);
  assert.equal(ark.meta.news.preview, 'https://i0.hdslb.com/a.jpg');
  assert.equal(ark.meta.news.uin, 3928753720);
  assert.ok(ark.prompt.startsWith('[分享]'));
  // 没有封面时不要塞空字符串：QQ 会把它当坏图地址
  const noCover = buildNewsArk({ title: 't', jumpUrl: 'https://a.com' });
  assert.equal('preview' in noCover.meta.news, false);
});

test('og 标签两种属性顺序都要认', () => {
  const a = extractPageMeta('<meta property="og:title" content="标题A"><meta property="og:image" content="/c.png">', 'https://a.com/x');
  assert.equal(a.title, '标题A');
  assert.equal(a.image, 'https://a.com/c.png');
  const b = extractPageMeta('<meta content="标题B" property="og:title"><title>兜底</title>');
  assert.equal(b.title, '标题B');
  const c = extractPageMeta('<title>只有 title</title>');
  assert.equal(c.title, '只有 title');
  assert.equal(extractPageMeta('').title, '');
});
