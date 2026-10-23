// T-032：AI 侧 TTS（文本 → 语音条）的合成内核。
//
// 这个模块只做两件事：把模型吐出的一句话整理成「能朗读的句子」，再把句子交给
// 一个本地引擎合成成音频文件。它**不**知道 QQ、不知道额度、不碰 bridge 状态 ——
// 额度与发送在 bridge.js 的 speakV2() 里，这样合成失败/超时不会把发送链路带脏。
//
// 两个引擎（实测结论见 work/agent-tasks/T-032/dev-doc.md §2）：
//   · edge-tts：Python 包（`python -m edge_tts`），音质最好、无需 key；走微软的
//     非官方端点，会被降速，所以必须带超时、失败要能回落。
//   · SAPI：Windows 自带 `System.Speech`，离线、不限额、音色只有一个；用 PowerShell
//     跑，811ms 量级，适合兜底。
//   npm 的 msedge-tts 实测恒定 429，**不要**改回 WebSocket 合成。
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

/** 带机器可读 code 的 TTS 错误：路由据此挑 HTTP 状态码与 reason。 */
export class TtsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// 配置缺省值：bridge 的 socialV2.tts 与 resolveTtsSettings 都吃这一份，别在两处写数字。
export const TTS_DEFAULTS = Object.freeze({
  engine: 'auto',
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: 0,
  maxChars: 80,
  timeoutMs: 15000,
  pythonPath: '',
  dir: ''
});

// 夹取区间：字数上限 10–120（低于 10 没法说一句话，高于 120 一条语音会变成长语音）；
// 超时 3–30 秒（edge-tts 冷启动实测 2.8 秒，超过 30 秒说明链路已经坏了，再等没意义）。
export const TTS_LIMITS = Object.freeze({
  maxChars: Object.freeze({ min: 10, max: 120 }),
  timeoutMs: Object.freeze({ min: 3000, max: 30000 }),
  rate: Object.freeze({ min: -50, max: 50 })
});

const ENGINES = Object.freeze(['edge', 'sapi', 'auto']);
export const TTS_ENGINES = ENGINES;

// 只开两支女声（用户硬要求）：普通话·晓晓 与 粤语·曉曼。
// 顺序即展示顺序；`lang` 决定「能不能用 SAPI 兜底」——本机 SAPI 只有 zh-CN 女声，
// 粤语没有离线音色，所以粤语只能走 edge-tts，合成不了就是合成不了。
// **不许往这张表里加任何 Male 音色**（Yunxi / Yunyang / Yunjian / Yunxia / WanLung …）。
export const TTS_VOICES = Object.freeze([
  Object.freeze({ id: 'zh-CN-XiaoxiaoNeural', label: '普通话·晓晓', lang: 'mandarin' }),
  Object.freeze({ id: 'zh-HK-HiuMaanNeural', label: '粤语·曉曼', lang: 'cantonese' })
]);

export const TTS_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

// 模型嘴上说的「普通话 / 粤语」映射到具体音色；不在这里的一律算 bad_voice。
const VOICE_ALIASES = new Map([
  ['zh-cn-xiaoxiaoneural', 'zh-CN-XiaoxiaoNeural'],
  ['mandarin', 'zh-CN-XiaoxiaoNeural'],
  ['普通话', 'zh-CN-XiaoxiaoNeural'],
  ['zh-hk-hiumaanneural', 'zh-HK-HiuMaanNeural'],
  ['cantonese', 'zh-HK-HiuMaanNeural'],
  ['粤语', 'zh-HK-HiuMaanNeural'],
  ['广东话', 'zh-HK-HiuMaanNeural']
]);

/** 「普通话·晓晓 / 粤语·曉曼」——错误文案与 prompt 共用同一句人话。 */
export function ttsVoiceLabels() {
  return TTS_VOICES.map((voice) => voice.label).join(' / ');
}

/**
 * 把模型/配置给的 voice 解析成白名单里的一项。
 * 认不出来返回 null（由调用方决定是回落配置还是报 bad_voice）——
 * **绝不**悄悄换成普通话：粤语请求被当成普通话念，比直接拒绝更像 bug。
 */
export function resolveTtsVoice(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const id = VOICE_ALIASES.get(raw.toLowerCase());
  if (!id) return null;
  return TTS_VOICES.find((voice) => voice.id === id) ?? null;
}

// 允许测试替换子进程实现（§4.5 要求「注入假 spawn」）：默认就是 node 的 spawn，
// 只有测试会调用 __setSpawnForTest，生产路径永远拿默认值。
let spawnImpl = nodeSpawn;

/**
 * 替换子进程实现（测试用）。传 null 恢复默认。
 * 返回被替换的旧实现，方便 finally 里恢复。
 */
export function __setSpawnForTest(fn) {
  const previous = spawnImpl;
  spawnImpl = typeof fn === 'function' ? fn : nodeSpawn;
  return previous;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 归一化 `socialV2.tts`（缺字段补缺省、越界夹取、认不出的 engine 回落 auto）。
 * 永不抛：坏的配置最多退回缺省值。
 */
export function resolveTtsSettings(source) {
  const src = source && typeof source === 'object' ? source : {};
  const engineRaw = String(src.engine ?? '').trim().toLowerCase();
  const wantedVoice = String(src.voice ?? '').trim();
  const picked = resolveTtsVoice(wantedVoice);
  const warnings = [];
  if (wantedVoice && !picked) {
    // 坏的音色**不静默接受**：回落默认，但把这件事说出来（bridge 会记一条 warn 日志）。
    warnings.push(`socialV2.tts.voice「${wantedVoice}」不在白名单里（只支持 ${ttsVoiceLabels()}），已回落 ${TTS_DEFAULT_VOICE}`);
  }
  return {
    engine: ENGINES.includes(engineRaw) ? engineRaw : TTS_DEFAULTS.engine,
    voice: picked ? picked.id : TTS_DEFAULT_VOICE,
    lang: picked ? picked.lang : 'mandarin',
    // 白名单是代码里的常量（TTS_VOICES）；config 里那份只是给人看的镜像，不参与判定。
    voices: TTS_VOICES,
    voicesText: ttsVoiceLabels(),
    warnings,
    rate: clampInt(src.rate, TTS_LIMITS.rate.min, TTS_LIMITS.rate.max, TTS_DEFAULTS.rate),
    maxChars: clampInt(src.maxChars, TTS_LIMITS.maxChars.min, TTS_LIMITS.maxChars.max, TTS_DEFAULTS.maxChars),
    timeoutMs: clampInt(src.timeoutMs, TTS_LIMITS.timeoutMs.min, TTS_LIMITS.timeoutMs.max, TTS_DEFAULTS.timeoutMs),
    pythonPath: String(src.pythonPath ?? '').trim(),
    dir: String(src.dir ?? '').trim()
  };
}

// ── 清洗 ────────────────────────────────────────────────────────────────────
// 占位符：bridge 在消息里塞的 [图片]/[表情]/… —— 念出来毫无意义，先删。
const PLACEHOLDER_RE = /\[(?:图片|表情|语音|视频|文件|转发消息)[^\]]{0,60}\]/g;
// emoji / 变体选择符 / 零宽连接符 / 肤色 / 旗帜：edge-tts 会把它们念成「笑脸」之类。
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]/gu;
// @昵称：QQ 的 @ 在文本里是「@名字 」，念出来像点名，删掉；不删 @ 后面的正常句子。
const AT_RE = /@[^\s，。！？；：、,.!?;:()（）【】《》"'“”‘’]{1,24}/g;
// URL：模型偶尔会念链接，语音里没人能点。
const URL_RE = /(?:https?:\/\/|www\.)[^\s，。！？；、）)】》]+/gi;

/**
 * 清洗一句「要念出来的话」。
 *
 * 返回清洗后的字符串；洗不出人话（只剩标点/空白）抛 TtsError('empty')，
 * 超过 maxChars **抛错而不是静默截断**（截断会让句子断在半句上，还会白耗一次合成）。
 */
export function sanitizeSpeakText(raw, { maxChars = 80 } = {}) {
  const limit = clampInt(maxChars, TTS_LIMITS.maxChars.min, TTS_LIMITS.maxChars.max, TTS_DEFAULTS.maxChars);
  let text = String(raw ?? '');
  text = text.replace(PLACEHOLDER_RE, ' ');
  text = text.replace(URL_RE, ' ');
  text = text.replace(AT_RE, ' ');
  text = text.replace(EMOJI_RE, '');
  // 省略号/破折号换成正经标点，否则 TTS 会念「点点点」。
  text = text.replace(/…/g, '。').replace(/[—－]{2,}/g, '，').replace(/[·・]{3,}/g, '。');
  // 空白折叠：换行当空格（一句话合成，不分段）。
  text = text.replace(/\s+/g, ' ').trim();
  // 连续标点归一（「！！！」→「！」，「，，」→「，」）。
  text = text.replace(/([，。！？；：、])\1+/g, '$1');
  // 开头的标点没有语义，删掉（「。你好」→「你好」）。
  text = text.replace(/^[，。！？；：、]+/, '').trim();

  if (!/[\p{L}\p{N}]/u.test(text)) {
    throw new TtsError('empty', '这句话里没有可以朗读的文字（只有表情/标点），换成一句正常的话再发');
  }
  const chars = [...text].length;
  if (chars > limit) {
    const suggestion = splitBySentences(text, limit)[0] ?? '';
    throw new TtsError(
      'too_long',
      `这句清洗后 ${chars} 字，超过上限 ${limit} 字：压到 ${limit} 字以内再发（或者分两条发）` +
        (suggestion ? `；比如只说「${suggestion}」` : ''),
      { chars, maxChars: limit, suggestion }
    );
  }
  return text;
}

/**
 * 按句切成每段 ≤ maxChars 的句子（贪心装箱）。
 *
 * 先按 。！？；… 与换行切，再把短句装进同一段；单句超长时按逗号退一步切，
 * 还是超长才按字数硬切 —— 保证「不切在句号中间」。
 */
export function splitBySentences(text, maxChars = 80) {
  const limit = clampInt(maxChars, 4, 1000, TTS_DEFAULTS.maxChars);
  const src = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!src) return [];
  const out = [];
  let buf = '';
  const push = (piece) => {
    const len = [...piece].length;
    if (len > limit) {
      // 先按逗号/顿号退一步切（念起来还算一句），都不行才按字数硬切。
      const clauses = piece.split(/(?<=[，、：,:])/u).map((s) => s.trim()).filter(Boolean);
      if (clauses.length > 1) {
        clauses.forEach(push);
        return;
      }
      const chars = [...piece];
      for (let i = 0; i < chars.length; i += limit) {
        const chunk = chars.slice(i, i + limit).join('').trim();
        if (chunk) out.push(chunk);
      }
      return;
    }
    if (!buf) { buf = piece; return; }
    if ([...buf].length + len <= limit) { buf += piece; return; }
    out.push(buf);
    buf = piece;
  };
  for (const line of src.split(/\n+/)) {
    const sentences = line.match(/[^。！？；…!?;]+[。！？；…!?;]*/g) ?? [];
    for (const sentence of sentences) {
      const piece = sentence.trim();
      if (piece) push(piece);
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ── 子进程封装 ──────────────────────────────────────────────────────────────
const STDERR_NOISE_RE = /(ssl|certificate|SSLCertVerificationError)/i;

function cleanStderr(stderr) {
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !STDERR_NOISE_RE.test(line));
  return lines.slice(-3).join(' / ').slice(0, 300);
}

/**
 * 跑一个子进程，带超时与 kill。
 * 只管「跑完没跑完」：成功 resolve，超时 TtsError('timeout')，非零退出 TtsError('tts_failed')。
 */
async function runChildImpl(command, args, { timeoutMs = TTS_DEFAULTS.timeoutMs, what = 'tts', env = null } = {}) {
  await new Promise((resolve, reject) => {
    let child;
    try {
      // stdio 必须显式给管道：受限沙箱下继承父进程的管道会 EPERM，我们只要 stderr 一小段。
      const options = { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] };
      if (env) options.env = env;
      child = spawnImpl(command, args, options);
    } catch (error) {
      reject(new TtsError('tts_unavailable', `${what} 起不来：${error?.message ?? error}`));
      return;
    }
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new TtsError('timeout', `${what} 超过 ${Math.round(timeoutMs / 1000)} 秒还没合成完`, { timeoutMs }));
    }, Math.max(200, Number(timeoutMs) || TTS_DEFAULTS.timeoutMs));
    child?.stderr?.on?.('data', (chunk) => { stderr += String(chunk); });
    child?.on?.('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new TtsError('tts_unavailable', `${what} 起不来：${error?.message ?? error}`));
    });
    child?.on?.('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) { resolve(); return; }
      const detail = cleanStderr(stderr);
      reject(new TtsError('tts_failed', `${what} 退出码 ${code}${detail ? `：${detail}` : ''}`));
    });
  });
}

function requireOutput(outFile, engine) {
  let stat = null;
  try { stat = fs.statSync(outFile); } catch {}
  if (!stat?.isFile() || stat.size === 0) {
    throw new TtsError('tts_failed', `${engine} 没有产出音频文件（${path.basename(outFile)}）`);
  }
  return stat.size;
}

/**
 * edge-tts 的库调用脚本（纯 ASCII：`-c` 的内容不能被平台编码打碎）。
 *
 * 为什么不用模块的命令行入口：这台机器上的 edge-tts 7.3.1 跑 CLI 会直接抛
 * `UnboundLocalError: cannot access local variable 'audio_file'`，
 * 库 API（`Communicate(...).save()`）却完全正常。所以参数走 job JSON + 环境变量，
 * 正文永远不落到命令行上（顺带免疫引号/换行/中文编码问题）。
 */
const EDGE_TTS_SCRIPT = [
  'import asyncio, json, os',
  'import edge_tts',
  'job = json.load(open(os.environ["TTS_JOB"], encoding="utf-8"))',
  'kwargs = {}',
  'rate = int(job.get("rate") or 0)',
  'if rate:',
  '    kwargs["rate"] = "%+d%%" % rate',
  'comm = edge_tts.Communicate(job["text"], job["voice"], **kwargs)',
  'asyncio.run(comm.save(job["out"]))'
].join('\n');

/**
 * edge-tts 合成（主路）。
 * `rate` 是相对百分比（0 = 原速），只在非 0 时写进 job，避免传 `+0%`。
 */
export async function synthesizeEdge(text, {
  voice = TTS_DEFAULTS.voice,
  rate = 0,
  outFile,
  pythonPath,
  timeoutMs = TTS_DEFAULTS.timeoutMs
} = {}) {
  const say = String(text ?? '').trim();
  if (!say) throw new TtsError('empty', '没有内容可合成');
  if (!outFile) throw new TtsError('bad_args', 'synthesizeEdge 需要 outFile');
  if (!pythonPath) throw new TtsError('tts_unavailable', '没有可用的 Python（edge-tts）');
  const outDir = path.dirname(outFile);
  fs.mkdirSync(outDir, { recursive: true });
  const rateNum = Math.round(Number(rate) || 0);
  const jobFile = path.join(
    outDir,
    `tts-job-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  );
  fs.writeFileSync(jobFile, JSON.stringify({
    text: say,
    voice: String(voice || TTS_DEFAULTS.voice),
    rate: rateNum,
    out: outFile
  }), 'utf8');
  try {
    await runChildImpl(pythonPath, ['-c', EDGE_TTS_SCRIPT], {
      timeoutMs,
      what: 'edge-tts',
      env: { ...process.env, TTS_JOB: jobFile }
    });
  } catch (error) {
    // 命令行入口/证书/网络任何一处炸，对调用方都是「这会儿用不了在线合成」。
    // 消息原样保留（退出码 + stderr 末几行），engine:'auto' 的普通话回落照旧生效。
    if (error instanceof TtsError && error.code === 'tts_failed') {
      throw new TtsError('tts_unavailable', error.message, error.extra);
    }
    throw error;
  } finally {
    try { fs.rmSync(jobFile, { force: true }); } catch {}
  }
  const bytes = requireOutput(outFile, 'edge-tts');
  return { engine: 'edge', file: outFile, bytes };
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function encodeCommand(script) {
  // -EncodedCommand 收 base64(UTF-16LE)：中文与引号都不会被 cmd/pwsh 的解析器打碎。
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * SAPI 合成（兜底）。
 *
 * 文本**不进命令行**：先写一个 UTF-8 的 .txt，脚本里用 [IO.File]::ReadAllText 读，
 * 这样引号、`$`、`;`、换行都不可能变成注入点。
 */
export async function synthesizeSapi(text, {
  outFile,
  voice = 'Microsoft Huihui Desktop',
  timeoutMs = TTS_DEFAULTS.timeoutMs
} = {}) {
  const say = String(text ?? '').trim();
  if (!say) throw new TtsError('empty', '没有内容可合成');
  if (!outFile) throw new TtsError('bad_args', 'synthesizeSapi 需要 outFile');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const textFile = `${outFile}.txt`;
  fs.writeFileSync(textFile, say, 'utf8');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Speech',
    `$text = [System.IO.File]::ReadAllText(${psQuote(textFile)}, [System.Text.Encoding]::UTF8)`,
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `try { $synth.SelectVoice(${psQuote(voice)}) } catch { }`,
    `$synth.SetOutputToWaveFile(${psQuote(outFile)})`,
    '$synth.Speak($text)',
    '$synth.Dispose()'
  ].join('\n');
  try {
    await runChildImpl('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)], {
      timeoutMs,
      what: 'SAPI'
    });
    const bytes = requireOutput(outFile, 'SAPI');
    return { engine: 'sapi', file: outFile, bytes };
  } finally {
    try { fs.rmSync(textFile, { force: true }); } catch {}
  }
}
