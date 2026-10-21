// src/mcp-heybox-safe.js 的单测。**不碰真实 CLI、不写真实 state/**：
// runCli 全是假的，state 目录用 fs.mkdtempSync(os.tmpdir()) 里的临时目录，测完删掉。
//
// 用法：node scripts/test-heybox-tools.mjs
//
// 覆盖组：
//   1. buildCliEnv：代理变量清干净、NO_PROXY 重设、Python UTF-8 钉死
//   2. heybox_status：登录态 / 额度 / 暂停 / CLI 不可用降级 / canComment 四个条件 /
//      commentMode 三态回显（live / dry_run / readonly）+ captchaPauseMs 生效值
//   3. heybox_feed：瘦身字段、HTML 清理、摘要与图片上限、limit 夹取
//   4. heybox_post：富文本转纯文本、评论合并与截断、条数夹取、参数校验
//   5. heybox_search：items.info 取字段、`<em>` 清掉、query 校验、参数拼装
//   6. heybox_comment 四道闸门：开关、审计、额度/间隔、重复（含「只比最近 5 条」）
//   7. heybox_comment 真发：成功记账 + 回读校验（messageId 优先用 CLI 返回值、其次回读命中，
//      回读不到记 readback=not_found）、失败不记账、验证码按 captchaPauseMs 暂停
//      （默认 30 分钟，看帖/搜索/评论共用同一窗口；读接口撞验证码也落盘），暂停到点自动恢复
//   8. CLI 错误映射：auth / captcha / rate_limit / unknown / local / protocol
//   9. 落盘：usage 字段、actions.jsonl 每行结构、配置每次重读
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHeyboxTools, buildCliEnv, DEFAULT_STATE_DIR, registerHeyboxTools } from '../src/heybox-tools.js';
import { dayKeyOf } from '../src/heybox-core.js';

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}`);
    return true;
  }
  failed += 1;
  console.error(`❌ ${name}${extra === '' ? '' : `\n   ${extra}`}`);
  return false;
}

/** 键排序后的结构比较：避免「字段顺序不同」被当成失败。 */
function stable(value) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const key of Object.keys(node).sort()) out[key] = walk(node[key]);
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

function same(name, actual, expected) {
  return check(name, stable(actual) === stable(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

/** 返回值必须是 JSON 可序列化的朴素对象（MCP 会把它塞进 text content）。 */
function serializable(name, value) {
  let text = '';
  try {
    text = JSON.stringify(value);
  } catch (error) {
    return check(name, false, String(error));
  }
  return check(name, typeof text === 'string' && text !== '' && text !== undefined, `text=${text}`);
}

// ── 固定时间：北京时间 2026-10-14 10:00 ─────────────────────────────────────
const FIXED_NOW = Date.UTC(2026, 9, 14, 2, 0, 0);
const BEIJING_DAY = dayKeyOf(FIXED_NOW);
const TODAY_END = Date.UTC(2026, 9, 14, 16, 0, 0); // 北京时间当天 24:00
const ME_ID = '105716368';

const ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'heybox-tools-test-'));
let dirSeq = 0;
function freshStateDir() {
  const dir = path.join(ROOT_TMP, `state-${++dirSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── 假 CLI ─────────────────────────────────────────────────────────────────
// argv 形如 ['-f','json',<子命令>,…]：全局 flag 占前两位，子命令从索引 2 开始。
const mAuth = (argv) => argv[2] === 'auth' && argv[3] === 'status';
const mFeed = (argv) => argv[2] === 'feed';
const mPostGet = (argv) => argv[2] === 'post' && argv[3] === 'get';
const mSearch = (argv) => argv[2] === 'search';
const mComment = (argv) => argv[2] === 'comment' && argv[3] === 'create';

function json(value, code = 0) {
  return { stdout: JSON.stringify(value), stderr: '', code };
}

/**
 * `routes` 是 [{ match(argv), reply(argv, options) }]；reply 可以是对象或函数。
 * 没配到的调用直接抛错 —— 测试里「不该发生的 CLI 调用」会立刻炸出来。
 */
function cliStub(routes) {
  const calls = [];
  const runCli = async (argv, options = {}) => {
    calls.push({ argv: [...argv], timeoutMs: options.timeoutMs, cliPath: options.cliPath });
    for (const item of routes) {
      if (item.match(argv)) {
        return typeof item.reply === 'function' ? item.reply(argv, options) : item.reply;
      }
    }
    throw new Error(`测试没配置这条 CLI 调用：${argv.join(' ')}`);
  };
  return { runCli, calls };
}

function makeTools(options = {}) {
  const {
    routes = [],
    config = { heybox: { allowComment: true } },
    dir = freshStateDir(),
    clock = () => FIXED_NOW,
  } = options;
  const stub = cliStub(routes);
  const tools = createHeyboxTools({
    runCli: stub.runCli,
    readConfig: () => config,
    now: clock,
    stateDir: dir,
  });
  return { tools, stub, dir, config };
}

function countCalls(stub, match) {
  return stub.calls.filter((call) => match(call.argv)).length;
}

// ── 假数据 ─────────────────────────────────────────────────────────────────
function feedLink(overrides = {}) {
  return {
    linkid: 193660114,
    title: ' 黑神话悟空 二周目 体验 ',
    description: '打完了<b>二郎神</b>，说点感想',
    user: { userid: 42, username: 'Jackpot', avatar: 'https://img/avatar.jpg' },
    comment_num: 175,
    link_award_num: 12,
    create_at: 1791954860,
    imgs: ['https://img/1.jpg', 'https://img/2.jpg', 'https://img/3.jpg', 'https://img/4.jpg'],
    topics: [{ name: '黑神话悟空' }, { name: '单机游戏' }, '纯字符串话题', { name: '黑神话悟空' }],
    ...overrides,
  };
}

function feedPayload(links) {
  return json({ ok: true, data: { result: { links } } });
}

function commentFixture(overrides = {}) {
  return {
    commentid: 880001,
    text: '这个boss真难\n第二行 [cube_开心]',
    userid: 1,
    user: { username: '小黑盒用户' },
    create_at: 1791954860,
    up: 63,
    child_num: 2,
    floor_num: 7,
    ...overrides,
  };
}

function postPayload({ link = {}, comments = [{ comment: [commentFixture()] }] } = {}) {
  return json({
    ok: true,
    data: {
      result: {
        link: {
          linkid: 193660114,
          title: '黑神话悟空 二周目 体验',
          text: JSON.stringify([{ text: '<p>第一段 <b>重点</b></p><p>第二段<br>换行</p>' }]),
          user: { userid: 42, username: 'Jackpot' },
          create_at: 1791954860,
          comment_num: 175,
          thumbs: ['https://img/a.jpg', 'https://img/b.jpg', 'https://img/c.jpg', 'https://img/d.jpg', 'https://img/e.jpg', 'https://img/f.jpg'],
          ...link,
        },
        comments,
        total_floor_num: 75,
      },
    },
  });
}

function authOk(data = {}) {
  return json({ ok: true, data: { stored: true, authenticated: true, checked_online: true, user_id: ME_ID, ...data } });
}

const authRoute = (data = {}) => ({ match: mAuth, reply: () => authOk(data) });

/** 真发成功后回读时能看到的评论：text 完全一致 + 作者是自己。 */
function readbackRoute(text, overrides = {}) {
  return {
    match: mPostGet,
    reply: () => postPayload({ comments: [{ comment: [commentFixture({ text, userid: Number(ME_ID), ...overrides })] }] }),
  };
}

// ── 落盘辅助 ───────────────────────────────────────────────────────────────
function writeUsageFile(dir, patch = {}) {
  const state = { day: BEIJING_DAY, count: 0, lastTs: 0, pausedUntil: 0, pausedReason: '', ...patch };
  fs.writeFileSync(path.join(dir, 'heybox-usage.json'), `${JSON.stringify(state)}\n`, 'utf8');
  return state;
}

function readUsageFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'heybox-usage.json'), 'utf8'));
}

function usageExists(dir) {
  return fs.existsSync(path.join(dir, 'heybox-usage.json'));
}

function appendActions(dir, records) {
  const body = records.map((record) => JSON.stringify(record)).join('\n');
  fs.appendFileSync(path.join(dir, 'heybox-actions.jsonl'), `${body}\n`, 'utf8');
}

function readActions(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'heybox-actions.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function actionsExist(dir) {
  return fs.existsSync(path.join(dir, 'heybox-actions.jsonl'));
}

// 合法评论文本（过审计、不重复、够长）
const TEXT_A = '这个boss设计得真有意思，打了一晚上都不腻，明天继续';
const TEXT_NEAR = '这个boss设计得真有意思，打了一晚上都不腻，后天继续';

// ── 1. buildCliEnv ─────────────────────────────────────────────────────────
function testCliEnv() {
  console.log('\n[1] buildCliEnv：代理变量与编码');
  const base = {
    PATH: 'C:\\bin',
    HTTP_PROXY: 'http://127.0.0.1:7890',
    https_proxy: 'http://127.0.0.1:7890',
    ALL_PROXY: 'socks5://127.0.0.1:7890',
    NO_PROXY: '[::1],localhost',
    npm_config_proxy: 'http://127.0.0.1:7890',
    PYTHONUTF8: '0',
    HOME: 'C:\\Users\\MR',
  };
  const env = buildCliEnv(base);
  check('删掉 HTTP_PROXY', !('HTTP_PROXY' in env));
  check('删掉 https_proxy（大小写都匹配）', !('https_proxy' in env));
  check('删掉 ALL_PROXY', !('ALL_PROXY' in env));
  check('删掉 npm_config_proxy', !('npm_config_proxy' in env));
  check('NO_PROXY 被重设成 localhost,127.0.0.1', env.NO_PROXY === 'localhost,127.0.0.1', `actual=${String(env.NO_PROXY)}`);
  check('保留 PATH', env.PATH === 'C:\\bin');
  check('保留 HOME', env.HOME === 'C:\\Users\\MR');
  check('PYTHONIOENCODING 钉成 utf-8', env.PYTHONIOENCODING === 'utf-8');
  check('PYTHONUTF8 钉成 1', env.PYTHONUTF8 === '1');
  check('不修改传入的 base（copy 而非原地改）', base.HTTP_PROXY === 'http://127.0.0.1:7890' && base.NO_PROXY === '[::1],localhost');
  check('默认 state 目录叫 state', path.basename(DEFAULT_STATE_DIR) === 'state', `actual=${DEFAULT_STATE_DIR}`);
}

// ── 2. heybox_status ───────────────────────────────────────────────────────
async function testStatus() {
  console.log('\n[2] heybox_status');

  const ok = makeTools({ routes: [authRoute()] });
  const okResult = await ok.tools.status();
  check('status ok', okResult.ok === true);
  check('authenticated=true', okResult.authenticated === true);
  check('userId 取自 auth status', okResult.userId === ME_ID, `actual=${okResult.userId}`);
  check('usedToday=0', okResult.usedToday === 0);
  check('dailyComments=10（默认）', okResult.dailyComments === 10);
  check('remaining=10', okResult.remaining === 10);
  check('canComment=true（开关+额度+登录都过）', okResult.canComment === true);
  check('quotaReason=null', okResult.quotaReason === null);
  check('dryRunDefault=true', okResult.dryRunDefault === true);
  check('status 回显 commentMode=dry_run（allowComment=true + dryRunDefault=true）', okResult.commentMode === 'dry_run', `actual=${okResult.commentMode}`);
  check('status 的人话点明「只演练不发」并要求显式 dryRun=false', okResult.commentModeText.includes('只演练不发') && okResult.commentModeText.includes('dryRun=false'), `actual=${okResult.commentModeText}`);
  check('status 回显 captchaPauseMs 生效值（默认 30 分钟）', okResult.captchaPauseMs === 1800000, `actual=${okResult.captchaPauseMs}`);
  check('没暂停时不带 pauseRemainingText', !('pauseRemainingText' in okResult));
  check('pausedUntil=0', okResult.pausedUntil === 0);
  serializable('status 结果 JSON 可序列化', okResult);
  check('status 只调一次 auth status', ok.stub.calls.length === 1 && mAuth(ok.stub.calls[0].argv));
  check('status 的 CLI 超时是 60s', ok.stub.calls[0].timeoutMs === 60000, `actual=${ok.stub.calls[0].timeoutMs}`);

  const defaults = makeTools({ routes: [authRoute()], config: {} });
  const defaultResult = await defaults.tools.status();
  check('默认配置 allowComment=false', defaultResult.allowComment === false);
  check('默认配置下 canComment=false', defaultResult.canComment === false);
  check('默认配置 commentMode=readonly（人话说「不发评论」）', defaultResult.commentMode === 'readonly' && defaultResult.commentModeText.includes('allowComment=false'));

  const liveCfg = makeTools({ routes: [authRoute()], config: { heybox: { allowComment: true, dryRunDefault: false } } });
  const liveStatus = await liveCfg.tools.status();
  check('allowComment=true + dryRunDefault=false → commentMode=live', liveStatus.commentMode === 'live', `actual=${liveStatus.commentMode}`);
  check('live 的人话是「当前允许真发评论」', liveStatus.commentModeText.includes('当前允许真发评论'), `actual=${liveStatus.commentModeText}`);

  const offCfg = makeTools({ routes: [authRoute()], config: { heybox: { enabled: false } } });
  const offStatus = await offCfg.tools.status();
  check('enabled=false → commentMode=disabled', offStatus.commentMode === 'disabled' && offStatus.commentModeText.includes('enabled=false'));

  const customPauseCfg = makeTools({ routes: [authRoute()], config: { heybox: { allowComment: true, captchaPauseMs: 600000 } } });
  check('status 回显可配的 captchaPauseMs（600000）', (await customPauseCfg.tools.status()).captchaPauseMs === 600000);

  const usedDir = freshStateDir();
  writeUsageFile(usedDir, { count: 3, lastTs: FIXED_NOW - 3 * 3600 * 1000 });
  const used = makeTools({ routes: [authRoute()], dir: usedDir });
  const usedResult = await used.tools.status();
  check('usedToday 读自 usage 文件', usedResult.usedToday === 3, `actual=${usedResult.usedToday}`);
  check('remaining=7', usedResult.remaining === 7);

  const pausedDir = freshStateDir();
  writeUsageFile(pausedDir, { pausedUntil: FIXED_NOW + 3600 * 1000, pausedReason: 'captcha' });
  const paused = makeTools({ routes: [authRoute()], dir: pausedDir });
  const pausedResult = await paused.tools.status();
  check('暂停时 canComment=false', pausedResult.canComment === false);
  check('暂停原因透出 captcha', pausedResult.pausedReason === 'captcha');
  check('pausedUntil 透出时间戳', pausedResult.pausedUntil === FIXED_NOW + 3600 * 1000);
  check('暂停时 quotaReason=paused', pausedResult.quotaReason === 'paused');
  check('暂停时 status 带「还剩多久」', pausedResult.pauseRemainingText === '还剩 1 小时', `actual=${pausedResult.pauseRemainingText}`);

  const notLogged = makeTools({ routes: [{ match: mAuth, reply: () => json({ ok: true, data: { stored: false, authenticated: false } }) }] });
  const notLoggedResult = await notLogged.tools.status();
  check('未登录时 ok 仍为 true（CLI 本身可用）', notLoggedResult.ok === true);
  check('未登录时 authenticated=false', notLoggedResult.authenticated === false);
  check('未登录时 canComment=false', notLoggedResult.canComment === false);

  const broken = makeTools({ routes: [{ match: mAuth, reply: () => { throw new Error('spawn xiaoheihe-cli ENOENT'); } }] });
  const brokenResult = await broken.tools.status();
  check('CLI 起不来时 ok=false', brokenResult.ok === false);
  check('CLI 起不来时 code=local', brokenResult.code === 'local', `actual=${brokenResult.code}`);
  check('CLI 起不来时仍返回账号态 false', brokenResult.authenticated === false);
  check('CLI 起不来时仍返回额度信息', brokenResult.dailyComments === 10 && brokenResult.remaining === 10);
  check('CLI 起不来时有中文原因', typeof brokenResult.reason === 'string' && brokenResult.reason.includes('命令行调用失败'), `actual=${brokenResult.reason}`);

  const authDown = makeTools({ routes: [{ match: mAuth, reply: () => json({ ok: false, error: { code: 'auth', message: 'token 过期' } }, 1) }] });
  const authDownResult = await authDown.tools.status();
  check('登录态查询失败时 ok=false', authDownResult.ok === false);
  check('登录态查询失败时 code=auth', authDownResult.code === 'auth', `actual=${authDownResult.code}`);
  check('登录态失败文案是「重新扫码」', authDownResult.reason.includes('扫码登录'), `actual=${authDownResult.reason}`);

  const corruptDir = freshStateDir();
  fs.writeFileSync(path.join(corruptDir, 'heybox-usage.json'), '{不是 JSON', 'utf8');
  const corrupt = makeTools({ routes: [authRoute()], dir: corruptDir });
  const corruptResult = await corrupt.tools.status();
  check('usage 文件坏了不炸，usedToday 归零', corruptResult.ok === true && corruptResult.usedToday === 0);

  const cfgChange = makeTools({ routes: [authRoute()], config: { heybox: { allowComment: true, dailyComments: 4 } } });
  const before = await cfgChange.tools.status();
  cfgChange.config.heybox.dailyComments = 6;
  const after = await cfgChange.tools.status();
  check('配置每次调用重读（4 → 6）', before.dailyComments === 4 && after.dailyComments === 6, `before=${before.dailyComments} after=${after.dailyComments}`);

  const topOnly = makeTools({ routes: [authRoute()], config: { socialV2: { heybox: { allowComment: true, dailyComments: 2 } } } });
  const topOnlyResult = await topOnly.tools.status();
  check('配置只认顶层 heybox 段（socialV2.heybox 不算）', topOnlyResult.allowComment === false && topOnlyResult.dailyComments === 10);

  const throwingConfig = createHeyboxTools({
    runCli: cliStub([authRoute()]).runCli,
    readConfig: () => { throw new Error('config.json 读不了'); },
    now: () => FIXED_NOW,
    stateDir: freshStateDir(),
  });
  const fallback = await throwingConfig.status();
  check('读配置抛错时退回默认值（allowComment=false）', fallback.allowComment === false && fallback.dailyComments === 10);
}

// ── 3. heybox_feed ─────────────────────────────────────────────────────────
async function testFeed() {
  console.log('\n[3] heybox_feed');

  const { tools } = makeTools({ routes: [{ match: mFeed, reply: () => feedPayload([feedLink(), feedLink({ linkid: 193660115, title: '第二条' })]) }] });
  const result = await tools.feed({});
  check('feed ok', result.ok === true);
  check('feed count=2', result.count === 2);
  check('feed 默认返回 8 条上限内全部 2 条', result.items.length === 2);
  serializable('feed 结果 JSON 可序列化', result);

  const item = result.items[0];
  same('feed 只留约定字段', Object.keys(item).sort(), ['author', 'awardCount', 'commentCount', 'images', 'linkId', 'summary', 'title', 'topics']);
  check('linkId 是数字', typeof item.linkId === 'number' && item.linkId === 193660114, `actual=${JSON.stringify(item.linkId)}`);
  check('title 去首尾空白并压空格', item.title === '黑神话悟空 二周目 体验', `actual=${item.title}`);
  check('summary 去掉 HTML 标签', item.summary === '打完了二郎神，说点感想', `actual=${item.summary}`);
  check('author 取自 user.username', item.author === 'Jackpot');
  check('commentCount 是数字', item.commentCount === 175);
  check('awardCount 是数字', item.awardCount === 12);
  check('images 截到 3 张', item.images.length === 3, `actual=${item.images.length}`);
  check('images 保留原顺序', item.images[0] === 'https://img/1.jpg');
  same('topics 只留名字且去重', item.topics, ['黑神话悟空', '单机游戏', '纯字符串话题']);
  check('feed 不带原始 description 字段', !('description' in item) && !('user' in item) && !('create_at' in item));
  check('feed 不带 createAt（列表不需要时间）', !('createAt' in item));

  const links = Array.from({ length: 12 }, (_, i) => feedLink({ linkid: 193660200 + i, title: `第 ${i} 条` }));
  const many = makeTools({ routes: [{ match: mFeed, reply: () => feedPayload(links) }] });
  const defaultCount = await many.tools.feed({});
  check('limit 缺省 = 8', defaultCount.items.length === 8, `actual=${defaultCount.items.length}`);
  const two = await many.tools.feed({ limit: 2 });
  check('limit=2 只回 2 条', two.items.length === 2);
  const zero = await many.tools.feed({ limit: 0 });
  check('limit=0 夹到 1', zero.items.length === 1, `actual=${zero.items.length}`);
  const huge = await many.tools.feed({ limit: 99 });
  check('limit=99 夹到 20（CLI 只给 12 条，所以 12）', huge.items.length === 12, `actual=${huge.items.length}`);
  const tenOnly = makeTools({ routes: [{ match: mFeed, reply: () => feedPayload(links.slice(0, 10)) }] });
  const tenResult = await tenOnly.tools.feed({ limit: 20 });
  check('limit=20 但 CLI 固定 10 条 → 实际 10 条', tenResult.items.length === 10, `actual=${tenResult.items.length}`);
  const floatLimit = await many.tools.feed({ limit: 2.9 });
  check('limit=2.9 向下取整到 2', floatLimit.items.length === 2);
  const badLimit = await many.tools.feed({ limit: 'abc' });
  check('limit 非数字时退回默认 8', badLimit.items.length === 8);
  check('feed 不带 --limit 参数（CLI 不认）', many.stub.calls.every((call) => !call.argv.includes('--limit')));

  const noLinks = makeTools({ routes: [{ match: mFeed, reply: () => json({ ok: true, data: { result: {} } }) }] });
  const noLinksResult = await noLinks.tools.feed({});
  check('返回结构变了也不炸：ok + 空数组', noLinksResult.ok === true && noLinksResult.count === 0 && noLinksResult.items.length === 0);

  const stringReply = makeTools({ routes: [{ match: mFeed, reply: () => JSON.stringify({ ok: true, data: { result: { links: [] } } }) }] });
  const stringResult = await stringReply.tools.feed({});
  check('runCli 只回字符串也能解析', stringResult.ok === true && stringResult.count === 0);

  const disabled = makeTools({ routes: [], config: { heybox: { enabled: false } } });
  const disabledResult = await disabled.tools.feed({});
  check('总开关关掉时 feed 直接拒绝', disabledResult.ok === false && disabledResult.code === 'disabled');
  check('总开关关掉时一次 CLI 都不调', disabled.stub.calls.length === 0);

  const emptyImages = makeTools({ routes: [{ match: mFeed, reply: () => feedPayload([feedLink({ imgs: [], thumbs: [], topics: 'oops' })]) }] });
  const emptyResult = await emptyImages.tools.feed({ limit: 1 });
  check('没有图片时 images=[]', Array.isArray(emptyResult.items[0].images) && emptyResult.items[0].images.length === 0);
  check('topics 不是数组时 topics=[]', Array.isArray(emptyResult.items[0].topics) && emptyResult.items[0].topics.length === 0);
}

// ── 4. heybox_post ─────────────────────────────────────────────────────────
async function testPost() {
  console.log('\n[4] heybox_post');

  const { tools, stub } = makeTools({ routes: [{ match: mPostGet, reply: () => postPayload() }] });
  const result = await tools.post({ linkId: 193660114 });
  check('post ok', result.ok === true);
  check('post linkId 是数字', result.linkId === 193660114);
  check('post title', result.title === '黑神话悟空 二周目 体验', `actual=${result.title}`);
  check('富文本 JSON → 纯文本（去标签、br 转换行）', result.text === '第一段 重点\n第二段\n换行', `actual=${JSON.stringify(result.text)}`);
  check('post author', result.author === 'Jackpot');
  check('create_at 秒级 → 北京时间', result.createAt === '2026-10-14 13:14', `actual=${result.createAt}`);
  check('commentCount', result.commentCount === 175);
  check('images 截到 5 张（thumbs 兜底）', result.images.length === 5, `actual=${result.images.length}`);
  serializable('post 结果 JSON 可序列化', result);
  check('post 传的是字符串形式 id', stub.calls[0].argv.slice(2).join(' ') === 'post get 193660114', `actual=${stub.calls[0].argv.join(' ')}`);

  const cm = result.comments[0];
  same('评论只留约定字段', Object.keys(cm).sort(), ['childCount', 'commentId', 'likes', 'text', 'user']);
  check('评论 user 取自 user.username', cm.user === '小黑盒用户');
  check('评论文本压成单行（保留表情 token）', cm.text === '这个boss真难 第二行 [cube_开心]', `actual=${cm.text}`);
  check('likes 取自 up 字段', cm.likes === 63);
  check('childCount 取自 child_num', cm.childCount === 2);
  check('commentId 转成字符串', cm.commentId === '880001');

  const many = Array.from({ length: 10 }, (_, i) => ({ comment: [commentFixture({ commentid: 900000 + i, text: `第 ${i} 条评论内容` })] }));
  const eight = makeTools({ routes: [{ match: mPostGet, reply: () => postPayload({ comments: many }) }] });
  const defaultComments = await eight.tools.post({ linkId: 193660114 });
  check('comments 缺省 = 8', defaultComments.comments.length === 8, `actual=${defaultComments.comments.length}`);
  const twenty = await eight.tools.post({ linkId: 193660114, comments: 20 });
  check('comments=20 全给', twenty.comments.length === 10);
  const none = await eight.tools.post({ linkId: 193660114, comments: 0 });
  check('comments=0 不带评论', none.comments.length === 0);
  const huge = await eight.tools.post({ linkId: 193660114, comments: 99 });
  check('comments=99 夹到 20', huge.comments.length === 10);

  const dirty = makeTools({
    routes: [{
      match: mPostGet,
      reply: () => postPayload({
        comments: [
          { comment: [commentFixture()] },
          { comment: [{ text: '   ', userid: 2 }] },
          { comment: [{ text: '', userid: 3 }] },
          { comment: { commentid: 5, text: '对象形态的评论', user: { username: 'L' }, child_num: 0 } },
        ],
      }),
    }],
  });
  const dirtyResult = await dirty.tools.post({ linkId: 193660114 });
  check('空文本评论被丢掉', dirtyResult.comments.length === 2, `actual=${dirtyResult.comments.length}`);
  check('comment 是对象而不是数组也能解析', dirtyResult.comments[1].text === '对象形态的评论');
  check('点赞数缺失时补 0', dirtyResult.comments[1].likes === 0);

  const longComment = makeTools({
    routes: [{ match: mPostGet, reply: () => postPayload({ comments: [{ comment: [commentFixture({ text: '字'.repeat(400) })] }] }) }],
  });
  const longCommentResult = await longComment.tools.post({ linkId: 193660114 });
  check('评论超 300 字截断并补省略号', longCommentResult.comments[0].text.length === 300 && longCommentResult.comments[0].text.endsWith('…'), `actual=${longCommentResult.comments[0].text.length}`);

  const longPost = makeTools({
    routes: [{ match: mPostGet, reply: () => postPayload({ link: { text: JSON.stringify([{ text: '<p>' + '字'.repeat(2500) + '</p>' }]) } }) }],
  });
  const longPostResult = await longPost.tools.post({ linkId: 193660114 });
  check('正文超 2000 字截断并补省略号', longPostResult.text.length === 2000 && longPostResult.text.endsWith('…'), `actual=${longPostResult.text.length}`);

  const emptyText = makeTools({ routes: [{ match: mPostGet, reply: () => postPayload({ link: { text: '' } }) }] });
  const emptyTextResult = await emptyText.tools.post({ linkId: 193660114 });
  check('text 为空时正文回空串', emptyTextResult.text === '');

  const plainHtml = makeTools({ routes: [{ match: mPostGet, reply: () => postPayload({ link: { text: '<p>直接是 HTML</p><p>不是 JSON</p>' } }) }] });
  const plainHtmlResult = await plainHtml.tools.post({ linkId: 193660114 });
  check('正文是裸 HTML 时也能转纯文本', plainHtmlResult.text === '直接是 HTML\n不是 JSON', `actual=${JSON.stringify(plainHtmlResult.text)}`);

  const thumbOnly = makeTools({ routes: [{ match: mPostGet, reply: () => postPayload({ link: { thumbs: undefined, thumb: 'https://img/t.jpg' } }) }] });
  const thumbResult = await thumbOnly.tools.post({ linkId: 193660114 });
  check('只有 thumb 单图时 images=[thumb]', stable(thumbResult.images) === stable(['https://img/t.jpg']), `actual=${JSON.stringify(thumbResult.images)}`);

  const bad = makeTools({ routes: [] });
  const badResult = await bad.tools.post({ linkId: 'abc' });
  check('linkId 非数字被拒', badResult.ok === false && badResult.code === 'input');
  check('linkId 非数字时一次 CLI 都不调', bad.stub.calls.length === 0);
  const emptyId = await bad.tools.post({ linkId: '' });
  check('空 linkId 被拒', emptyId.ok === false && emptyId.code === 'input');
  const missing = await bad.tools.post({});
  check('缺 linkId 被拒', missing.ok === false && missing.code === 'input');

  const noResult = makeTools({ routes: [{ match: mPostGet, reply: () => json({ ok: true, data: {} }) }] });
  const noResultValue = await noResult.tools.post({ linkId: 193660114 });
  check('没有 result 时回 protocol', noResultValue.ok === false && noResultValue.code === 'protocol');

  const authError = makeTools({ routes: [{ match: mPostGet, reply: () => json({ ok: false, error: { code: 'auth', message: 'unauthorized' } }) }] });
  const authErrorResult = await authError.tools.post({ linkId: 193660114 });
  check('post 遇到 auth 错误映射成 auth', authErrorResult.ok === false && authErrorResult.code === 'auth');
}

// ── 5. heybox_search ───────────────────────────────────────────────────────
async function testSearch() {
  console.log('\n[5] heybox_search');

  const items = [
    { type: 'link', report_id: 'eyJwYWdlIjoyfQ==', info: { linkid: 193660114, title: '<em>黑神话</em> 悟空 攻略', description: '第一章 boss 打法', user: { username: '攻略组' }, comment_num: 33 } },
    { type: 'link', report_id: 'abc', info: { title: '', description: '' } },
  ];
  const { tools, stub } = makeTools({ routes: [{ match: mSearch, reply: () => json({ ok: true, data: { result: { items } } }) }] });
  const result = await tools.search({ query: '黑神话' });
  check('search ok', result.ok === true);
  check('search 回显 query', result.query === '黑神话');
  check('没有 id/title 的条目被过滤', result.count === 1 && result.items.length === 1, `actual=${result.count}`);
  const item = result.items[0];
  same('搜索结果只留约定字段', Object.keys(item).sort(), ['author', 'commentCount', 'linkId', 'summary', 'title']);
  check('搜索 linkId 取自 info.linkid', item.linkId === 193660114);
  check('标题清掉 <em> 高亮', item.title === '黑神话 悟空 攻略', `actual=${item.title}`);
  check('摘要来自 description', item.summary === '第一章 boss 打法');
  check('作者来自 info.user.username', item.author === '攻略组');
  check('评论数来自 info.comment_num', item.commentCount === 33);
  check('report_id 不被当成 id', item.linkId !== 'eyJwYWdlIjoyfQ==');
  check('search 拼装 --type post --limit 5', stub.calls[0].argv.join(' ') === '-f json search 黑神话 --type post --limit 5', `actual=${stub.calls[0].argv.join(' ')}`);
  serializable('search 结果 JSON 可序列化', result);

  const limited = makeTools({ routes: [{ match: mSearch, reply: () => json({ ok: true, data: { result: { items } } }) }] });
  await limited.tools.search({ query: '  黑 神话  ', limit: 3 });
  check('query 压空格后传 CLI', limited.stub.calls[0].argv[3] === '黑 神话', `actual=${limited.stub.calls[0].argv[3]}`);
  check('limit=3 传到 CLI', limited.stub.calls[0].argv.at(-1) === '3');
  const clamped = makeTools({ routes: [{ match: mSearch, reply: () => json({ ok: true, data: { result: { items } } }) }] });
  await clamped.tools.search({ query: 'x', limit: 99 });
  check('limit=99 夹到 10', clamped.stub.calls[0].argv.at(-1) === '10');

  const bad = makeTools({ routes: [] });
  const emptyQuery = await bad.tools.search({ query: '   ' });
  check('空 query 被拒', emptyQuery.ok === false && emptyQuery.code === 'input');
  check('空 query 不调 CLI', bad.stub.calls.length === 0);
  const newlineQuery = await bad.tools.search({ query: '第一行\n第二行' });
  check('query 带换行被拒', newlineQuery.ok === false && newlineQuery.code === 'input');
  const longQuery = await bad.tools.search({ query: '字'.repeat(61) });
  check('query 超 60 字被拒', longQuery.ok === false && longQuery.reason.includes('60'));
  const missingQuery = await bad.tools.search({});
  check('缺 query 被拒', missingQuery.ok === false && missingQuery.code === 'input');

  const rate = makeTools({ routes: [{ match: mSearch, reply: () => json({ ok: false, error: { code: 'rate_limit', message: 'too many' } }, 1) }] });
  const rateResult = await rate.tools.search({ query: '黑神话' });
  check('search 限流映射成 rate_limit', rateResult.ok === false && rateResult.code === 'rate_limit');
  check('限流文案是「今天别再试」', rateResult.reason.includes('今天别再试'), `actual=${rateResult.reason}`);
}

// ── 6. heybox_comment 四道闸门 ─────────────────────────────────────────────
async function testCommentGates() {
  console.log('\n[6] heybox_comment：开关 / 审计 / 额度 / 重复');

  const offByDefault = makeTools({ config: {}, routes: [] });
  const offResult = await offByDefault.tools.comment({ linkId: 193660114, text: TEXT_A });
  check('出厂 allowComment=false → comment_disabled', offResult.ok === false && offResult.code === 'comment_disabled', `actual=${offResult.code}`);
  check('出厂状态下一次 CLI 都不调', offByDefault.stub.calls.length === 0);
  check('评论开关关闭时提示「评论开关没开」', offResult.reason === '评论开关没开', `actual=${offResult.reason}`);

  const disabled = makeTools({ config: { heybox: { enabled: false, allowComment: true } }, routes: [] });
  const disabledResult = await disabled.tools.comment({ linkId: 193660114, text: TEXT_A });
  check('总开关关掉时 code=disabled', disabledResult.ok === false && disabledResult.code === 'disabled');
  check('总开关关掉时提示「功能没启用」', disabledResult.reason.includes('没启用'));

  const gate = (config = { heybox: { allowComment: true } }, dir = freshStateDir()) => makeTools({ config, dir, routes: [authRoute(), readbackRoute(TEXT_A), { match: mComment, reply: () => json({ ok: true, data: {} }) }] });

  const emptyText = await gate().tools.comment({ linkId: 193660114, text: '   ' });
  check('空评论被审计拦下', emptyText.ok === false && emptyText.code === 'audit' && emptyText.reason === '评论是空的');

  const shortText = await gate().tools.comment({ linkId: 193660114, text: '好' });
  check('太短的评论被拦', shortText.code === 'audit' && shortText.reason.includes('太短'), `actual=${shortText.reason}`);

  const longText = await gate().tools.comment({ linkId: 193660114, text: '字'.repeat(201) });
  check('超长评论被拦且提示上限', longText.code === 'audit' && longText.reason === '太长了：上限 200 字', `actual=${longText.reason}`);

  const multiline = await gate().tools.comment({ linkId: 193660114, text: '第一行内容\n第二行内容' });
  check('换行评论被拦', multiline.code === 'audit' && multiline.reason.includes('换行'), `actual=${multiline.reason}`);

  const unsafe = await gate().tools.comment({ linkId: 193660114, text: '看这里 http://evil.example.com 有资源' });
  check('带链接的评论被拦', unsafe.code === 'audit' && String(unsafe.detail).includes('url'), `detail=${unsafe.detail}`);

  const badId = await gate().tools.comment({ linkId: 'abc', text: TEXT_A });
  check('linkId 非数字被拒（在审计之后）', badId.code === 'input', `actual=${badId.code}`);

  const capDir = freshStateDir();
  writeUsageFile(capDir, { count: 10, lastTs: FIXED_NOW - 2 * 3600 * 1000 });
  const capped = await gate(undefined, capDir).tools.comment({ linkId: 193660114, text: TEXT_A });
  check('日上限拦截', capped.ok === false && capped.code === 'daily_cap', `actual=${capped.code}`);
  check('日上限文案带条数', capped.reason.includes('今天已经评论过 10 条'), `actual=${capped.reason}`);

  const nearDir = freshStateDir();
  writeUsageFile(nearDir, { count: 1, lastTs: FIXED_NOW - 60000 });
  const tooSoon = await gate(undefined, nearDir).tools.comment({ linkId: 193660114, text: TEXT_A });
  check('最小间隔拦截', tooSoon.ok === false && tooSoon.code === 'too_frequent', `actual=${tooSoon.code}`);
  check('间隔文案带分钟数', tooSoon.reason.includes('分钟'), `actual=${tooSoon.reason}`);

  const pausedDir = freshStateDir();
  writeUsageFile(pausedDir, { pausedUntil: FIXED_NOW + 3600000, pausedReason: 'captcha' });
  const paused = await gate(undefined, pausedDir).tools.comment({ linkId: 193660114, text: TEXT_A });
  check('暂停期拦截', paused.ok === false && paused.code === 'paused');
  check('暂停文案提验证码', paused.reason.includes('验证码'), `actual=${paused.reason}`);

  const exactDir = freshStateDir();
  writeUsageFile(exactDir, { count: 1, lastTs: FIXED_NOW - 2 * 3600 * 1000 });
  appendActions(exactDir, [{ ts: FIXED_NOW - 2 * 3600 * 1000, linkId: 193660100, text: TEXT_A, dryRun: false, messageId: null }]);
  const exact = await gate(undefined, exactDir).tools.comment({ linkId: 193660114, text: TEXT_A });
  check('完全重复被拦', exact.ok === false && exact.code === 'duplicate' && exact.match === 'exact', `actual=${exact.code}/${exact.match}`);
  check('重复文案是「换个说法」', exact.reason === '和最近发过的评论太像了，换个说法', `actual=${exact.reason}`);

  const nearDupDir = freshStateDir();
  writeUsageFile(nearDupDir, { count: 1, lastTs: FIXED_NOW - 2 * 3600 * 1000 });
  appendActions(nearDupDir, [{ ts: FIXED_NOW - 2 * 3600 * 1000, linkId: 193660100, text: TEXT_A, dryRun: false, messageId: null }]);
  const nearDup = await gate(undefined, nearDupDir).tools.comment({ linkId: 193660114, text: TEXT_NEAR });
  check('高度相似被拦（near）', nearDup.ok === false && nearDup.code === 'duplicate' && nearDup.match === 'near', `actual=${nearDup.code}/${nearDup.match}`);

  // 演练记录不参与去重
  const dryDir = freshStateDir();
  writeUsageFile(dryDir, { count: 0, lastTs: 0 });
  appendActions(dryDir, [
    { ts: FIXED_NOW - 7200000, linkId: 193660100, text: TEXT_A, dryRun: true, messageId: null },
    { ts: FIXED_NOW - 7000000, linkId: 193660101, text: TEXT_A, dryRun: false, ok: false, reason: '小黑盒限流了，今天别再试' },
  ]);
  const dryOnly = await gate(undefined, dryDir).tools.comment({ linkId: 193660114, text: TEXT_A });
  check('dry-run 记录与失败记录不参与去重', dryOnly.ok === true && dryOnly.dryRun === true, `actual=${JSON.stringify(dryOnly)}`);

  // 坏 JSON 行跳过
  const badLineDir = freshStateDir();
  writeUsageFile(badLineDir, { count: 0, lastTs: 0 });
  fs.writeFileSync(path.join(badLineDir, 'heybox-actions.jsonl'), '{坏行\n', 'utf8');
  const badLine = await gate(undefined, badLineDir).tools.comment({ linkId: 193660114, text: TEXT_A });
  check('actions.jsonl 坏行被跳过', badLine.ok === true && badLine.dryRun === true);

  // 只比最近 5 条
  const fiveDir = freshStateDir();
  writeUsageFile(fiveDir, { count: 0, lastTs: 0 });
  const five = Array.from({ length: 5 }, (_, i) => ({ ts: FIXED_NOW - (5000 - i) , linkId: 193660200 + i, text: `最近第 ${i} 条不一样的内容`, dryRun: false, messageId: null }));
  appendActions(fiveDir, [{ ts: 1, linkId: 193660100, text: TEXT_A, dryRun: false, messageId: null }, ...five]);
  const onlyFive = await gate(undefined, fiveDir).tools.comment({ linkId: 193660114, text: TEXT_A });
  check('去重只比最近 5 条（第 6 条旧的已滑出窗口）', onlyFive.ok === true && onlyFive.dryRun === true, `actual=${JSON.stringify(onlyFive)}`);

  // 演练
  const dryRunDir = freshStateDir();
  const dryRun = await gate(undefined, dryRunDir).tools.comment({ linkId: 193660114, text: TEXT_A });
  check('默认走 dry-run', dryRun.ok === true && dryRun.dryRun === true);
  same('dry-run 只回 preview', dryRun.preview, { linkId: 193660114, text: TEXT_A });
  check('dry-run 不返回 verified', !('verified' in dryRun));
  check('dry-run 不落地 usage', !usageExists(dryRunDir));
  check('dry-run 不落地 actions', !actionsExist(dryRunDir));

  const probeStub = cliStub([authRoute(), readbackRoute(TEXT_A), { match: mComment, reply: () => json({ ok: true, data: { dry_run: true, operation: 'comment.create', form: { link_id: '193660114', text: TEXT_A } } }) }]);
  const probeTools = createHeyboxTools({ runCli: probeStub.runCli, readConfig: () => ({ heybox: { allowComment: true } }), now: () => FIXED_NOW, stateDir: freshStateDir() });
  const probe = await probeTools.comment({ linkId: 193660114, text: TEXT_A });
  check('dry-run 结果不含 CLI 的 form 内部字段', probe.ok === true && !('form' in probe) && !('operation' in probe));
  const probeCall = probeStub.calls.find((call) => mComment(call.argv));
  check('dry-run 的 argv 末尾是 --dry-run', probeCall.argv.at(-1) === '--dry-run', `actual=${probeCall.argv.join(' ')}`);
  check('dry-run 的 CLI 超时是 90s', probeCall.timeoutMs === 90000, `actual=${probeCall.timeoutMs}`);

  const forcedConfig = { heybox: { allowComment: true, dryRunDefault: false } };
  const forcedSend = createHeyboxTools({
    runCli: cliStub([authRoute(), readbackRoute(TEXT_A), { match: mComment, reply: () => json({ ok: true, data: {} }) }]).runCli,
    readConfig: () => forcedConfig,
    now: () => FIXED_NOW,
    stateDir: freshStateDir(),
  });
  const forced = await forcedSend.comment({ linkId: 193660114, text: TEXT_A });
  check('dryRunDefault=false 时缺省就真发', forced.ok === true && forced.dryRun === false);

  const forcedDryTools = createHeyboxTools({
    runCli: cliStub([authRoute(), readbackRoute(TEXT_A), { match: mComment, reply: () => json({ ok: true, data: {} }) }]).runCli,
    readConfig: () => forcedConfig,
    now: () => FIXED_NOW,
    stateDir: freshStateDir(),
  });
  const forcedDry = await forcedDryTools.comment({ linkId: 193660114, text: TEXT_A, dryRun: true });
  check('显式 dryRun=true 优先于配置', forcedDry.ok === true && forcedDry.dryRun === true);
}

// ── 7. 真发：记账 / 回读 / 失败 / 验证码 ───────────────────────────────────
async function testCommentSend() {
  console.log('\n[7] heybox_comment 真发');

  const dir = freshStateDir();
  const { tools, stub } = makeTools({
    dir,
    routes: [authRoute(), { match: mComment, reply: () => json({ ok: true, data: { commentid: 770001 } }) }, readbackRoute(TEXT_A)],
  });
  const result = await tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  check('真发 ok', result.ok === true && result.dryRun === false);
  check('真发 linkId 是数字', result.linkId === 193660114);
  check('真发回显 text', result.text === TEXT_A);
  check('回读命中 verified=true', result.verified === true, `actual=${JSON.stringify(result)}`);
  check('回读命中不返回 readback_missing', !('reason' in result));
  check('真发记 usedToday=1', result.usedToday === 1);
  serializable('真发结果 JSON 可序列化', result);

  const usage = readUsageFile(dir);
  check('usage 落盘 count=1', usage.count === 1, `actual=${usage.count}`);
  check('usage 落盘 day 是北京日键', usage.day === BEIJING_DAY, `actual=${usage.day}`);
  check('usage 落盘 lastTs 用注入的 now', usage.lastTs === FIXED_NOW);
  check('usage 落盘 pausedUntil=0', usage.pausedUntil === 0);

  const actions = readActions(dir);
  check('actions 只有一行', actions.length === 1, `actual=${actions.length}`);
  const record = actions[0];
  same('actions 行字段是 {ts,linkId,text,dryRun,messageId,readback,readbackSource}', Object.keys(record).sort(), ['dryRun', 'linkId', 'messageId', 'readback', 'readbackSource', 'text', 'ts']);
  check('actions 行 dryRun=false', record.dryRun === false);
  check('actions 行 messageId 用 CLI 返回的 commentid（不是 null）', record.messageId === '770001', `actual=${JSON.stringify(record.messageId)}`);
  check('actions 行 readback=found', record.readback === 'found', `actual=${record.readback}`);
  check('actions 行 readbackSource=local（CLI 没说自己校验过）', record.readbackSource === 'local', `actual=${record.readbackSource}`);
  check('结果里回显 messageId 与 readback', result.messageId === '770001' && result.readback === 'found', `actual=${JSON.stringify({ id: result.messageId, rb: result.readback })}`);
  check('actions 行 linkId 是数字', record.linkId === 193660114);
  check('actions 行 ts 用注入的 now', record.ts === FIXED_NOW);

  const sendCall = stub.calls.find((call) => mComment(call.argv));
  check('真发 argv 不带 --dry-run', !sendCall.argv.includes('--dry-run'), `actual=${sendCall.argv.join(' ')}`);
  check('真发 argv 形如 comment create <id> --text <文本>', sendCall.argv.join(' ') === `-f json comment create 193660114 --text ${TEXT_A}`, `actual=${sendCall.argv.join(' ')}`);
  check('真发会跑一次 auth status + 一次 post get 做回读', countCalls(stub, mAuth) === 1 && countCalls(stub, mPostGet) === 1);

  // CLI 不回 comment id（实测这条路径最常见）：靠回读把 id 补上
  const fromReadback = makeTools({
    dir: freshStateDir(),
    routes: [authRoute(), { match: mComment, reply: () => json({ ok: true, data: {} }) }, readbackRoute(TEXT_A)],
  });
  const fromReadbackResult = await fromReadback.tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  check('CLI 不回 id 时用回读到的 commentId 记账', readActions(fromReadback.dir)[0].messageId === '880001', `actual=${JSON.stringify(readActions(fromReadback.dir)[0].messageId)}`);
  check('CLI 不回 id 时结果也带 messageId', fromReadbackResult.messageId === '880001' && fromReadbackResult.readback === 'found', `actual=${JSON.stringify(fromReadbackResult.messageId)}`);

  // CLI 自己已经回读校验过（xhh_operator 会 post sort=latest 复核后置 verified=true）：采信它，不再多发一次请求
  const cliVerified = makeTools({
    dir: freshStateDir(),
    routes: [authRoute(), { match: mComment, reply: () => json({ ok: true, data: { accepted: true, comment_id: '770001', verified: true } }) }],
  });
  const cliVerifiedResult = await cliVerified.tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  check('CLI 说 verified=true 时不再自己 post get（省一次读请求）', countCalls(cliVerified.stub, mPostGet) === 0, `actual=${countCalls(cliVerified.stub, mPostGet)}`);
  check('CLI 说 verified=true 时采信为 verified / readbackSource=cli', cliVerifiedResult.verified === true && cliVerifiedResult.readbackSource === 'cli', `actual=${JSON.stringify(cliVerifiedResult)}`);
  check('CLI 说 verified=true 时 messageId 仍取自 CLI', cliVerifiedResult.messageId === '770001' && readActions(cliVerified.dir)[0].readback === 'found');

  // 回读拿到的是别人的评论 → 不能把别人的 id 记成自己的
  const otherId = makeTools({
    dir: freshStateDir(),
    routes: [authRoute(), { match: mComment, reply: () => json({ ok: true, data: {} }) }, { match: mPostGet, reply: () => postPayload({ comments: [{ comment: [commentFixture({ text: TEXT_A, userid: 999, commentid: 999001 })] }] }) }],
  });
  await otherId.tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  check('回读只认自己的评论 id（别人的 id 不记账）', readActions(otherId.dir)[0].messageId === null, `actual=${JSON.stringify(readActions(otherId.dir)[0].messageId)}`);

  // 回读落空：仍然算「已记账」，但要如实说 verified=false
  const missingDir = freshStateDir();
  const missing = makeTools({
    dir: missingDir,
    routes: [authRoute(), { match: mComment, reply: () => json({ ok: true, data: {} }) }, { match: mPostGet, reply: () => postPayload({ comments: [{ comment: [commentFixture({ text: '别人的评论', userid: 999 })] }] }) }],
  });
  const missingResult = await missing.tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  check('回读落空时 ok 仍为 true', missingResult.ok === true && missingResult.dryRun === false);
  check('回读落空时 verified=false', missingResult.verified === false);
  check('回读落空时带 reason=readback_missing', missingResult.reason === 'readback_missing', `actual=${missingResult.reason}`);
  check('回读落空照样记账', readUsageFile(missingDir).count === 1);
  check('回读落空照样写 actions', readActions(missingDir).length === 1);
  check('回读落空的 actions 行 readback=not_found 且 messageId=null', (() => {
    const row = readActions(missingDir)[0];
    return row.readback === 'not_found' && row.messageId === null;
  })(), `actual=${JSON.stringify(readActions(missingDir)[0])}`);
  check('回读落空不算失败（ok 仍 true、没有 error 字段）', missingResult.ok === true && !('error' in missingResult));

  const sameUserOtherText = makeTools({
    dir: freshStateDir(),
    routes: [authRoute(), { match: mComment, reply: () => json({ ok: true, data: {} }) }, { match: mPostGet, reply: () => postPayload({ comments: [{ comment: [commentFixture({ text: `${TEXT_A}（改过）`, userid: Number(ME_ID) })] }] }) }],
  });
  const sameUserOtherTextResult = await sameUserOtherText.tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  check('自己发的但文本不一致 → verified=false', sameUserOtherTextResult.verified === false);

  const readbackBroken = makeTools({
    dir: freshStateDir(),
    routes: [authRoute(), { match: mComment, reply: () => json({ ok: true, data: {} }) }, { match: mPostGet, reply: () => json({ ok: false, error: { code: 'network', message: 'timeout' } }, 1) }],
  });
  const readbackBrokenResult = await readbackBroken.tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  check('回读请求失败也标 verified=false', readbackBrokenResult.ok === true && readbackBrokenResult.verified === false);
  check('回读请求失败带 detail', typeof readbackBrokenResult.detail === 'string' && readbackBrokenResult.detail.length > 0, `actual=${readbackBrokenResult.detail}`);

  const noAuth = makeTools({
    dir: freshStateDir(),
    routes: [{ match: mAuth, reply: () => json({ ok: false, error: { code: 'auth', message: 'no' } }, 1) }, { match: mComment, reply: () => json({ ok: true, data: {} }) }, readbackRoute(TEXT_A)],
  });
  const noAuthResult = await noAuth.tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  check('拿不到 user_id 时无法验证', noAuthResult.ok === true && noAuthResult.verified === false && noAuthResult.reason === 'readback_missing');

  // 真发失败：不记账，但要留失败行
  const failDir = freshStateDir();
  const fail = makeTools({
    dir: failDir,
    routes: [authRoute(), { match: mComment, reply: () => json({ ok: false, error: { code: 'auth', message: 'unauthorized' } }, 1) }],
  });
  const failResult = await fail.tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  check('真发失败 ok=false', failResult.ok === false && failResult.code === 'auth', `actual=${failResult.code}`);
  check('真发失败文案是「重新扫码」', failResult.reason.includes('扫码登录'));
  check('真发失败不写 usage', !usageExists(failDir));
  const failActions = readActions(failDir);
  check('真发失败留一行 actions', failActions.length === 1);
  check('失败行标 ok=false', failActions[0].ok === false);
  check('失败行带 reason', typeof failActions[0].reason === 'string' && failActions[0].reason.length > 0);
  check('失败行 dryRun=false', failActions[0].dryRun === false);

  const neverCalls = await fail.tools.comment({ linkId: 193660114, text: '换一句话试试行不行', dryRun: false });
  check('失败后不自动重试（每调用一次只发一次）', neverCalls.ok === false);
  check('两次失败 = 两行 actions', readActions(failDir).length === 2);

  // 验证码：暂停到北京时间当天 24:00
  const captchaDir = freshStateDir();
  const captcha = makeTools({
    dir: captchaDir,
    routes: [authRoute(), { match: mComment, reply: () => json({ ok: false, error: { code: 'captcha', message: '需要验证码' } }, 1) }],
  });
  const captchaResult = await captcha.tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  check('验证码映射成 captcha', captchaResult.ok === false && captchaResult.code === 'captcha');
  check('验证码把 pausedUntil 设成 now + 默认 30 分钟', captchaResult.pausedUntil === FIXED_NOW + 30 * 60000, `actual=${captchaResult.pausedUntil} expected=${FIXED_NOW + 30 * 60000}`);
  check('验证码暂停不再沿用到当天 24:00', captchaResult.pausedUntil !== TODAY_END);
  check('验证码写 pausedReason=captcha', captchaResult.pausedReason === 'captcha');
  check('验证码返回「还剩多久」的人话', captchaResult.pauseRemainingText === '还剩 30 分钟', `actual=${captchaResult.pauseRemainingText}`);
  check('验证码 hint 说清「所有请求一起停」', typeof captchaResult.hint === 'string' && captchaResult.hint.includes('看帖') && captchaResult.hint.includes('搜索') && captchaResult.hint.includes('评论'), `actual=${captchaResult.hint}`);
  const captchaUsage = readUsageFile(captchaDir);
  check('验证码暂停落盘', captchaUsage.pausedUntil === FIXED_NOW + 30 * 60000 && captchaUsage.pausedReason === 'captcha', `actual=${captchaUsage.pausedUntil}`);
  check('验证码不增加 count', captchaUsage.count === 0, `actual=${captchaUsage.count}`);
  check('验证码留一行失败 actions', readActions(captchaDir).length === 1);

  const afterCaptcha = await captcha.tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  check('暂停后下一次直接被 paused 拦住', afterCaptcha.ok === false && afterCaptcha.code === 'paused', `actual=${afterCaptcha.code}`);
  check('暂停拦截不再调 CLI', captcha.stub.calls.filter((call) => mComment(call.argv)).length === 1);
  check('暂停拦截的人话带「还剩多久」', typeof afterCaptcha.reason === 'string' && afterCaptcha.reason.includes('还剩 30 分钟'), `actual=${afterCaptcha.reason}`);
  check('暂停拦截回显 pausedUntil / pausedReason', afterCaptcha.pausedUntil === FIXED_NOW + 30 * 60000 && afterCaptcha.pausedReason === 'captcha');

  // 暂停窗口跟着配置走：captchaPauseMs=10 分钟
  const customPause = makeTools({
    dir: freshStateDir(),
    config: { heybox: { allowComment: true, dryRunDefault: false, captchaPauseMs: 600000 } },
    routes: [authRoute(), { match: mComment, reply: () => json({ ok: false, error: { code: 'captcha', message: '需要验证码' } }, 1) }],
  });
  const customResult = await customPause.tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  check('captchaPauseMs 可配（600000 → 暂停 10 分钟）', customResult.pausedUntil === FIXED_NOW + 10 * 60000, `actual=${customResult.pausedUntil}`);
  check('captchaPauseMs 的「还剩多久」跟着配置', customResult.pauseRemainingText === '还剩 10 分钟', `actual=${customResult.pauseRemainingText}`);

  // 搜索与评论共用同一个暂停窗口：评论先被验证码拦住，搜索也得停
  const sharedDir = freshStateDir();
  const shared = makeTools({
    dir: sharedDir,
    routes: [authRoute(), { match: mComment, reply: () => json({ ok: false, error: { code: 'captcha', message: '需要验证码' } }, 1) }, { match: mSearch, reply: () => json({ ok: true, data: {} }) }],
  });
  await shared.tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  const sharedSearch = await shared.tools.search({ query: '黑神话' });
  check('评论撞验证码后搜索也被同一个暂停窗口拦住', sharedSearch.ok === false && sharedSearch.code === 'paused', `actual=${sharedSearch.code}`);
  check('暂停期的搜索不调 CLI（一次都没调）', countCalls(shared.stub, mSearch) === 0, `actual=${countCalls(shared.stub, mSearch)}`);
  check('暂停期的搜索也回「还剩多久」', sharedSearch.pauseRemainingText === '还剩 30 分钟', `actual=${sharedSearch.pauseRemainingText}`);

  // 反过来：搜索先撞验证码，评论同样被拦
  const searchFirstDir = freshStateDir();
  const searchFirst = makeTools({
    dir: searchFirstDir,
    routes: [authRoute(), { match: mSearch, reply: () => json({ ok: false, error: { code: 'captcha', message: '需要验证码' } }, 1) }],
  });
  const searchCaptcha = await searchFirst.tools.search({ query: '黑神话' });
  check('搜索撞验证码也置暂停', searchCaptcha.ok === false && searchCaptcha.code === 'captcha' && searchCaptcha.pausedUntil === FIXED_NOW + 30 * 60000, `actual=${JSON.stringify(searchCaptcha.pausedUntil)}`);
  check('搜索撞验证码也落盘', readUsageFile(searchFirstDir).pausedUntil === FIXED_NOW + 30 * 60000);
  const commentAfterSearch = await searchFirst.tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  check('搜索撞验证码后评论被同一个窗口拦住', commentAfterSearch.ok === false && commentAfterSearch.code === 'paused' && countCalls(searchFirst.stub, mComment) === 0);

  // 暂停窗口到点自动恢复：把时钟挪到 pausedUntil 之后
  const resumeDir = freshStateDir();
  let clockNow = FIXED_NOW;
  const resume = makeTools({ dir: resumeDir, routes: [authRoute(), { match: mSearch, reply: () => json({ ok: true, data: {} }) }], clock: () => clockNow });
  writeUsageFile(resumeDir, { count: 0, lastTs: 0, pausedUntil: FIXED_NOW + 30 * 60000, pausedReason: 'captcha' });
  clockNow = FIXED_NOW + 31 * 60000;
  const resumed = await resume.tools.search({ query: '黑神话' });
  check('暂停到点后搜索自动恢复（带 pausedReason 也不再拦）', resumed.ok === true && countCalls(resume.stub, mSearch) === 1, `actual=${JSON.stringify(resumed).slice(0, 120)}`);

  // 暂停期连看帖/刷首页也一起停：本机实测 `post get` 同样会被小黑盒要验证码
  const readPauseDir = freshStateDir();
  const readPause = makeTools({
    dir: readPauseDir,
    routes: [
      authRoute(),
      { match: mFeed, reply: () => json({ ok: true, data: { result: { items: [] } } }) },
      { match: mPostGet, reply: () => postPayload() },
    ],
  });
  writeUsageFile(readPauseDir, { count: 0, lastTs: 0, pausedUntil: FIXED_NOW + 30 * 60000, pausedReason: 'captcha' });
  const feedWhilePaused = await readPause.tools.feed({});
  check('暂停期的首页也被拦住', feedWhilePaused.ok === false && feedWhilePaused.code === 'paused', `actual=${feedWhilePaused.code}`);
  check('暂停期的首页不调 CLI', countCalls(readPause.stub, mFeed) === 0, `actual=${countCalls(readPause.stub, mFeed)}`);
  const postWhilePaused = await readPause.tools.post({ linkId: 193660114 });
  check('暂停期的帖子也被拦住且不调 CLI', postWhilePaused.ok === false && postWhilePaused.code === 'paused' && countCalls(readPause.stub, mPostGet) === 0, `actual=${JSON.stringify(postWhilePaused).slice(0, 160)}`);

  // 读请求撞验证码同样落盘：风控看的是请求量，不区分读还是写
  const postCaptchaDir = freshStateDir();
  const postCaptcha = makeTools({
    dir: postCaptchaDir,
    routes: [authRoute(), { match: mPostGet, reply: () => json({ ok: false, error: { code: 'captcha', message: '需要验证码' } }, 1) }],
  });
  const postCaptchaResult = await postCaptcha.tools.post({ linkId: 193660114 });
  check('看帖撞验证码也置同一个暂停窗口', postCaptchaResult.code === 'captcha' && postCaptchaResult.pausedUntil === FIXED_NOW + 30 * 60000, `actual=${JSON.stringify(postCaptchaResult.pausedUntil)}`);
  check('看帖撞验证码也回「还剩多久」并落盘', postCaptchaResult.pauseRemainingText === '还剩 30 分钟' && readUsageFile(postCaptchaDir).pausedUntil === FIXED_NOW + 30 * 60000, `actual=${readUsageFile(postCaptchaDir).pausedUntil}`);

  // 限流
  const rateDir = freshStateDir();
  const rate = makeTools({ dir: rateDir, routes: [authRoute(), { match: mComment, reply: () => json({ ok: false, error: { code: 'rate_limit', message: 'slow down' } }, 1) }] });
  const rateResult = await rate.tools.comment({ linkId: 193660114, text: TEXT_A, dryRun: false });
  check('限流映射成 rate_limit', rateResult.ok === false && rateResult.code === 'rate_limit');
  check('限流不写 usage', !usageExists(rateDir));

  // 退出码 2 + stdout 上的 upstream 错误（实测过的真实形态）
  const upstream = makeTools({ dir: freshStateDir(), routes: [{ match: mFeed, reply: () => ({ stdout: JSON.stringify({ ok: false, error: { code: 'upstream', message: '小黑盒拒绝了操作，请检查账号权限、内容及接口兼容性。' } }), stderr: '', code: 2 }) }] });
  const upstreamResult = await upstream.tools.feed({});
  check('未知错误码归到 unknown', upstreamResult.ok === false && upstreamResult.code === 'unknown', `actual=${upstreamResult.code}`);
  check('未知错误给通用中文文案', upstreamResult.reason === '小黑盒拒绝了这次操作', `actual=${upstreamResult.reason}`);

  const protocol = makeTools({ routes: [{ match: mFeed, reply: () => ({ stdout: 'oops, not json', stderr: '', code: 0 }) }] });
  const protocolResult = await protocol.tools.feed({});
  check('stdout 不是 JSON → protocol', protocolResult.ok === false && protocolResult.code === 'protocol', `actual=${protocolResult.code}`);

  const stderrCaptcha = makeTools({ routes: [{ match: mFeed, reply: () => ({ stdout: '', stderr: '验证码校验失败', code: 3 }) }] });
  const stderrCaptchaResult = await stderrCaptcha.tools.feed({});
  check('stderr 里的「验证码」也能认出 captcha', stderrCaptchaResult.ok === false && stderrCaptchaResult.code === 'captcha', `actual=${stderrCaptchaResult.code}`);

  const network = makeTools({ routes: [{ match: mFeed, reply: () => json({ ok: false, error: { code: 'network', message: 'connect timeout' } }) }] });
  const networkResult = await network.tools.feed({});
  check('network 映射成 network', networkResult.ok === false && networkResult.code === 'network');
  check('network 文案是「连不上」', networkResult.reason === '连不上小黑盒', `actual=${networkResult.reason}`);
}

// ── 8. registerHeyboxTools ─────────────────────────────────────────────────
async function testRegistration() {
  console.log('\n[8] registerHeyboxTools：把工具注册到别人的 server 上');

  const registered = [];
  const fakeServer = {
    tool(name, description, schema, fn) {
      registered.push({ name, description, schema, fn });
    },
  };
  registerHeyboxTools(fakeServer);
  check('注册了恰好 5 个工具', registered.length === 5, `actual=${registered.length}`);
  same('工具名与顺序固定', registered.map((item) => item.name), ['heybox_status', 'heybox_feed', 'heybox_post', 'heybox_search', 'heybox_comment']);
  check('每个 handler 都是函数', registered.every((item) => typeof item.fn === 'function'));
  check('每个工具都有中文描述', registered.every((item) => typeof item.description === 'string' && item.description.length >= 20));
  same('status 的 schema 是空对象', registered[0].schema, {});
  check('feed 的 schema 有 limit', 'limit' in registered[1].schema);
  check('post 的 schema 有 linkId 与 comments', 'linkId' in registered[2].schema && 'comments' in registered[2].schema);
  check('search 的 schema 有 query 与 limit', 'query' in registered[3].schema && 'limit' in registered[3].schema);
  check('comment 的 schema 有 linkId/text/dryRun', ['linkId', 'text', 'dryRun'].every((key) => key in registered[4].schema));
  check('comment 描述仍写「默认 dry-run，不会真发」', registered[4].description.includes('默认 dry-run，不会真发'));
  check('search 描述提醒验证码', registered[3].description.includes('验证码'));

  // opts 透传：用假 CLI + 临时 state 真跑一次 status handler，证明注册的是可注入的那份实现。
  const wired = [];
  const { stub, dir } = makeTools({ routes: [authRoute()] });
  registerHeyboxTools({ tool: (name, description, schema, fn) => wired.push({ name, fn }) }, {
    runCli: stub.runCli,
    readConfig: () => ({ heybox: { allowComment: true } }),
    now: () => FIXED_NOW,
    stateDir: dir,
  });
  const statusOut = await wired[0].fn({});
  check('handler 返回 MCP content 数组', Array.isArray(statusOut.content) && statusOut.content[0].type === 'text');
  const statusBody = JSON.parse(statusOut.content[0].text);
  check('handler 正文是 JSON（ok:true）', statusBody.ok === true && statusBody.authenticated === true);
  check('成功时没有 isError', statusOut.isError === undefined);

  const brokenRegistered = [];
  registerHeyboxTools({ tool: (name, description, schema, fn) => brokenRegistered.push({ name, fn }) }, {
    runCli: cliStub([{ match: mAuth, reply: () => { throw new Error('spawn ENOENT'); } }]).runCli,
    readConfig: () => ({}),
    now: () => FIXED_NOW,
    stateDir: freshStateDir(),
  });
  const brokenOut = await brokenRegistered[0].fn({});
  check('失败时标 isError=true', brokenOut.isError === true);
  check('失败时正文仍可解析且 ok=false', JSON.parse(brokenOut.content[0].text).ok === false);

  const feedRegistered = [];
  registerHeyboxTools({ tool: (name, description, schema, fn) => feedRegistered.push({ name, fn }) }, {
    runCli: cliStub([{ match: mFeed, reply: () => feedPayload([feedLink()]) }]).runCli,
    readConfig: () => ({ heybox: {} }),
    now: () => FIXED_NOW,
    stateDir: freshStateDir(),
  });
  const feedOut = await feedRegistered[1].fn({ limit: 1 });
  const feedBody = JSON.parse(feedOut.content[0].text);
  check('feed handler 收到参数并返回瘦身数组', feedBody.ok === true && feedBody.items.length === 1);
}

// ── 9. 主流程 ──────────────────────────────────────────────────────────────
async function main() {
  console.log('mcp-heybox-safe.js 单测（假 CLI + 临时 state 目录）');
  testCliEnv();
  await testStatus();
  await testFeed();
  await testPost();
  await testSearch();
  await testCommentGates();
  await testCommentSend();
  await testRegistration();

  console.log(`\n结果：${passed}/${passed + failed} passed`);
  if (failed > 0) console.error(`失败 ${failed} 条`);
  process.exitCode = failed > 0 ? 1 : 0;
}

try {
  await main();
} finally {
  fs.rmSync(ROOT_TMP, { recursive: true, force: true });
}
