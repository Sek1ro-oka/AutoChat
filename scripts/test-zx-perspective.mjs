// T-030：张雪峰视角（咨询模式）端点自测。
//
// 覆盖：topic 归一、小节切分、4000 字截断、mtime 缓存、文件缺失 → unavailable、
// 非 group:1131654608 → 403、无 token / 错 token → 403；另外真跑一次「默认配置 +
// 真实外部 skill」的冒烟（文件不在就 SKIP）。
//
// 所有请求都打到 bridgeHarness 起的**真实 HTTP 控制台**上：它用真实 src/bridge.js 源码
// 在 VM 里跑 loadConfig / startConsoleServer，所以 gating、读文件、缓存哪一环真出问题，
// 这里会一起红 —— 不是把逻辑抄一遍自证。
//
// 单独跑：node scripts/test-zx-perspective.mjs（不进 scripts/test-audit.mjs）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 控制台令牌是**整站**闸门（所有 /api/* 都要），MCP 进程每次都带 x-console-token；
// 这里照着带，才能越过它去验真正的会话令牌判定。
const CONSOLE_TOKEN = 'fixture-console-token';
const ENDPOINT = '/api/socialV2/zx-perspective';
const ZX_KEY = 'group:1131654608';          // 默认允许列表里唯一的群
const OTHER_KEY = 'group:119212385';        // 在 allow.groups 里，但不在 zx.allowKeys 里
const OUTSIDE_KEY = 'group:123456';         // 连 allow.groups 都不在
const REAL_SKILL = path.join(os.homedir(), '.agents', 'skills', 'zhangxuefeng-skill', 'SKILL.md');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}`);
    console.log(`     ${error?.stack ?? error}`);
  }
}

// ── 夹具 ────────────────────────────────────────────────────────────────────
// 四个小节 + 一个「不该被任何 topic 带出来」的尾巴小节，用来验证切分边界。
const FIXTURE_SKILL = [
  '# 张雪峰 · 思维操作系统（测试夹具）',
  '',
  '这部分是前言，不属于任何小节 PREFACE-MARK。',
  '',
  '## 角色扮演规则（最重要）',
  '',
  '- 规则甲 RULE-A-MARK：直接以张雪峰的身份回应。',
  '- 规则乙 RULE-B-MARK：免责声明仅首次激活时说一次。',
  '',
  '## 核心心智模型',
  '',
  '### 1. 社会筛子论',
  '',
  '模型甲正文 MODEL-A-MARK。',
  '',
  '### 2. 选择比努力更重要',
  '',
  '模型乙正文 MODEL-B-MARK。',
  '',
  '## 决策启发式',
  '',
  '1. 启发式一 HEUR-1-MARK。',
  '2. 启发式二 HEUR-2-MARK。',
  '',
  '## 表达DNA',
  '',
  '- 短句、反问、口语 EXPR-MARK。',
  '',
  '## 反例黑名单（绝不要做）',
  '',
  '这一段不能出现在任何 topic 的返回里 FORBIDDEN-MARK。',
  '',
  '---',
  ''
].join('\n');

/** 造一个假 skill 目录（目录名故意叫 zhangxuefeng-skill，让 source 标签与真实情况一致）。 */
function makeSandbox(content = FIXTURE_SKILL) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zx-perspective-'));
  const dir = path.join(base, 'zhangxuefeng-skill');
  const file = path.join(dir, 'SKILL.md');
  if (content !== null) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return { base, dir, file, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function postJson(port, body, { token, agentCall = true } = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, path: ENDPOINT, method: 'POST', headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-console-token': CONSOLE_TOKEN,
        connection: 'close',
        ...(agentCall ? { 'x-agent-call': '1' } : {}),
        ...(token === undefined ? {} : { 'x-agent-token': token })
      }
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* 留在 raw 里看 */ }
        resolve({ status: response.statusCode, json, raw });
      });
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('request hung')));
    request.end(payload);
  });
}

async function startServer(config, { mode = 'reserved2' } = {}) {
  const h = await bridgeHarness({ config });
  // 带 x-agent-token 的 /api/socialV2/* 只在 reserved2 模式放行（桥接的集中关卡）；
  // 二代工具本来也只在那个模式下有令牌，所以测试按真实运行环境把模式摆对。
  h.setMode(mode);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return {
    h,
    port: server.address().port,
    token: (key) => h.getSocialV2State(key).agentToken,
    // 默认不带 x-agent-call：这样请求直接落到端点自己的判定上，能断言端点给的 400/403 文案。
    // 生产路径（MCP 一定带 x-agent-call: 1）另有用例单独覆盖。
    call: (body, token, opts = {}) => postJson(server.address().port, body, { token, agentCall: false, ...opts }),
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    }
  };
}

/** 默认 config 只改 allow.groups，zx.dir 指向夹具。 */
function fixtureConfig(dir) {
  return {
    allow: { private: ['123'], groups: ['1131654608', '119212385'] },
    socialV2: { zx: { dir: path.join(dir, 'SKILL.md') } }
  };
}

// ── 用例 ────────────────────────────────────────────────────────────────────
{
  const sandbox = makeSandbox();
  const s = await startServer(fixtureConfig(sandbox.dir));
  try {
    const token = s.token(ZX_KEY);
    assert.ok(token && token.length >= 16, 'harness 应给出该群自己的 agentToken');
    assert.equal(s.token(OTHER_KEY).length >= 16, true);

    await check('topic 缺省 → all：只有三节框架，**不含**「角色扮演规则」', async () => {
      const { status, json, raw } = await s.call({ key: ZX_KEY }, token);
      assert.equal(status, 200, raw);
      assert.equal(json.ok, true);
      assert.equal(json.topic, 'all');
      assert.equal(json.chars, json.text.length, 'chars 必须是最终 text 的长度');
      assert.equal(json.truncated, false);
      for (const heading of ['## 核心心智模型', '## 决策启发式', '## 表达DNA']) {
        assert.ok(json.text.includes(heading), `all 应当包含 ${heading}`);
      }
      for (const mark of ['MODEL-A-MARK', 'MODEL-B-MARK', 'HEUR-1-MARK', 'EXPR-MARK']) {
        assert.ok(json.text.includes(mark), `all 应当包含 ${mark}`);
      }
      // Z-001：咨询模式口径 —— 默认返回体里绝不能出现那一节人格指令。
      assert.equal(json.text.includes('## 角色扮演规则'), false, 'all 不能带出角色扮演规则小节');
      assert.equal(json.text.includes('直接以张雪峰的身份回应'), false, 'all 不能带出「切换人格」的指令原文');
      assert.equal(json.text.includes('RULE-A-MARK'), false, 'all 不能带出角色扮演规则的内容');
      // 尾巴小节与前言都不该被带出来 —— 切分必须停在下一个 `## `。
      assert.equal(json.text.includes('FORBIDDEN-MARK'), false, '不能越界把后文带出来');
      assert.equal(json.text.includes('PREFACE-MARK'), false, '不能把 frontmatter 之后的前言带出来');
      assert.equal(/\n---\s*$/.test(json.text), false, '小节末尾的 --- 分隔线要丢掉');
    });

    await check('topic 归一：大小写 / 中文别名 / 未知值', async () => {
      const cases = [
        ['FRAMEWORKS', 'frameworks'],
        ['  Heuristics ', 'heuristics'],
        ['心智模型', 'frameworks'],
        ['决策启发式', 'heuristics'],
        ['表达方式', 'expression'],
        ['全部', 'all'],
        ['nonsense-topic', 'all'],
        ['', 'all'],
        ['core_frameworks', 'frameworks']  // 下划线也要吃掉
      ];
      for (const [input, expected] of cases) {
        const { status, json, raw } = await s.call({ key: ZX_KEY, topic: input }, token);
        assert.equal(status, 200, `${input} → ${raw}`);
        assert.equal(json.topic, expected, `topic ${JSON.stringify(input)} 应归一为 ${expected}`);
      }
      // 显式 null 与不传等价。
      const { json } = await s.call({ key: ZX_KEY, topic: null }, token);
      assert.equal(json.topic, 'all');
    });

    await check('topic 归一：显式 rules / 规则 / 角色扮演规则 → 落到 all，且不带那一节', async () => {
      // Z-001：这一节是「切换人格」的指令，工具既然不接受它，就不能被别名偷偷放进来。
      for (const input of ['rules', 'rule', 'RULES', '规则', '角色扮演规则', '## 角色扮演规则']) {
        const { status, json, raw } = await s.call({ key: ZX_KEY, topic: input }, token);
        assert.equal(status, 200, `${input} → ${raw}`);
        assert.equal(json.topic, 'all', `topic ${JSON.stringify(input)} 应回落为 all`);
        assert.equal(json.text.includes('## 角色扮演规则'), false, `${input} 不能带出那一节`);
        assert.equal(json.text.includes('直接以张雪峰的身份回应'), false);
      }
    });

    await check('小节切分：单节只含自己那一段，互不串味', async () => {
      const fw = await s.call({ key: ZX_KEY, topic: 'frameworks' }, token);
      assert.equal(fw.status, 200, fw.raw);
      assert.equal(fw.json.text.startsWith('## 核心心智模型'), true, fw.json.text.slice(0, 40));
      assert.ok(fw.json.text.includes('MODEL-A-MARK') && fw.json.text.includes('MODEL-B-MARK'));
      assert.equal(fw.json.text.includes('HEUR-1-MARK'), false, 'frameworks 不能带出决策启发式');
      assert.equal(fw.json.text.includes('EXPR-MARK'), false, 'frameworks 不能带出表达DNA');
      assert.equal(fw.json.text.includes('RULE-A-MARK'), false, 'frameworks 不能带出角色扮演规则');
      assert.equal(fw.json.text.trimEnd().endsWith('模型乙正文 MODEL-B-MARK。'), true, fw.json.text.slice(-60));
      assert.deepEqual(fw.json.missing, [], '三节都在时 missing 应为空');

      const ex = await s.call({ key: ZX_KEY, topic: 'expression' }, token);
      assert.equal(ex.status, 200, ex.raw);
      assert.ok(ex.json.text.startsWith('## 表达DNA'));
      assert.ok(ex.json.text.includes('EXPR-MARK'));
      assert.equal(ex.json.text.includes('MODEL-A-MARK'), false);
      assert.equal(ex.json.text.includes('FORBIDDEN-MARK'), false);
    });

    await check('响应契约：source 只给相对标签、mtime 是 ISO、不泄露绝对路径', async () => {
      const { json } = await s.call({ key: ZX_KEY, topic: 'heuristics' }, token);
      assert.equal(json.ok, true);
      assert.equal(json.source, 'zhangxuefeng-skill/SKILL.md');
      assert.equal(json.source.includes(sandbox.base), false, '不能把夹具绝对路径回给模型');
      assert.equal(json.source.includes(':'), false, '不该出现盘符');
      assert.equal(new Date(json.mtime).toISOString(), json.mtime, 'mtime 必须是合法 ISO 串');
      assert.equal(json.mtime, new Date(fs.statSync(sandbox.file).mtimeMs).toISOString());
      assert.equal(typeof json.chars, 'number');
      assert.equal(json.truncated, false);
      assert.ok(json.text.includes('HEUR-1-MARK'));
      assert.equal(json.text.includes('RULE-A-MARK'), false);
    });

    await check('gating：不在 allowKeys 的群 403（哪怕它自己有合法 token）', async () => {
      const { status, json, raw } = await s.call({ key: OTHER_KEY }, s.token(OTHER_KEY));
      assert.equal(status, 403, raw);
      assert.equal(json.ok, false);
      assert.equal(json.code, 'forbidden');
      assert.ok(json.error.includes(ZX_KEY), `403 文案要指出允许的群：${json.error}`);
      assert.equal(json.text, undefined);
    });

    await check('gating：连 allow.groups 都不在 → 先被会话白名单拦住', async () => {
      // 令牌校验在前：先给它一个**真**令牌（getSocialV2State 会顺手建状态），
      // 这样才能证明卡住它的是会话白名单、而不是更早的令牌判定。
      const { status, json, raw } = await s.call({ key: OUTSIDE_KEY }, s.token(OUTSIDE_KEY));
      assert.equal(status, 403, raw);
      assert.equal(json.code, undefined, '这条走的是会话白名单，不是 zx 的 key 闸门');
      assert.equal(json.error, '目标不在当前模式允许范围内');
    });

    await check('鉴权：无 token → 403，错 token → 403', async () => {
      const noToken = await s.call({ key: ZX_KEY });
      assert.equal(noToken.status, 403, noToken.raw);
      assert.equal(noToken.json.error, 'agent token 不能为空');

      const empty = await s.call({ key: ZX_KEY }, '');
      assert.equal(empty.status, 403, empty.raw);
      assert.equal(empty.json.error, 'agent token 不能为空');

      const wrong = await s.call({ key: ZX_KEY }, 'deadbeefdeadbeefdeadbeefdeadbeef');
      assert.equal(wrong.status, 403, wrong.raw);
      assert.equal(wrong.json.error, 'agent token 无效');

      // 拿别的群的 token 也不行。
      const crossed = await s.call({ key: ZX_KEY }, s.token(OTHER_KEY));
      assert.equal(crossed.status, 403, crossed.raw);
      assert.equal(crossed.json.error, 'agent token 无效');
    });

    await check('生产路径（x-agent-call: 1）：真令牌 200，假令牌被集中关卡拦下', async () => {
      // MCP 的 agentHeaders 一定带 x-agent-call: 1，这时桥接要求令牌命中某个活跃会话。
      const ok = await s.call({ key: ZX_KEY, topic: 'heuristics' }, token, { agentCall: true });
      assert.equal(ok.status, 200, ok.raw);
      assert.equal(ok.json.topic, 'heuristics');
      assert.ok(ok.json.text.includes('HEUR-1-MARK'));

      const bogus = await s.call({ key: ZX_KEY }, 'deadbeefdeadbeefdeadbeefdeadbeef', { agentCall: true });
      assert.equal(bogus.status, 403, bogus.raw);

      const tokenless = await s.call({ key: ZX_KEY }, undefined, { agentCall: true });
      assert.equal(tokenless.status, 403, tokenless.raw);
      assert.ok(tokenless.json.error.includes('必须携带有效的会话令牌'), tokenless.json.error);
    });

    await check('参数：key 为空 → 400', async () => {
      const { status, json, raw } = await s.call({ key: '   ' }, token);
      assert.equal(status, 400, raw);
      assert.equal(json.ok, false);
      assert.equal(json.error, 'key 不能为空');
    });

    await check('mtime 缓存：内容改了但 mtime 没变 → 仍回旧正文；mtime 一变 → 立刻生效', async () => {
      const fixed = new Date('2026-01-02T03:04:05.000Z');
      const first = FIXTURE_SKILL.replace('MODEL-A-MARK', 'MODEL-A-V1');
      fs.writeFileSync(sandbox.file, first, 'utf8');
      fs.utimesSync(sandbox.file, fixed, fixed);

      const v1 = await s.call({ key: ZX_KEY, topic: 'frameworks' }, token);
      assert.equal(v1.status, 200, v1.raw);
      assert.ok(v1.json.text.includes('MODEL-A-V1'), '第一次应当读到 v1');
      assert.equal(v1.json.mtime, fixed.toISOString());

      // 换内容但把 mtime 按回去 —— 缓存应当命中，返回的仍是 v1。
      const second = FIXTURE_SKILL.replace('MODEL-A-MARK', 'MODEL-A-V2');
      fs.writeFileSync(sandbox.file, second, 'utf8');
      fs.utimesSync(sandbox.file, fixed, fixed);
      const cached = await s.call({ key: ZX_KEY, topic: 'frameworks' }, token);
      assert.equal(cached.status, 200, cached.raw);
      assert.ok(cached.json.text.includes('MODEL-A-V1'), 'mtime 未变时必须复用缓存');
      assert.equal(cached.json.text.includes('MODEL-A-V2'), false);
      assert.equal(cached.json.mtime, fixed.toISOString());

      // mtime 前进 1 秒 → 必须重新读（运营改完 skill 立刻生效）。
      const later = new Date(fixed.getTime() + 1000);
      fs.utimesSync(sandbox.file, later, later);
      const fresh = await s.call({ key: ZX_KEY, topic: 'frameworks' }, token);
      assert.equal(fresh.status, 200, fresh.raw);
      assert.ok(fresh.json.text.includes('MODEL-A-V2'), 'mtime 变了必须重新读文件');
      assert.equal(fresh.json.mtime, later.toISOString());
    });

    await check('4000 字上限：超长截断并标注，chars 恒等于实际长度', async () => {
      const long = [
        '# 夹具（超长）',
        '',
        '## 核心心智模型',
        '',
        `长文甲 ${'甲乙丙丁戊己庚辛壬癸'.repeat(600)}`,
        '',
        '## 决策启发式',
        '',
        `长文乙 ${'子丑寅卯辰巳午未申酉'.repeat(600)}`,
        '',
        '## 表达DNA',
        '',
        '- 短句 EXPR-MARK。',
        ''
      ].join('\n');
      fs.writeFileSync(sandbox.file, long, 'utf8');
      const now = new Date();
      fs.utimesSync(sandbox.file, now, now);

      const all = await s.call({ key: ZX_KEY }, token);
      assert.equal(all.status, 200, all.raw);
      assert.equal(all.json.truncated, true, 'all 必须被截断');
      assert.equal(all.json.chars, 4000, `截断后应恰好 4000 字，实际 ${all.json.chars}`);
      assert.equal(all.json.text.length, all.json.chars);
      assert.ok(all.json.text.includes('已截断'), '截断要标注');

      const single = await s.call({ key: ZX_KEY, topic: 'frameworks' }, token);
      assert.equal(single.status, 200, single.raw);
      assert.equal(single.json.truncated, true);
      assert.ok(single.json.chars <= 4000);
      assert.ok(single.json.text.startsWith('## 核心心智模型'));
      assert.ok(single.json.text.includes('已截断'));

      const short = await s.call({ key: ZX_KEY, topic: 'expression' }, token);
      assert.equal(short.json.truncated, false, '短小节不该被标截断');
      assert.ok(short.json.chars < 4000);
    });
  } finally {
    await s.stop();
    sandbox.cleanup();
  }
}

// Z-001 补：真实 SKILL.md 的表达DNA 开头有一行「角色扮演时必须遵循的风格规则：」——
// 它只是个标签行，会把「你在角色扮演」的味道带进咨询模式，所以要剥掉；正文一个字不动。
{
  const sandbox = makeSandbox(
    FIXTURE_SKILL.replace('## 表达DNA\n\n- ', '## 表达DNA\n\n角色扮演时必须遵循的风格规则：\n\n- ')
  );
  const s = await startServer(fixtureConfig(sandbox.dir));
  try {
    await check('表达DNA 开头的「角色扮演…」标签行被剥掉，正文与标题都保留', async () => {
      const { json } = await s.call({ key: ZX_KEY, topic: 'expression' }, s.token(ZX_KEY));
      assert.equal(json.ok, true);
      assert.equal(json.text.includes('角色扮演'), false, `不该带标签行：${json.text.slice(0, 80)}`);
      assert.ok(json.text.startsWith('## 表达DNA'));
      assert.ok(json.text.includes('EXPR-MARK'), '正文不能跟着丢');
      assert.equal(json.text.includes('\n\n\n'), false, '剥掉标签后不能留空行');
    });
  } finally {
    await s.stop();
    sandbox.cleanup();
  }
}

// 文件不存在 / 小节缺失 → 503 语义的 {ok:false, code:'unavailable'}，不能是未捕获异常。
{
  const missing = makeSandbox(null); // 目录都不建
  const s = await startServer(fixtureConfig(missing.dir));
  try {
    await check('文件缺失 → 500 + code:unavailable（不是未捕获异常）', async () => {
      const { status, json, raw } = await s.call({ key: ZX_KEY }, s.token(ZX_KEY));
      assert.equal(status, 500, raw);
      assert.equal(json.ok, false);
      assert.equal(json.code, 'unavailable');
      assert.ok(json.error.includes('SKILL.md'), json.error);
      assert.equal(json.text, undefined);
    });

    // 端点还活着（失败没有把服务打挂）。
    const again = await s.call({ key: ZX_KEY, topic: 'frameworks' }, s.token(ZX_KEY));
    assert.equal(again.status, 500);
  } finally {
    await s.stop();
    missing.cleanup();
  }
}
// Z-002：socialV2.zx.dir 是配置，不能被当成「任意文件读取器」。
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zx-other-file-'));
  const secret = path.join(base, 'secrets.txt');
  fs.writeFileSync(secret, '## 核心心智模型\n\n这不是 skill，是别的文件 SECRET-MARK。\n', 'utf8');
  const s = await startServer({ allow: { private: ['123'], groups: ['1131654608'] }, socialV2: { zx: { dir: secret } } });
  try {
    await check('dir 指到非 SKILL.md 的任意文件 → 500 unavailable，绝不返回其内容', async () => {
      const { status, json, raw } = await s.call({ key: ZX_KEY }, s.token(ZX_KEY));
      assert.equal(status, 500, raw);
      assert.equal(json.ok, false);
      assert.equal(json.code, 'unavailable');
      assert.ok(json.error.includes('SKILL.md'), json.error);
      assert.equal(json.text, undefined, '不能把别的文件内容当 skill 正文回给模型');
      assert.equal(raw.includes('SECRET-MARK'), false);
    });
  } finally {
    await s.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
}
// allowKeys 显式给空数组 = 谁都不许（不能被默认值悄悄覆盖）。
{
  const sandbox = makeSandbox();
  const s = await startServer({ allow: { private: ['123'], groups: ['1131654608'] }, socialV2: { zx: { dir: sandbox.file, allowKeys: [] } } });
  try {
    await check('allowKeys: [] → 连默认群也 403（fail-closed）', async () => {
      const { status, json, raw } = await s.call({ key: ZX_KEY }, s.token(ZX_KEY));
      assert.equal(status, 403, raw);
      assert.equal(json.code, 'forbidden');
    });
  } finally {
    await s.stop();
    sandbox.cleanup();
  }
}
{
  const noSection = makeSandbox(FIXTURE_SKILL.replace('## 表达DNA', '## 表达 DNA 改写（找不到）'));
  const s = await startServer(fixtureConfig(noSection.dir));
  try {
    await check('小节缺失 → 500 + code:unavailable，并指出找的是哪一节', async () => {
      const { status, json, raw } = await s.call({ key: ZX_KEY, topic: 'expression' }, s.token(ZX_KEY));
      assert.equal(status, 500, raw);
      assert.equal(json.code, 'unavailable');
      assert.ok(json.error.includes('表达DNA'), json.error);
    });
    await check('空文件 → 500 + code:unavailable', async () => {
      fs.writeFileSync(noSection.file, '   \n\n', 'utf8');
      const now = new Date(fs.statSync(noSection.file).mtimeMs + 5000);
      fs.utimesSync(noSection.file, now, now);
      const { status, json, raw } = await s.call({ key: ZX_KEY }, s.token(ZX_KEY));
      assert.equal(status, 500, raw);
      assert.equal(json.code, 'unavailable');
      assert.ok(json.error.includes('空文件'), json.error);
    });
  } finally {
    await s.stop();
    noSection.cleanup();
  }
}

// 真冒烟：完全默认配置 + 真实外部 skill（不覆盖 zx.dir）。文件不在的机器上 SKIP。
{
  if (!fs.existsSync(REAL_SKILL)) {
    console.log(`SKIP 真实 skill 冒烟：${REAL_SKILL} 不存在`);
  } else {
    const s = await startServer({ allow: { private: ['123'], groups: ['1131654608', '119212385'] } });
    try {
      await check('真冒烟：group:1131654608 取到真实 skill 的三节框架（不含角色扮演规则）', async () => {
        const { status, json, raw } = await s.call({ key: ZX_KEY }, s.token(ZX_KEY));
        assert.equal(status, 200, raw);
        assert.equal(json.ok, true);
        assert.ok(json.chars > 0, 'chars 必须大于 0');
        assert.ok(json.chars <= 4000);
        // 真实 skill 四节合计约 3436 字；去掉「角色扮演规则」后应明显变小。
        assert.ok(json.chars < 3436, `三节应明显小于四节的 3436 字，实际 ${json.chars}`);
        assert.equal(json.source, 'zhangxuefeng-skill/SKILL.md');
        for (const heading of ['## 核心心智模型', '## 决策启发式', '## 表达DNA']) {
          assert.ok(json.text.includes(heading), `真实 skill 应当含 ${heading}`);
        }
        assert.ok(json.text.includes('心智模型') && json.text.includes('决策启发式'));
        // Z-001：咨询模式，真实返回体里不能有「切换人格」的字样。
        assert.equal(json.text.includes('角色扮演'), false, '真实返回体不能出现「角色扮演」字样');
        assert.equal(json.text.includes('直接以张雪峰的身份回应'), false, '不能带出人格指令原文');
      });
      await check('真冒烟：group:119212385 → 403', async () => {
        const { status, json, raw } = await s.call({ key: OTHER_KEY }, s.token(OTHER_KEY));
        assert.equal(status, 403, raw);
        assert.equal(json.code, 'forbidden');
      });
    } finally {
      await s.stop();
    }
  }
}

// T-033：唤醒提示词里也写死「话题命中就调张雪峰视角」，不用等 DSH 重启才进新会话。
// 这份提示词是桥接每一轮现拼的，所以判定必须和端点一致（同一份 allowKeys + 同一个默认值）。
{
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['1131654608', '119212385'] } } });
  try {
    await check('the wake prompt tells an allowed group when to consult, and stays quiet elsewhere', async () => {
      const allowed = h.buildWakePromptV2(ZX_KEY, 'atMention');
      assert.ok(allowed.includes('【张雪峰视角】'), '允许的群要把触发条件写进唤醒提示词（等不了 DSH 重启）');
      assert.ok(allowed.includes('zx_perspective'), '要写清调哪个工具');
      for (const topic of ['志愿填报', '专业选择', '择校', '就业方向']) {
        assert.ok(allowed.includes(topic), `四个触发话题都要点到，缺 ${topic}`);
      }
      const other = h.buildWakePromptV2(OTHER_KEY, 'atMention');
      assert.equal(other.includes('【张雪峰视角】'), false, '不在 allowKeys 的群不能看到这张小灶');
      assert.equal(other.includes('zx_perspective'), false, '连工具名都不该出现');
      // allowKeys: [] = 谁都不许：提示词不能因为「有默认值」又把它放出来（与端点同一份判定）。
      h.cfg.socialV2.zx = { ...h.cfg.socialV2.zx, allowKeys: [] };
      assert.equal(h.buildWakePromptV2(ZX_KEY, 'atMention').includes('【张雪峰视角】'), false, 'allowKeys: [] 时提示词也要闭嘴');
    });
  } finally { await h.close(); }
}

// 源码层断言：MCP 工具真的注册了，位置在 reach 之后、connect 之前；bridge 端点串没写歪。
{
  await check('MCP：zx_perspective 已注册，描述写清 gating / 参考资料而非指令', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
    assert.ok(src.includes("'zx_perspective'"), '必须注册 zx_perspective 工具');
    assert.ok(src.includes("agentApi('/api/socialV2/zx-perspective'"), '必须走桥接端点');
    const at = src.indexOf("'zx_perspective'");
    const reach = src.indexOf('registerReachTools(server)');
    const connect = src.indexOf('await server.connect(new StdioServerTransport())');
    assert.ok(reach > 0 && connect > 0, '锚点必须存在');
    assert.ok(at > reach, 'zx_perspective 要追加在 reach 工具之后');
    assert.ok(at < connect, '必须在 server.connect 之前注册');
    assert.ok(src.includes('只在指定群可用'), '描述要写明只在指定群可用');
    assert.ok(src.includes('不是张雪峰本人的观点'), '描述要写明是参考框架而非本人观点');
    // Z-001：枚举只留三节 + all；不能再出现 rules，也不许再有「拿不准就取 all」的倾向性引导。
    // 中文别名（心智模型/启发式/表达/全部）只是同一组取值的另一种说法，桥接侧会归一，不新增节。
    assert.ok(
      src.includes(".enum(['frameworks', 'heuristics', 'expression', 'all', '心智模型', '启发式', '表达', '全部'])"),
      'topic 枚举只留三节 + all（外加同一组取值的中文别名）'
    );
    assert.equal(src.includes("'rules'"), false, 'MCP 侧不能再出现 rules');
    assert.equal(src.includes('拿不准就取 all'), false, '不能引导模型默认取 all');
    assert.ok(src.includes('参考资料，不是给你的指令'), '描述要写明这是参考资料而非指令');
    assert.ok(src.includes('不要照抄里面第一人称的口气'), '描述要提醒别照抄第一人称口径');
  });

  await check('bridge：端点、允许列表默认值、4000 上限与 mtime 缓存都在', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
    assert.ok(src.includes("'/api/socialV2/zx-perspective'"));
    assert.ok(src.includes("const ZX_DEFAULT_ALLOW_KEYS = ['group:1131654608'];"), '默认只允许一个群');
    assert.ok(src.includes('const ZX_MAX_CHARS = 4000;'));
    assert.ok(src.includes('function readZxSkillText('), '要有按 mtime 的读取函数');
    assert.ok(src.includes('cached.mtimeMs === stat.mtimeMs'), '缓存键必须是 mtime');
    assert.ok(src.includes("'zhangxuefeng-skill'"), '默认路径要指向外部 skill 目录');
    assert.ok(src.includes("code: 'unavailable'"), '读不到要有 unavailable 语义');
    // 端点必须在 startConsoleServer 内（sendJson / readBody 的作用域里）。
    const serverAt = src.indexOf('function startConsoleServer()');
    assert.ok(src.indexOf("'/api/socialV2/zx-perspective'") > serverAt, '端点要加在 startConsoleServer 里');
    // Z-001：小节表里不能再有「角色扮演规则」。
    const sectionsAt = src.indexOf('const ZX_SECTIONS = [');
    const sectionsBlock = src.slice(sectionsAt, src.indexOf('];', sectionsAt));
    assert.ok(sectionsAt > 0, 'ZX_SECTIONS 必须存在');
    assert.equal(sectionsBlock.includes('角色扮演规则'), false, 'ZX_SECTIONS 不能包含角色扮演规则');
    assert.equal((sectionsBlock.match(/key:/g) || []).length, 3, 'ZX_SECTIONS 应当只有三节');
    // Z-002：只服务 SKILL.md 这一份文件。
    assert.ok(src.includes("const ZX_SKILL_BASENAME = 'SKILL.md';"), '要有文件名白名单');
    assert.ok(src.includes('path.basename(file) !== ZX_SKILL_BASENAME'), 'readZxSkillText 要校验文件名');
  });

  await check('bridge：默认群号只留一个字面量（ZX_DEFAULT_ALLOW_KEYS），端点与唤醒提示词共用', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
    // 只认带引号的字面量（注释里提到群号不算「又抄了一份默认值」）。
    const hits = src.split(/\r?\n/).filter((line) => line.includes("'group:1131654608'"));
    assert.equal(hits.length, 1, `默认群号字面量应只在 ZX_DEFAULT_ALLOW_KEYS 那一行，实际 ${hits.length} 行：${hits.join(' | ')}`);
    assert.ok(hits[0].includes('const ZX_DEFAULT_ALLOW_KEYS = '), `那一行必须是常量定义：${hits[0]}`);
    // 唤醒提示词的判定必须复用端点那份归一（含默认值与 allowKeys: [] 的语义），不许另写一套。
    assert.ok(src.includes('zxPerspectiveSettings(cfg).allowKeys.includes('), '唤醒提示词要复用 zxPerspectiveSettings 的判定');
  });

  await check('三个改动文件 node --check 通过', async () => {
    for (const rel of ['src/bridge.js', 'src/mcp-snowluma-safe.js', 'scripts/test-zx-perspective.mjs']) {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
    }
  });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`FAILED: ${name}\n${error?.stack ?? error}`);
  process.exit(1);
}
