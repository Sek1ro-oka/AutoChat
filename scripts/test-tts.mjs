// T-032：文本 → 语音条（TTS）自测。
//
// 七组（对应 work/agent-tasks/T-032/dev-doc.md §4）：
//   1. sanitizeSpeakText：删占位符/URL/@/emoji，洗不出人话 → empty，超长 → too_long（夹取生效）
//   2. splitBySentences：每段 ≤ maxChars、不切在句号中间、空输入 → []
//   3. resolveTtsSettings：engine 认不出回落 auto，maxChars / timeoutMs / rate 夹取
//   4. 路由闸门：voice.enabled=false / 不在白名单 / tools.speak=false / 假 token / 额度用尽
//   5. 合成失败：auto 回落 SAPI、显式 edge 直接失败、超时 kill、stderr 噪音不进错误文案
//   6. 成功路径：假 spawn 写 1 秒 WAV → 真的走 sendVoiceForV2（record 段落在 audio/.tts/ 里，
//      audio 传的是 null），返回后临时文件已删
//   7. 真实冒烟：node scripts/send-voice.mjs list-voice 看不到 .tts/ 里的东西
//
// 4~6 组用 scripts/audit-bridge-harness.mjs 跑**真实 src/bridge.js**（VM 里 loadConfig +
// startConsoleServer），所以 gating 顺序、额度、路径解析哪一环真出问题这里会一起红；
// 合成这一步用 __setSpawnForTest 换成假 spawn，不会真去跑 edge-tts / SAPI。
//
// 单独跑：node scripts/test-tts.mjs（已登记在 scripts/test-audit.mjs）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  TtsError,
  __setSpawnForTest,
  resolveTtsSettings,
  resolveTtsTone,
  resolveTtsVoice,
  ttsToneLabels,
  ttsVoiceLabels,
  TTS_TONES,
  TTS_VOICES,
  TTS_DEFAULT_TONE,
  TTS_DEFAULT_VOICE,
  sanitizeSpeakText,
  splitBySentences,
  synthesizeEdge,
  synthesizeSapi
} from '../src/tts-core.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AUDIO_DIR = path.join(ROOT, 'audio');
const TTS_DIR = path.join(AUDIO_DIR, '.tts');
const CONSOLE_TOKEN = 'fixture-console-token';
const SPEAK_ENDPOINT = '/api/socialV2/speak';
const KEY = 'group:456';            // harness 默认 allow.groups
const PRIVATE_KEY = 'private:123';  // harness 默认 allow.private
const OUTSIDE_KEY = 'private:123456'; // 连 allow.private 都不在
// 让 resolveTtsPython() 有东西可指：它只要求「这个路径是个文件」，假的 spawn 不会真跑它。
const FAKE_PYTHON = process.execPath;

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

// ── 假子进程 ────────────────────────────────────────────────────────────────
/** 1 秒 16kHz 单声道静音 WAV（只要是个非空 .wav，inspectAudio 在没有 ffprobe 时会放行）。 */
function silentWav(seconds = 1, sampleRate = 16000) {
  const samples = Math.max(1, Math.round(sampleRate * seconds));
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);              // PCM
  header.writeUInt16LE(1, 22);              // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 这次调用走的是哪个引擎：edge 是 `python -c <脚本>`，SAPI 是 `pwsh -EncodedCommand`。 */
function engineOf(call) {
  return (call?.args ?? []).some((arg) => String(arg).includes('edge_tts')) ? 'edge' : 'sapi';
}

/** SAPI 的脚本被 base64(UTF-16LE) 包着：解出来才能断言它到底设了什么。 */
function sapiScript(call) {
  const at = (call?.args ?? []).indexOf('-EncodedCommand');
  if (at < 0) return '';
  return Buffer.from(String(call.args[at + 1] ?? ''), 'base64').toString('utf16le');
}

/** 边缘合成的参数全在 job JSON 里（环境变量 TTS_JOB 指过去）。 */
function readJob(opts) {
  const jobFile = opts?.env?.TTS_JOB;
  if (!jobFile) return null;
  try {
    return JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  } catch {
    return null;
  }
}

/** 从 argv / job 里找出这次的输出文件。 */
function extractOutFile(command, args, opts = {}) {
  const job = readJob(opts);
  if (job?.out) return job.out;
  const encoded = args.indexOf('-EncodedCommand');
  if (encoded >= 0) {
    const script = Buffer.from(String(args[encoded + 1] ?? ''), 'base64').toString('utf16le');
    const m = /SetOutputToWaveFile\('(.*?)'\)/s.exec(script);
    if (m) return m[1].replace(/''/g, "'");
  }
  return null;
}

/**
 * 装一个假 spawn（只影响 tts-core 内部，voice-core 的 ffprobe 探测仍是真 spawn）。
 *   fail: ['edge'] / ['sapi'] —— 让指定引擎以退出码 1 结束（带 SSL 噪音，验过滤）
 *   silent: true —— 永不 close，用来触发超时
 */
function installFakeSpawn({ fail = [], silent = false } = {}) {
  const calls = [];
  const spawn = (command, args = [], opts = {}) => {
    const call = { command, args: [...args], opts, env: opts?.env ?? {}, job: readJob(opts) };
    calls.push(call);
    const handlers = new Map();
    const add = (key, fn) => {
      const list = handlers.get(key) ?? [];
      list.push(fn);
      handlers.set(key, list);
    };
    const child = {
      on(event, fn) { add(event, fn); return child; },
      kill() { call.killed = true; },
      stderr: { on(event, fn) { add(`stderr:${event}`, fn); return child; } }
    };
    const emit = (key, value) => { for (const fn of handlers.get(key) ?? []) fn(value); };
    const kind = engineOf(call);
    if (!silent) {
      // 异步 close：让 runChildImpl 先把 on('close') / stderr.on('data') 注册上。
      setImmediate(() => {
        if (fail.includes(kind)) {
          emit('stderr:data', Buffer.from(
            'SSLCertVerificationError: certificate verify failed\n' +
            '    raise ConnectionError("boom")\n' +
            'edge_tts 真的挂了\n'
          ));
          emit('close', 1);
          return;
        }
        const outFile = extractOutFile(command, args, opts);
        if (outFile) {
          try {
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            fs.writeFileSync(outFile, silentWav(1));
          } catch { /* 路径错就让 requireOutput 报错 */ }
        }
        emit('close', 0);
      });
    }
    return child;
  };
  const previous = __setSpawnForTest(spawn);
  return { calls, restore: () => __setSpawnForTest(previous) };
}

// ── 控制台 HTTP ─────────────────────────────────────────────────────────────
function postJson(port, endpoint, body, { token } = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: endpoint,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-console-token': CONSOLE_TOKEN,
        connection: 'close',
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
    request.setTimeout(20000, () => request.destroy(new Error('request hung')));
    request.end(payload);
  });
}

/** 记录桥接传给 processAudioVolume 的参数 —— 用来证明 speakV2 传的是 audio:null。 */
function bridgeGlobals(audioCalls) {
  return {
    TtsError,
    resolveTtsSettings,
    resolveTtsTone,
    resolveTtsVoice,
    sanitizeSpeakText,
    synthesizeEdge,
    synthesizeSapi,
    async processAudioVolume(file, opts = {}) {
      audioCalls.push({ file, opts });
      return {
        path: file,
        converted: false,
        mode: 'original',
        detail: '原样发送（测试桩：不做音量处理）',
        volume: opts.volume ?? 1,
        loudness: opts.loudness ?? 'normal'
      };
    },
    cleanupTemp: () => {}
  };
}

async function startHarness(config, audioCalls) {  const h = await bridgeHarness({ config, globals: bridgeGlobals(audioCalls) });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  return {
    h,
    port,
    token: (key) => h.getSocialV2State(key).agentToken,
    speak: (body, token) => postJson(port, SPEAK_ENDPOINT, body, { token }),
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    }
  };
}

/** 桥接在 harness 里的临时音频目录（ROOT 被指到临时沙箱，不是仓库的 audio/）。 */
function harnessTtsDir(s) {
  return path.join(s.h.voiceCfg().dir, '.tts');
}

/** 语音相关配置：默认全开、额度不限（额度另有专门用例）。 */
function baseConfig(socialV2 = {}) {
  return {
    socialV2: {
      voice: {
        enabled: true,
        dir: 'audio',
        maxSeconds: 20,
        maxBytes: 20971520,
        maxPerMinute: 0,
        maxPerHour: 0,
        ...(socialV2.voice ?? {})
      },
      tts: { engine: 'sapi', pythonPath: FAKE_PYTHON, timeoutMs: 3000, ...(socialV2.tts ?? {}) },
      tools: { speak: true, ...(socialV2.tools ?? {}) }
    }
  };
}

/** 清掉某个 .tts 目录里本轮留下的 tts-* 文件（断言「发完即删」也用它）。 */
function leftoverFiles(dir = TTS_DIR) {
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith('tts-'));
  } catch {
    return [];
  }
}

// ── 1. 文本清洗 ─────────────────────────────────────────────────────────────
await check('清洗：占位符 / URL / @昵称 / emoji 都删掉，空白折叠', async () => {
  assert.equal(sanitizeSpeakText('  你好   世界  '), '你好 世界');
  assert.equal(sanitizeSpeakText('[图片]哈哈😄'), '哈哈');
  assert.equal(sanitizeSpeakText('看这个 https://example.com/a?b=1 好玩吧'), '看这个 好玩吧');
  assert.equal(sanitizeSpeakText('@张三 你好'), '你好');
  assert.equal(sanitizeSpeakText('真的吗？？？'), '真的吗？');
  assert.equal(sanitizeSpeakText('嗯…那个'), '嗯。那个');
});

await check('清洗：只剩标点/表情 → TtsError(empty)', async () => {
  for (const raw of ['。。。！', '😀😀', '   ', '', '[表情]']) {
    await assert.rejects(
      async () => sanitizeSpeakText(raw),
      (error) => error instanceof TtsError && error.code === 'empty',
      `「${raw}」应当被判定为空`
    );
  }
});

await check('清洗：超长抛 too_long（带 chars/maxChars/suggestion，不静默截断）', async () => {
  await assert.rejects(
    async () => sanitizeSpeakText('啊'.repeat(81)),
    (error) => {
      assert.equal(error.code, 'too_long');
      assert.equal(error.chars, 81);
      assert.equal(error.maxChars, 80);
      assert.ok(error.suggestion && error.suggestion.length > 0, '应当给出「只说前半句」的建议');
      assert.match(error.message, /超过上限 80 字/);
      return true;
    }
  );
  // maxChars 传 5 会被夹到下限 10：12 个字仍然超长，报出来的上限是 10 而不是 5。
  await assert.rejects(
    async () => sanitizeSpeakText('abcdefghijkl', { maxChars: 5 }),
    (error) => error.code === 'too_long' && error.maxChars === 10
  );
});

// ── 2. 切句 ─────────────────────────────────────────────────────────────────
await check('切句：短句不拆、每段 ≤ maxChars、空输入 → []', async () => {
  assert.deepEqual(splitBySentences(''), []);
  assert.deepEqual(splitBySentences('   '), []);
  assert.deepEqual(splitBySentences('今天天气不错。我们出去走走吧！'), ['今天天气不错。我们出去走走吧！']);
  const two = splitBySentences('今天天气不错。我们出去走走吧！', 8);
  assert.deepEqual(two, ['今天天气不错。', '我们出去走走吧！']);
  for (const piece of two) assert.ok([...piece].length <= 8, `「${piece}」超长`);
  const english = splitBySentences('Hello there! How are you?', 20);
  assert.deepEqual(english, ['Hello there!', 'How are you?']);
});

await check('切句：单句超长时先按逗号退步，实在不行才硬切（不切在句号中间）', async () => {
  const text = '第一句有点长，第二句也有点长，第三句更长了';
  const parts = splitBySentences(text, 8);
  assert.ok(parts.length >= 2);
  for (const piece of parts) assert.ok([...piece].length <= 8, `「${piece}」超长`);
  // 除了标点可能被留在上一段，正文一个字都不能丢。
  const strip = (s) => s.replace(/[\s，。！？；、]/g, '');
  assert.equal(parts.map(strip).join(''), strip(text));
});

// ── 3. 配置夹取 ─────────────────────────────────────────────────────────────
await check('配置：缺省值 / engine 归一 / maxChars、timeoutMs、rate 夹取', async () => {
  const d = resolveTtsSettings();
  assert.equal(d.engine, 'auto');
  assert.equal(d.voice, 'zh-CN-XiaoyiNeural');
  assert.equal(d.lang, 'mandarin');
  assert.equal(d.rate, 0);
  assert.equal(d.tone, 'neutral');
  assert.equal(d.pitch, 0);
  assert.equal(d.volume, 0);
  assert.equal(d.maxChars, 80);
  assert.equal(d.timeoutMs, 15000);
  assert.equal(d.pythonPath, '');
  assert.equal(d.dir, '');
  assert.deepEqual(d.warnings, []);
  assert.equal(resolveTtsSettings({ engine: ' SAPI ' }).engine, 'sapi');
  assert.equal(resolveTtsSettings({ engine: '说人话' }).engine, 'auto');
  assert.equal(resolveTtsSettings({ maxChars: 5 }).maxChars, 10);
  assert.equal(resolveTtsSettings({ maxChars: 999 }).maxChars, 120);
  assert.equal(resolveTtsSettings({ maxChars: 'abc' }).maxChars, 80);
  assert.equal(resolveTtsSettings({ timeoutMs: 10 }).timeoutMs, 3000);
  assert.equal(resolveTtsSettings({ timeoutMs: 999999 }).timeoutMs, 30000);
  assert.equal(resolveTtsSettings({ rate: 999 }).rate, 30);
  assert.equal(resolveTtsSettings({ rate: -999 }).rate, -30);
  assert.equal(resolveTtsSettings({ pitch: 999 }).pitch, 30);
  assert.equal(resolveTtsSettings({ pitch: -999 }).pitch, -30);
  assert.equal(resolveTtsSettings({ volume: 999 }).volume, 50);
  assert.equal(resolveTtsSettings({ volume: -999 }).volume, -50);
  assert.equal(resolveTtsSettings({ voice: '   ' }).voice, 'zh-CN-XiaoyiNeural');
  assert.equal(resolveTtsSettings({ voice: '粤语' }).voice, 'zh-HK-HiuMaanNeural');
  assert.equal(resolveTtsSettings({ voice: 'Cantonese' }).lang, 'cantonese');
  // 白名单之外的音色**不静默接受**：回落默认，并给一条 warn（bridge 会记日志）。
  const male = resolveTtsSettings({ voice: 'zh-CN-YunxiNeural' });
  assert.equal(male.voice, 'zh-CN-XiaoyiNeural');
  assert.equal(male.warnings.length, 1);
  assert.match(male.warnings[0], /不在白名单里/);
  assert.match(male.warnings[0], /普通话·晓依/);
  assert.equal(resolveTtsSettings({ dir: ' audio/tts ' }).dir, 'audio/tts');
  // 语气（T-034）：认得出的归一成档位 id，认不出的回落默认 + 一条 warn（不静默换成别的语气）。
  assert.equal(resolveTtsSettings({ tone: ' 高兴 ' }).tone, 'happy');
  assert.equal(resolveTtsSettings({ tone: '温柔' }).tone, 'gentle');
  assert.equal(resolveTtsSettings({ tone: '认真' }).tone, 'serious');
  const badTone = resolveTtsSettings({ tone: '笑嘻嘻' });
  assert.equal(badTone.tone, 'neutral');
  assert.equal(badTone.warnings.length, 1);
  assert.match(badTone.warnings[0], /tone「笑嘻嘻」/);
  assert.match(badTone.warnings[0], /平淡/);
});

await check('音色白名单：普通话·晓依（默认）/ 普通话·晓晓（备用）/ 粤语·曉曼，一个男声都没有', async () => {
  // 静态断言：白名单表里不许出现任何 Male 音色 id（模型传进来会被 bad_voice 挡住，
  // 但配置里也不许有人把它们写进去当可选音色）。
  const core = fs.readFileSync(path.join(ROOT, 'src', 'tts-core.js'), 'utf8');
  const start = core.indexOf('export const TTS_VOICES');
  const end = core.indexOf('export const TTS_DEFAULT_VOICE');
  assert.ok(start > 0 && end > start, 'tts-core.js 里应当有 TTS_VOICES 表');
  const table = core.slice(start, end);
  const maleIds = ['Yunxi', 'Yunyang', 'Yunjian', 'Yunxia', 'Yunfeng', 'Yunhao', 'Yunze', 'Yunjie', 'Yunye', 'Yunqiu', 'WanLung'];
  for (const id of maleIds) assert.equal(table.includes(id), false, `白名单里不许出现男声 ${id}`);
  assert.deepEqual(TTS_VOICES.map((voice) => voice.id), [
    'zh-CN-XiaoyiNeural',
    'zh-CN-XiaoxiaoNeural',
    'zh-HK-HiuMaanNeural'
  ]);
  assert.deepEqual(TTS_VOICES.map((voice) => voice.label), ['普通话·晓依', '普通话·晓晓', '粤语·曉曼']);
  assert.deepEqual(TTS_VOICES.map((voice) => voice.lang), ['mandarin', 'mandarin', 'cantonese']);
  // 顺序即展示顺序、也是缺省：第一条必须是默认音色，两处不能各写各的。
  assert.equal(TTS_VOICES[0].id, 'zh-CN-XiaoyiNeural');
  assert.equal(TTS_DEFAULT_VOICE, 'zh-CN-XiaoyiNeural');
  assert.equal(TTS_DEFAULT_VOICE, TTS_VOICES[0].id);
  assert.equal(ttsVoiceLabels(), '普通话·晓依 / 普通话·晓晓 / 粤语·曉曼');
  // 别名只认这几种写法；男声 id 解析不出结果（→ 调用方报 bad_voice）。
  for (const alias of ['mandarin', '普通话', '中文', 'xiaoyi', '晓依', 'zh-CN-XiaoyiNeural', 'MANDARIN']) {
    assert.equal(resolveTtsVoice(alias)?.id, 'zh-CN-XiaoyiNeural', `${alias} 应当解析成普通话·晓依`);
  }
  for (const alias of ['xiaoxiao', '晓晓', 'zh-CN-XiaoxiaoNeural']) {
    assert.equal(resolveTtsVoice(alias)?.id, 'zh-CN-XiaoxiaoNeural', `${alias} 应当解析成普通话·晓晓（备用）`);
  }
  for (const alias of ['cantonese', '粤语', '广东话', 'xiaoman', '曉曼', '晓曼', 'zh-HK-HiuMaanNeural']) {
    assert.equal(resolveTtsVoice(alias)?.id, 'zh-HK-HiuMaanNeural', `${alias} 应当解析成粤语`);
  }
  for (const bad of ['zh-CN-YunxiNeural', 'en-US-AriaNeural', 'zh-CN-liaoning-XiaobeiNeural', '随便', '']) {
    assert.equal(resolveTtsVoice(bad), null, `${bad} 不该被解析成任何音色`);
  }
  // config.example.json 里那份镜像也要一致（出版物不能教人配男声）。
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const tts = example.socialV2.tts;
  assert.deepEqual(tts.voices.map((voice) => voice.id), [
    'zh-CN-XiaoyiNeural',
    'zh-CN-XiaoxiaoNeural',
    'zh-HK-HiuMaanNeural'
  ]);
  assert.deepEqual(tts.voices.map((voice) => voice.label), ['普通话·晓依', '普通话·晓晓', '粤语·曉曼']);
  assert.equal(tts.voice, TTS_DEFAULT_VOICE, 'config.example.json 的默认音色要与代码一致');
  assert.equal(TTS_VOICES.some((voice) => voice.id === tts.voice), true, 'tts.voice 必须在白名单之内');
});

await check('语气档位：五档顺序与数值（平淡/高兴/温和/冷淡/认真），缺省平淡', async () => {
  assert.deepEqual(TTS_TONES.map((tone) => tone.id), ['neutral', 'happy', 'gentle', 'cold', 'serious']);
  assert.deepEqual(TTS_TONES.map((tone) => tone.label), ['平淡', '高兴', '温和', '冷淡', '认真']);
  // 每一档的声学参数就是 dev-doc §2 那张表；改数字要先改文档。
  assert.deepEqual(
    TTS_TONES.map((tone) => [tone.rate, tone.pitch, tone.volume]),
    [[0, 0, 0], [8, 6, 3], [-6, -2, 0], [4, -6, -10], [-10, 0, 5]]
  );
  assert.equal(TTS_DEFAULT_TONE, 'neutral');
  assert.equal(TTS_TONES[0].id, TTS_DEFAULT_TONE);
  assert.equal(ttsToneLabels(), '平淡 / 高兴 / 温和 / 冷淡 / 认真');
  // 别名（大小写不敏感），中英文都认。
  const aliases = {
    neutral: ['neutral', '平淡', '默认', '正常', 'NEUTRAL'],
    happy: ['happy', '高兴', '开心', '兴奋', '愉快'],
    gentle: ['gentle', '温和', '温柔', '关心', '耐心'],
    cold: ['cold', '冷淡', '冷漠', '敷衍', '平静', '不耐烦'],
    serious: ['serious', '认真', '郑重', '强调', '严肃']
  };
  for (const [id, list] of Object.entries(aliases)) {
    for (const alias of list) assert.equal(resolveTtsTone(alias)?.id, id, `${alias} 应当解析成 ${id}`);
  }
  // 认不出来就是 null（→ 桥接抛 bad_tone），绝不悄悄换成平淡。
  for (const bad of ['笑嘻嘻', 'angry', '凶', '']) {
    assert.equal(resolveTtsTone(bad), null, `${bad} 不该被解析成任何语气`);
  }
  // config.example.json 的镜像与默认值。
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const tts = example.socialV2.tts;
  assert.deepEqual(tts.tones.map((tone) => tone.id), ['neutral', 'happy', 'gentle', 'cold', 'serious']);
  assert.equal(tts.tone, TTS_DEFAULT_TONE);
  assert.equal(tts.pitch, 0);
  assert.equal(tts.volume, 0);
});

// ── 4. 路由闸门 ─────────────────────────────────────────────────────────────
{
  const disabled = await startHarness(baseConfig({ voice: { enabled: false } }), []);
  try {
    await check('闸门：socialV2.voice.enabled=false → 403 disabled', async () => {
      const res = await disabled.speak({ key: KEY, text: '你好' }, disabled.token(KEY));
      assert.equal(res.status, 403, res.raw);
      assert.equal(res.json.ok, false);
      assert.equal(res.json.reason, 'disabled');
    });
  } finally {
    await disabled.stop();
  }
}

{
  const audioCalls = [];
  const fake = installFakeSpawn();
  const s = await startHarness(baseConfig(), audioCalls);
  try {
    await check('闸门：缺 token / 假 token → 403 token', async () => {
      const noToken = await s.speak({ key: KEY, text: '你好' });
      assert.equal(noToken.status, 403, noToken.raw);
      assert.equal(noToken.json.reason, 'token');
      const badToken = await s.speak({ key: KEY, text: '你好' }, 'not-a-real-token-000000');
      assert.equal(badToken.status, 403, badToken.raw);
      assert.equal(badToken.json.reason, 'token');
      assert.equal(fake.calls.length, 0, '被闸门挡下时不应该合成');
    });

    await check('闸门：key 不在白名单 → 403 scope（且不合成）', async () => {
      const res = await s.speak({ key: OUTSIDE_KEY, text: '你好' }, s.token(OUTSIDE_KEY));
      assert.equal(res.status, 403, res.raw);
      assert.equal(res.json.reason, 'scope');
      assert.equal(fake.calls.length, 0, '被闸门挡下时不应该合成');
    });

    await check('闸门：key 为空 → 400 bad_key；格式不对 → fail closed 403（不合成）', async () => {
      const empty = await s.speak({ key: '', text: '你好' }, s.token(KEY));
      assert.equal(empty.status, 400, empty.raw);
      assert.equal(empty.json.reason, 'bad_key');
      // 格式不对的 key 连 token 都对不上（令牌是按合法 key 发的），所以只会 403 —— 关键是不放行。
      const malformed = await s.speak({ key: 'group-abc', text: '你好' }, s.token(KEY));
      assert.equal(malformed.status, 403, malformed.raw);
      assert.equal(fake.calls.length, 0);
    });

    await check('闸门：socialV2.tools.speak=false → 403 tool', async () => {
      s.h.cfg.socialV2.tools.speak = false;
      try {
        const res = await s.speak({ key: KEY, text: '你好' }, s.token(KEY));
        assert.equal(res.status, 403, res.raw);
        assert.equal(res.json.reason, 'tool');
      } finally {
        s.h.cfg.socialV2.tools.speak = true;
      }
    });

    await check('闸门：非 reserved2 模式 → 403（不带 reason 也必须是关着的）', async () => {
      s.h.setMode('chat');
      try {
        const res = await s.speak({ key: KEY, text: '你好' }, s.token(KEY));
        assert.equal(res.status, 403, res.raw);
        assert.equal(res.json.ok, false);
        assert.match(String(res.json.error ?? ''), /reserved2|模式/);
        assert.equal(fake.calls.length, 0, '模式不对时不应该合成');
      } finally {
        s.h.setMode('reserved2');
      }
    });

    await check('闸门：文本问题 → 400（empty / too_long），错误文案能直接给模型看', async () => {
      const empty = await s.speak({ key: KEY, text: '😀😀' }, s.token(KEY));
      assert.equal(empty.status, 400, empty.raw);
      assert.equal(empty.json.reason, 'empty');
      const tooLong = await s.speak({ key: KEY, text: '啊'.repeat(200) }, s.token(KEY));
      assert.equal(tooLong.status, 400, tooLong.raw);
      assert.equal(tooLong.json.reason, 'too_long');
      assert.equal(fake.calls.length, 0, '文本不合格时不应该合成');
    });

    await check('闸门：男声 / 外语音色 → 400 bad_voice，并列出允许的三项', async () => {
      for (const bad of ['zh-CN-YunxiNeural', 'en-US-AriaNeural']) {
        const res = await s.speak({ key: KEY, text: '你好', voice: bad }, s.token(KEY));
        assert.equal(res.status, 400, res.raw);
        assert.equal(res.json.reason, 'bad_voice');
        assert.match(res.json.error, /普通话·晓依/);
        assert.match(res.json.error, /普通话·晓晓/);
        assert.match(res.json.error, /粤语·曉曼/);
      }
      assert.equal(fake.calls.length, 0, '音色不对时不应该合成（更不许悄悄换成普通话）');
    });

    await check('闸门：额度用尽 → 429 budget（额度在合成之前就查）', async () => {
      s.h.cfg.socialV2.voice.maxPerMinute = 1;
      try {
        const first = await s.speak({ key: KEY, text: '第一句' }, s.token(KEY));
        assert.equal(first.status, 200, first.raw);
        assert.equal(first.json.ok, true);
        const spawnsAfterFirst = fake.calls.length;
        const second = await s.speak({ key: KEY, text: '第二句' }, s.token(KEY));
        assert.equal(second.status, 429, second.raw);
        assert.equal(second.json.reason, 'budget');
        assert.match(second.json.error, /语音发送频率超限（每分钟最多 1 条）/);
        // 被额度挡下时**没有**再合成一次（否则白等 + 白耗上游调用）。
        assert.equal(fake.calls.length, spawnsAfterFirst, '额度超限时不应该合成');
      } finally {
        s.h.cfg.socialV2.voice.maxPerMinute = 0;
      }
    });
  } finally {
    fake.restore();
    await s.stop();
  }
}

// ── 5. 合成失败与超时 ───────────────────────────────────────────────────────
await check('失败：auto 回落 SAPI —— edge 挂了照样把话说出去', async () => {
  const audioCalls = [];
  const fake = installFakeSpawn({ fail: ['edge'] });
  const s = await startHarness(baseConfig({ tts: { engine: 'auto' } }), audioCalls);
  try {
    const res = await s.speak({ key: KEY, text: '兜底也要说' }, s.token(KEY));
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.engine, 'sapi', '引擎应当是回落后的 sapi');
    const engines = fake.calls.map(engineOf);
    assert.deepEqual(engines, ['edge', 'sapi'], '应当先试 edge，再回落 sapi');
  } finally {
    fake.restore();
    await s.stop();
  }
});

await check('失败：显式 engine=edge 时不回落 → 503 tts_unavailable', async () => {
  const audioCalls = [];
  const fake = installFakeSpawn({ fail: ['edge'] });
  const s = await startHarness(baseConfig({ tts: { engine: 'edge' } }), audioCalls);
  try {
    const res = await s.speak({ key: KEY, text: '这条会失败' }, s.token(KEY));
    assert.equal(res.status, 503, res.raw);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.reason, 'tts_unavailable');
    assert.equal(fake.calls.length, 1, '显式引擎失败时不要再试第二个引擎');
    assert.equal(engineOf(fake.calls[0]), 'edge');
    // stderr 里的 SSL 噪音不该被当成失败原因甩给模型（信息量为 0，还吓人）。
    assert.equal(/SSL|certificate/i.test(res.json.error), false, res.json.error);
    assert.match(res.json.error, /edge-tts 退出码 1/);
    // 失败路径也不能留下半截音频。
    assert.deepEqual(leftoverFiles(harnessTtsDir(s)), []);
  } finally {
    fake.restore();
    await s.stop();
  }
});

await check('失败：粤语 edge 挂了 → 直接失败，不许用普通话顶替', async () => {
  const fake = installFakeSpawn({ fail: ['edge'] });
  const s = await startHarness(baseConfig({ tts: { engine: 'auto' } }), []);
  try {
    const res = await s.speak({ key: KEY, text: '今晚食乜嘢', voice: '粤语' }, s.token(KEY));
    assert.equal(res.status, 503, res.raw);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.reason, 'tts_unavailable');
    assert.match(res.json.error, /粤语/);
    assert.match(res.json.error, /改发文字/);
    const engines = fake.calls.map(engineOf);
    assert.deepEqual(engines, ['edge'], '粤语没有离线音色，不许回落 SAPI（更不许念成普通话）');
  } finally {
    fake.restore();
    await s.stop();
  }
});

await check('成功：说「粤语」时用的就是粤语音色（不会被换成普通话）', async () => {
  const fake = installFakeSpawn();
  const s = await startHarness(baseConfig({ tts: { engine: 'edge' } }), []);
  try {
    const res = await s.speak({ key: KEY, text: '你好呀', voice: 'cantonese' }, s.token(KEY));
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.engine, 'edge');
    assert.equal(res.json.voice, 'zh-HK-HiuMaanNeural');
    const edgeCall = fake.calls.find((call) => engineOf(call) === 'edge');
    assert.equal(edgeCall.job.voice, 'zh-HK-HiuMaanNeural');
  } finally {
    fake.restore();
    await s.stop();
  }
});

// ── 5.5 edge 只能走库 API（这台机器上模块 CLI 入口会炸） ────────────────────────
await check('静态：edge 不再走模块 CLI 入口，改成「-c 脚本 + TTS_JOB」', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'tts-core.js'), 'utf8');
  // 本机 edge-tts 的 CLI 会抛 UnboundLocalError: audio_file，库 API 才正常。
  assert.equal(/['"]-m['"]\s*,\s*['"]edge_tts['"]/.test(src), false, '不许再拼模块的命令行入口');
  assert.equal(src.includes('--write-media'), false, '--write-media 是 CLI 的写法');
  assert.match(src, /TTS_JOB/);
  assert.match(src, /edge_tts\.Communicate/);
});

await check('集成：edge 传 -c 脚本 + TTS_JOB，job 参数齐全，用完即删', async () => {
  const fake = installFakeSpawn();
  const outFile = path.join(TTS_DIR, 'tts-job-probe.mp3');
  try {
    const res = await synthesizeEdge('这句话要走库 API', {
      outFile,
      pythonPath: FAKE_PYTHON,
      voice: 'zh-CN-XiaoxiaoNeural',
      rate: 25
    });
    assert.equal(res.engine, 'edge');
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.args.length, 2, '只该有 -c 和一个脚本参数，正文不能进命令行');
    assert.equal(call.args[0], '-c');
    assert.match(String(call.args[1]), /edge_tts\.Communicate/);
    assert.equal(call.args.join(' ').includes('这句话要走库 API'), false, '正文不许出现在 argv 里');
    assert.ok(call.env.TTS_JOB, '必须用 TTS_JOB 把 job 路径传进去');
    assert.deepEqual(
      { text: call.job?.text, voice: call.job?.voice, rate: call.job?.rate, pitch: call.job?.pitch, volume: call.job?.volume, out: call.job?.out },
      { text: '这句话要走库 API', voice: 'zh-CN-XiaoxiaoNeural', rate: 25, pitch: 0, volume: 0, out: outFile }
    );
    assert.equal(fs.existsSync(call.env.TTS_JOB), false, 'job JSON 用完必须删掉');
    assert.equal(fs.existsSync(outFile), true);
  } finally {
    fake.restore();
    fs.rmSync(outFile, { force: true });
  }
});

// ── 5.2 语气档位（T-034）：tone 落成 rate/pitch/volume ──────────────────────
await check('静态：edge job 带 pitch/volume，0 时不传给引擎（"%+dHz" / "%+d%%"）', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'tts-core.js'), 'utf8');
  assert.match(src, /if pitch:/);
  assert.match(src, /kwargs\["pitch"\] = "%\+dHz" % pitch/);
  assert.match(src, /if volume:/);
  assert.match(src, /kwargs\["volume"\] = "%\+d%%" % volume/);
});

await check('闸门：认不出的语气 → 400 bad_tone，并列出五档（不静默换成平淡）', async () => {
  const fake = installFakeSpawn();
  const s = await startHarness(baseConfig(), []);
  try {
    const res = await s.speak({ key: KEY, text: '你好', tone: '笑嘻嘻' }, s.token(KEY));
    assert.equal(res.status, 400, res.raw);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.reason, 'bad_tone');
    for (const label of ['平淡', '高兴', '温和', '冷淡', '认真']) {
      assert.match(res.json.error, new RegExp(label), res.json.error);
    }
    assert.equal(fake.calls.length, 0, '语气不对时不应该合成（更不许悄悄换成平淡）');
  } finally {
    fake.restore();
    await s.stop();
  }
});

await check('成功：tone=高兴 → 语速 +8% / 音高 +6Hz / 音量 +3%，响应回报实际生效值', async () => {
  const fake = installFakeSpawn();
  const s = await startHarness(baseConfig({ tts: { engine: 'edge' } }), []);
  try {
    const res = await s.speak({ key: KEY, text: '今天真开心！', tone: '高兴' }, s.token(KEY));
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.tone, 'happy');
    assert.equal(res.json.toneApplied, true);
    assert.equal(res.json.rate, 8);
    assert.equal(res.json.pitch, 6);
    assert.equal(res.json.volume, 3);
    const edgeCall = fake.calls.find((call) => engineOf(call) === 'edge');
    assert.deepEqual(
      { rate: edgeCall.job?.rate, pitch: edgeCall.job?.pitch, volume: edgeCall.job?.volume },
      { rate: 8, pitch: 6, volume: 3 }
    );
  } finally {
    fake.restore();
    await s.stop();
  }
});

await check('成功：显式 pitch 压过 tone（优先级 显式参数 > tone > 配置）', async () => {
  const fake = installFakeSpawn();
  const s = await startHarness(baseConfig({ tts: { engine: 'edge' } }), []);
  try {
    const res = await s.speak({ key: KEY, text: '今天真开心！', tone: 'happy', pitch: -10 }, s.token(KEY));
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.tone, 'happy');
    assert.equal(res.json.pitch, -10, '显式参数应当压过 tone 的 +6Hz');
    assert.equal(res.json.rate, 8, '没显式给的 rate 仍然吃 tone 的值');
    assert.equal(res.json.volume, 3);
    const edgeCall = fake.calls.find((call) => engineOf(call) === 'edge');
    assert.equal(edgeCall.job?.pitch, -10);
  } finally {
    fake.restore();
    await s.stop();
  }
});

await check('成功：tone 优先级——配置 tone=neutral 时基础值生效，显式「平淡」压过基础值', async () => {
  const fake = installFakeSpawn();
  const s = await startHarness(baseConfig({ tts: { engine: 'edge', rate: 5, pitch: 2 } }), []);
  try {
    // 没传 tone：用配置里的 neutral 当「没有语气」，配置的基础语速/音高照常生效。
    const plain = await s.speak({ key: KEY, text: '就这样吧' }, s.token(KEY));
    assert.equal(plain.status, 200, plain.raw);
    assert.equal(plain.json.tone, 'neutral');
    assert.equal(plain.json.rate, 5);
    assert.equal(plain.json.pitch, 2);
    assert.equal(plain.json.volume, 0);
    // 显式要「平淡」= 明确要求不调整，tone 值（0）优先于配置的基础值。
    const flat = await s.speak({ key: KEY, text: '就这样吧', tone: '平淡' }, s.token(KEY));
    assert.equal(flat.status, 200, flat.raw);
    assert.equal(flat.json.tone, 'neutral');
    assert.equal(flat.json.toneApplied, true);
    assert.equal(flat.json.rate, 0);
    assert.equal(flat.json.pitch, 0);
    assert.equal(flat.json.volume, 0);
  } finally {
    fake.restore();
    await s.stop();
  }
});

await check('兜底 SAPI：tone 只能落成语速，toneApplied=false（不假装语气生效）', async () => {
  const fake = installFakeSpawn();
  const s = await startHarness(baseConfig({ tts: { engine: 'sapi' } }), []);
  try {
    const res = await s.speak({ key: KEY, text: '今天真开心！', tone: '高兴', pitch: 20 }, s.token(KEY));
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.engine, 'sapi');
    assert.equal(res.json.tone, 'happy');
    assert.equal(res.json.toneApplied, false, 'SAPI 做不出音高/音量，必须如实回报');
    assert.equal(res.json.pitch, 0);
    assert.equal(res.json.volume, 0);
    assert.equal(res.json.rate, 10, '+8% 落到 SAPI 的 1 档（10%）');
    const sapiCall = fake.calls.find((call) => engineOf(call) === 'sapi');
    const script = sapiScript(sapiCall);
    assert.match(script, /\$synth\.Rate = 1/);
    assert.equal(/Pitch|Volume/.test(script), false, 'SAPI 脚本里不该出现音高/音量控制');
  } finally {
    fake.restore();
    await s.stop();
  }
});

await check('失败：合成超时会 kill 子进程 → 503 tts_timeout', async () => {
  const silent = installFakeSpawn({ silent: true });
  const outFile = path.join(TTS_DIR, 'tts-timeout-probe.wav');
  try {
    await assert.rejects(
      async () => synthesizeEdge('超时测试', {
        outFile,
        pythonPath: FAKE_PYTHON,
        timeoutMs: 200,
        voice: 'zh-CN-XiaoxiaoNeural'
      }),
      (error) => error instanceof TtsError && error.code === 'timeout' && /没合成完/.test(error.message)
    );
    assert.equal(silent.calls[0].killed, true, '超时必须 kill 掉子进程，别留僵尸');
    assert.equal(fs.existsSync(`${outFile}.txt`), false, 'SAPI 的临时文本要清掉');
  } finally {
    silent.restore();
  }
});

await check('失败：SAPI 没产出音频 → tts_failed（不许把空文件当成功）', async () => {
  const fake = installFakeSpawn();
  try {
    const outFile = path.join(TTS_DIR, 'tts-no-output.wav');
    // 假 spawn 只在能解析出 outFile 时才写文件：这里传一个不存在的父目录已被 mkdir，
    // 所以直接让 argv 里没有 --write-media / EncodedCommand 的写法不可行 ——
    // 改用「让 spawn 成功但文件被删」来模拟：
    const previous = __setSpawnForTest((command, args) => {
      const handlers = new Map();
      const add = (key, fn) => { const list = handlers.get(key) ?? []; list.push(fn); handlers.set(key, list); };
      const child = {
        on(event, fn) { add(event, fn); return child; },
        kill() {},
        stderr: { on(event, fn) { add(`stderr:${event}`, fn); return child; } }
      };
      setImmediate(() => {
        // 故意写 0 字节：requireOutput 必须拒绝
        try { fs.mkdirSync(path.dirname(extractOutFile(command, args) ?? '.'), { recursive: true }); } catch {}
        try { fs.writeFileSync(extractOutFile(command, args) ?? path.join(TTS_DIR, 'x'), ''); } catch {}
        for (const fn of handlers.get('close') ?? []) fn(0);
      });
      return child;
    });
    try {
      await assert.rejects(
        async () => synthesizeSapi('空文件测试', { outFile, timeoutMs: 3000 }),
        (error) => error instanceof TtsError && error.code === 'tts_failed' && /没有产出音频文件/.test(error.message)
      );
    } finally {
      __setSpawnForTest(previous);
    }
  } finally {
    fake.restore();
    try { fs.rmSync(path.join(TTS_DIR, 'tts-no-output.wav'), { force: true }); } catch {}
  }
});

// ── 6. 成功路径 ─────────────────────────────────────────────────────────────
await check('成功：合成 → 发送 → 临时文件删干净（audio 传 null，不带音量处理）', async () => {
  const audioCalls = [];
  const fake = installFakeSpawn();
  const s = await startHarness(baseConfig({ tts: { engine: 'sapi' } }), audioCalls);
  try {
    const before = leftoverFiles(harnessTtsDir(s)).length;
    const res = await s.speak({ key: KEY, text: '你好呀，今天过得怎么样' }, s.token(KEY));
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.engine, 'sapi');
    assert.equal(res.json.verified, true, 'get_msg 回读到 record 段才算真发了');
    assert.equal(res.json.messageId, 9001);

    // 发出去的 record 段指向 audio/.tts/ 里的临时文件（相对路径由 speakV2 拼、桥接再解析成绝对）。
    const sends = s.h.calls.http.filter((call) => call.url.endsWith('/send_group_msg'));
    assert.equal(sends.length >= 1, true, '应当至少发出一次 send_group_msg');
    const segment = sends.at(-1).body.message?.[0];
    assert.equal(segment.type, 'record');
    const sentFile = String(segment.data.file);
    assert.match(path.basename(sentFile), /^tts-.*\.wav$/);
    assert.equal(path.dirname(sentFile), harnessTtsDir(s), '临时音频必须待在 <语音库>/.tts 里');
    assert.equal(/converted|-vol\./i.test(path.basename(sentFile)), false, '不许出现音量处理产物');

    // audio 传的是 null：processAudioVolume 收到默认音量、normalize=false。
    assert.equal(audioCalls.length >= 1, true);
    const lastAudio = audioCalls.at(-1);
    assert.equal(lastAudio.opts.normalize, false);
    assert.equal(lastAudio.opts.volume, 1);

    // finally 里删文件：.wav 与 SAPI 的 .txt 都不许留下。
    assert.deepEqual(leftoverFiles(harnessTtsDir(s)), [], '发完必须删掉临时音频');
    assert.equal(leftoverFiles(harnessTtsDir(s)).length, before, '数量回到发之前');
    assert.equal(fs.existsSync(sentFile), false);
  } finally {
    fake.restore();
    await s.stop();
  }
});

await check('成功：同一会话上一句还没合成完时直接拒绝（busy），不排队堆活', async () => {
  const audioCalls = [];
  const calls = [];
  const gate = { release: null };
  const previous = __setSpawnForTest((command, args) => {
    calls.push({ command, args: [...args] });
    const handlers = new Map();
    const add = (key, fn) => { const list = handlers.get(key) ?? []; list.push(fn); handlers.set(key, list); };
    const child = {
      on(event, fn) { add(event, fn); return child; },
      kill() {},
      stderr: { on(event, fn) { add(`stderr:${event}`, fn); return child; } }
    };
    const outFile = extractOutFile(command, args);
    gate.release = () => {
      if (outFile) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, silentWav(1));
      }
      for (const fn of handlers.get('close') ?? []) fn(0);
    };
    return child;
  });
  const s = await startHarness(baseConfig({ tts: { engine: 'sapi' } }), audioCalls);
  try {
    const first = s.speak({ key: KEY, text: '第一句慢慢来' }, s.token(KEY));
    // 等合成真的开始（gate.release 被赋值）再发第二条
    for (let i = 0; i < 200 && !gate.release; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(typeof gate.release, 'function', '假 spawn 应当已被调用');
    const second = await s.speak({ key: KEY, text: '第二句插队' }, s.token(KEY));
    assert.equal(second.status, 400, second.raw);
    assert.equal(second.json.reason, 'busy');
    gate.release();
    const done = await first;
    assert.equal(done.status, 200, done.raw);
    assert.equal(done.json.ok, true);
    assert.deepEqual(leftoverFiles(harnessTtsDir(s)), []);
  } finally {
    __setSpawnForTest(previous);
    await s.stop();
  }
});

// ── 7. 真实冒烟：语音库列表看不到 .tts ───────────────────────────────────────
await check('冒烟：node scripts/send-voice.mjs list-voice 跳过 .tts 目录', async () => {
  if (!fs.existsSync(AUDIO_DIR)) {
    console.log('     SKIP：audio/ 目录不存在');
    return;
  }
  const probe = path.join(TTS_DIR, 'tts-smoke-should-be-hidden.wav');
  fs.mkdirSync(TTS_DIR, { recursive: true });
  fs.writeFileSync(probe, silentWav(1));
  try {
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'send-voice.mjs'), 'list-voice', '--no-probe'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' }
    });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    assert.equal(run.status, 0, output);
    assert.equal(output.includes('.tts'), false, '语音库列表不能把 .tts 里的临时文件列出来');
    assert.equal(output.includes('tts-smoke-should-be-hidden'), false);
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

// ── 收尾 ────────────────────────────────────────────────────────────────────
try {
  fs.rmSync(TTS_DIR, { recursive: true, force: true });
} catch { /* 目录被别的东西占着就算了 */ }

const total = passed + failures.length;
console.log('');
if (failures.length === 0) {
  console.log(`TTS suite: ${passed}/${total} checks passed.`);
} else {
  console.log(`TTS suite: ${passed}/${total} checks passed, ${failures.length} failed:`);
  for (const failure of failures) console.log(`  - ${failure.name}`);
  process.exitCode = 1;
}
