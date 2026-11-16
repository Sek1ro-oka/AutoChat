// ASR（让机器人「听得见」语音消息）的共享内核。
//
// 设计边界（为什么长这样）：
//   • 纯逻辑优先。路径解析 / 配置归一 / 格式嗅探 / 缓存 全在这里，只依赖 Node 内置模块，
//     可以离线单测（scripts/test-asr-core.mjs）。真正干活的两个外部依赖（ffmpeg 转码、
//     python 转写）都包成 **永不抛** 的 { ok:false, reason } 结果。
//   • **永不抛是硬要求**：调用点是 QQ 消息主循环的 segmentsToText。ASR 挂掉只能降级成
//     `[语音]`，绝不能让一条语音把整条消息、乃至整个收消息循环带走。
//   • 三重上限做在**这一层**而不是调用方：单条语音的 maxBytes（下载/落盘）、maxSeconds
//     （解码时长）、timeoutMs（子进程）。上层只传配置，不需要自己再判一遍。
//   • 模型只认**本地目录**：聊天主循环里绝不允许触发几百 MB 的 HF 下载（那会把一次
//     回消息变成几分钟）。本地没有就返回 ok:false，让用户先装好。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

/** 本机 ASR 的默认安装位置（E 盘：C 盘只剩个位数 GB，模型 460MB 起）。 */
export const DEFAULT_ASR_HOME = 'E:\\tools\\asr';

/**
 * 出厂默认值。
 *
 * enabled 默认 **false**：模型要几百 MB、CPU 转写一条要数秒，没装好就打开只会得到一串
 * 失败日志。config.json 里显式写 "enabled": true 才算真的开（见 socialV2.asr）。
 */
export const ASR_DEFAULTS = Object.freeze({
  enabled: false,
  model: 'small',
  modelsDir: '',
  pythonPath: '',
  scriptPath: '',
  ffmpegPath: '',
  language: 'zh',
  maxSeconds: 60,
  maxBytes: 10 * 1024 * 1024,
  timeoutMs: 60000,
  beamSize: 5,
  // 允许网关在把语音交给我们之前先转码（OneBot get_record 的 out_format）。
  // QQ 的 silk 格式 ffmpeg 解不了，而网关自己有编码器 —— 这是 silk 的唯一可靠出口。
  preferGatewayTranscode: true,
  gatewayOutFormat: 'mp3'
});

/** 上限的硬边界：config.json 是用户可编辑的，脏值不能让这里的闸门失效。 */
const ASR_LIMITS = Object.freeze({
  maxSeconds: { min: 1, max: 600 },
  maxBytes: { min: 64 * 1024, max: 200 * 1024 * 1024 },
  timeoutMs: { min: 1000, max: 600000 },
  beamSize: { min: 1, max: 10 }
});

function clampInt(value, { min, max }, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanString(value, max = 260) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, '').trim().slice(0, max);
}

/**
 * 归一 ASR 配置。**永不抛**，缺字段补默认、越界钳制、脏值丢弃。
 *
 * 和 src/bridge.js 里 tts / images 的归一思路一致：config.json 是人手写的，
 * `"maxBytes": "10MB"`、`"maxSeconds": -1` 这类值必须在这里收敛，否则下面每一处
 * 判断都会被 NaN / 负数静默绕过（那样「三重上限」就成了装饰）。
 */
export function normalizeAsrConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const language = cleanString(src.language ?? ASR_DEFAULTS.language, 16);
  return {
    enabled: src.enabled === true,
    model: cleanString(src.model ?? ASR_DEFAULTS.model, 120) || ASR_DEFAULTS.model,
    modelsDir: cleanString(src.modelsDir ?? src.modelDir ?? ASR_DEFAULTS.modelsDir),
    pythonPath: cleanString(src.pythonPath ?? ASR_DEFAULTS.pythonPath),
    scriptPath: cleanString(src.scriptPath ?? ASR_DEFAULTS.scriptPath),
    ffmpegPath: cleanString(src.ffmpegPath ?? ASR_DEFAULTS.ffmpegPath),
    // 空串 = 让 whisper 自动检测语言（少数派场景用得上），'zh' 是默认。
    language: language === 'auto' ? '' : language,
    maxSeconds: clampInt(src.maxSeconds, ASR_LIMITS.maxSeconds, ASR_DEFAULTS.maxSeconds),
    maxBytes: clampInt(src.maxBytes, ASR_LIMITS.maxBytes, ASR_DEFAULTS.maxBytes),
    timeoutMs: clampInt(src.timeoutMs, ASR_LIMITS.timeoutMs, ASR_DEFAULTS.timeoutMs),
    beamSize: clampInt(src.beamSize, ASR_LIMITS.beamSize, ASR_DEFAULTS.beamSize),
    preferGatewayTranscode: src.preferGatewayTranscode !== false,
    gatewayOutFormat: cleanString(src.gatewayOutFormat ?? ASR_DEFAULTS.gatewayOutFormat, 12) || ASR_DEFAULTS.gatewayOutFormat
  };
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** 只写了命令名（如 `python`）而不是绝对路径时，没法 stat —— 由调用方显式承担。 */
function looksLikeBareCommand(p) {
  return Boolean(p) && !p.includes('/') && !p.includes('\\');
}

/**
 * 默认的「可能装在哪儿」清单。env 可以覆盖（ASR_HOME / ASR_PYTHON / ASR_MODELS）。
 * 之所以要给一份默认清单：装的时候就是按这个布局装的（见交付说明），
 * 让 config.json 不写一个字也能跑起来。
 */
export function defaultKnownAsrPaths(env = process.env, platform = process.platform) {
  const home = cleanString(env?.ASR_HOME) || DEFAULT_ASR_HOME;
  const venvPython = platform === 'win32'
    ? path.join(home, 'venv', 'Scripts', 'python.exe')
    : path.join(home, 'venv', 'bin', 'python3');
  return {
    home,
    pythonPath: venvPython,
    scriptPath: path.join(home, 'transcribe.py'),
    modelsDir: path.join(home, 'models')
  };
}

/**
 * 在 modelsDir 里找一个**已下载好**的模型目录（含 model.bin）。
 *
 * 两种布局都要认：
 *   ① 我们自己下的：<modelsDir>/small/model.bin
 *   ② HF hub 的缓存布局：<modelsDir>/models--Systran--faster-whisper-small/snapshots/<rev>/model.bin
 *      —— download_root / cache_dir 传进去时，faster-whisper 默认就落成这个形状。
 * 找不到返回 ''（调用方据此判「模型没装」）。
 */
export function resolveModelPath(modelsDir, model) {
  const name = cleanString(model, 120);
  const root = cleanString(modelsDir);
  if (!name) return '';
  // 配置里直接写死了一个本地目录：认它，但必须有 model.bin（空目录等于没装）。
  if (path.isAbsolute(name)) return isFile(path.join(name, 'model.bin')) ? name : '';
  if (!root || !isDir(root)) return '';
  const direct = path.join(root, name);
  if (isFile(path.join(direct, 'model.bin'))) return direct;
  for (const parent of [root, path.join(root, 'hub')]) {
    if (!isDir(parent)) continue;
    const repo = path.join(parent, `models--Systran--faster-whisper-${name}`);
    const snapshots = path.join(repo, 'snapshots');
    if (isDir(snapshots)) {
      let revs = [];
      try { revs = fs.readdirSync(snapshots); } catch { revs = []; }
      for (const rev of revs) {
        const candidate = path.join(snapshots, rev);
        if (isFile(path.join(candidate, 'model.bin'))) return candidate;
      }
    }
  }
  const short = path.join(root, `faster-whisper-${name}`);
  if (isFile(path.join(short, 'model.bin'))) return short;
  return '';
}

/**
 * 找 ASR 三件套：python、转写脚本、模型目录。
 *
 * 查找顺序：configured（config.json）→ env（ASR_PYTHON / ASR_SCRIPT / ASR_MODELS）→
 * knownPaths（默认安装位置）。**永不抛**；找不到就 ok:false 并把「缺什么」写进 reason，
 * 这样桥接只记一行日志就能定位，不需要用户去猜。
 *
 * ok 的要求：python 可执行文件存在 + 脚本存在 + 模型已下载。模型没装也算「没找到」——
 * 否则每个 turn 都会去 spawn 一个注定失败（或开始下载 460MB）的 python。
 * 想放行「让第一次调用去下载」的场景，传 allowDownload: true。
 */
export function resolveAsrBinary({ configured = {}, env = process.env, knownPaths = null, allowDownload = false } = {}) {
  const cfg = normalizeAsrConfig(configured);
  const known = knownPaths ?? defaultKnownAsrPaths(env);
  const result = {
    ok: false,
    pythonPath: '',
    pythonSource: '',
    pythonVerified: false,
    scriptPath: '',
    scriptSource: '',
    modelsDir: '',
    model: cfg.model,
    modelPath: '',
    modelReady: false,
    allowDownload: Boolean(allowDownload),
    reason: '',
    detail: ''
  };
  const notes = [];

  // ① python：显式配置优先。显式给了绝对路径但文件不存在 → 直接判失败，
  //    不要「悄悄换成默认 venv」——那会让用户以为自己的配置生效了。
  const pyCandidates = [
    ['config', cleanString(cfg.pythonPath)],
    ['env', cleanString(env?.ASR_PYTHON ?? env?.ASR_PYTHON_PATH)],
    ['known', cleanString(known.pythonPath)]
  ];
  for (const [source, candidate] of pyCandidates) {
    if (!candidate) continue;
    if (isFile(candidate)) {
      result.pythonPath = candidate;
      result.pythonSource = source;
      result.pythonVerified = true;
      break;
    }
    if (looksLikeBareCommand(candidate)) {
      // 只写了 `python`：没法 stat，但这是用户明确的意愿，交给 spawn 去分辨。
      result.pythonPath = candidate;
      result.pythonSource = source;
      result.pythonVerified = false;
      notes.push(`python 只给了命令名「${candidate}」，未做存在性校验`);
      break;
    }
    notes.push(`${source} 指定的 python 不存在：${candidate}`);
  }

  // ② 转写脚本
  const scriptCandidates = [
    ['config', cleanString(cfg.scriptPath)],
    ['env', cleanString(env?.ASR_SCRIPT)],
    ['known', cleanString(known.scriptPath)]
  ];
  for (const [source, candidate] of scriptCandidates) {
    if (!candidate) continue;
    if (isFile(candidate)) {
      result.scriptPath = candidate;
      result.scriptSource = source;
      break;
    }
    notes.push(`${source} 指定的转写脚本不存在：${candidate}`);
  }

  // ③ 模型目录
  result.modelsDir = cleanString(cfg.modelsDir)
    || cleanString(env?.ASR_MODELS)
    || cleanString(known.modelsDir);
  result.modelPath = resolveModelPath(result.modelsDir, cfg.model);
  result.modelReady = Boolean(result.modelPath);

  // ④ 结论
  if (!result.pythonPath) {
    result.reason = `没有可用的 Python${notes.length ? `（${notes.join('；')}）` : ''}`;
    return result;
  }
  if (!result.scriptPath) {
    result.reason = `没有找到 transcribe.py${notes.length ? `（${notes.join('；')}）` : ''}`;
    return result;
  }
  if (!result.modelReady && !allowDownload) {
    result.reason = `模型「${cfg.model}」还没下载（应位于 ${result.modelsDir || '(未配置 modelsDir)'}）`;
    return result;
  }
  result.ok = true;
  result.detail = [
    `python=${result.pythonPath}(${result.pythonSource}${result.pythonVerified ? '' : ',未校验'})`,
    `script=${result.scriptPath}(${result.scriptSource})`,
    `model=${result.modelPath || cfg.model}`
  ].join(' ');
  return result;
}

/**
 * 格式嗅探（纯函数，吃 Buffer 或路径）。
 *
 * 为什么需要它：QQ 收到的语音既可能是 AMR（本机实测 95/95 都是 .amr），也可能是
 * SILK。**ffmpeg 没有 silk 解码器**，这种文件必须提前判出来，否则用户只会看到一句
 * 毫无信息量的 "Invalid data found when processing input"。
 */
export function sniffAudioFormat(input) {
  let buf = input;
  if (typeof input === 'string') {
    try {
      const fd = fs.openSync(input, 'r');
      try {
        buf = Buffer.alloc(16);
        const n = fs.readSync(fd, buf, 0, 16, 0);
        buf = buf.subarray(0, n);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { format: 'unknown', ext: '', silk: false, amr: false, detail: '读不了文件头' };
    }
  }
  if (!Buffer.isBuffer(buf) || buf.length < 4) {
    return { format: 'unknown', ext: '', silk: false, amr: false, detail: '字节太少' };
  }
  // QQ/微信的 silk 有时前面多一个 0x02 长度前缀，两头都要认。
  let head = buf.subarray(0, 12).toString('latin1');
  if (buf[0] === 0x02) head = buf.subarray(1, 12).toString('latin1');
  const tag = (format, ext) => ({ format, ext, silk: format === 'silk', amr: format.startsWith('amr'), detail: '' });
  if (head.startsWith('#!SILK')) return tag('silk', '.silk');
  if (head.startsWith('#!AMR-WB')) return tag('amr-wb', '.amr');
  if (head.startsWith('#!AMR')) return tag('amr', '.amr');
  if (head.startsWith('RIFF') && buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WAVE') return tag('wav', '.wav');
  if (head.startsWith('OggS')) return tag('ogg', '.ogg');
  if (head.startsWith('fLaC')) return tag('flac', '.flac');
  if (head.startsWith('ID3')) return tag('mp3', '.mp3');
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return tag('mp3', '.mp3');
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return tag('m4a', '.m4a');
  return tag('unknown', '');
}

/**
 * 读 PCM wav 的头部信息。我们自己产出的 wav（16k/单声道/s16le）一定命中，
 * 用它算时长比再 spawn 一次 ffprobe 便宜也准。
 */
export function readWavInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt = null;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        bitsPerSample: buf.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      // 流式写出的 wav 会用 0xFFFFFFFF 占位，这时按实际剩余字节算。
      dataSize = size === 0xffffffff ? buf.length - body : Math.min(size, buf.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !fmt.byteRate) return null;
  return {
    ...fmt,
    dataSize,
    duration: dataSize / fmt.byteRate,
    pcm16kMono: fmt.sampleRate === 16000 && fmt.channels === 1 && fmt.bitsPerSample === 16
  };
}

/** 便捷版：从文件读 wav 信息（文件读不到就是 null，不抛）。 */
export function wavInfoFromFile(file) {
  try { return readWavInfo(fs.readFileSync(file)); } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跑一个子进程，带超时与 kill。返回 { code, stderr }，**永不 reject**。 */
function runChild(command, args, { timeoutMs = 60000, env = null, what = 'child' } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // stdio 显式给管道：只要 stderr 一小段做诊断，stdout 不要（结果走 JSON 文件，
      // 避免中文被控制台代码页吃掉；ctranslate2 的日志也污染不了结构化结果）。
      const options = { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] };
      if (env) options.env = env;
      child = spawn(command, args, options);
    } catch (error) {
      resolve({ code: -1, stderr: `${what} 起不来：${error?.message ?? error}`, error });
      return;
    }
    let stderr = '';
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ code: -2, stderr: `${what} 超过 ${Math.round(timeoutMs / 1000)} 秒，已强制结束`, timedOut: true });
    }, Math.max(500, Number(timeoutMs) || 60000));
    child.stderr?.on?.('data', (chunk) => {
      // 只留尾部：stderr 可能被 ctranslate2 刷屏，前面的没用。
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.on('error', (error) => finish({ code: -1, stderr: `${what} 不可用：${error?.message ?? error}`, error }));
    child.on('close', (code) => finish({ code, stderr }));
  });
}

/** stderr 尾部压成一行：日志里只放得下一行，也不能让换行伪造日志结构。 */
function cleanStderr(text, max = 200) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `…${flat.slice(-max)}` : flat;
}

/**
 * 把 QQ 语音（AMR / SILK / 其它）转成 whisper 要的 **16kHz 单声道 16bit PCM wav**。
 *
 * 返回 { ok, path, bytes, duration, inputFormat, converted, truncated, reason }；**永不抛**。
 *
 * 两个实现细节：
 *  • `-t maxSeconds + 1`：让 ffmpeg 最多只解这么多秒。既给了解码工作量一个上限，
 *    又能用「解出来的时长 > maxSeconds」判断超长（比先跑一次 ffprobe 再跑 ffmpeg 省一半进程）。
 *  • silk：ffmpeg 根本没有 silk 解码器，所以失败时要把原因换成一句能照着做的话
 *    （让网关用 get_record 的 out_format 先转码），而不是让 "Invalid data" 飘到日志里。
 */
export async function silkToWav(inputPath, {
  ffmpegPath = 'ffmpeg',
  outPath = '',
  timeoutMs = 60000,
  maxSeconds = ASR_DEFAULTS.maxSeconds
} = {}) {
  const src = cleanString(inputPath, 1024);
  const cap = clampInt(maxSeconds, ASR_LIMITS.maxSeconds, ASR_DEFAULTS.maxSeconds);
  const result = {
    ok: false,
    path: '',
    bytes: 0,
    duration: 0,
    inputFormat: '',
    converted: false,
    truncated: false,
    reason: ''
  };
  if (!src) { result.reason = '没有输入文件'; return result; }
  if (!isFile(src)) { result.reason = `输入文件不存在：${src}`; return result; }
  const sniffed = sniffAudioFormat(src);
  result.inputFormat = sniffed.format;

  // 已经是 16k/单声道 wav 且时长没超：不重复转码（省一次 ffmpeg，也少一次落盘）。
  if (sniffed.format === 'wav') {
    const info = wavInfoFromFile(src);
    if (info?.pcm16kMono && info.duration > 0 && info.duration <= cap) {
      result.ok = true;
      result.path = src;
      result.bytes = fs.statSync(src).size;
      result.duration = info.duration;
      return result;
    }
  }

  const target = cleanString(outPath, 1024) || `${src}.16k.wav`;
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch {}
  const args = [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-i', src,
    '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le',
    // +1 秒余量：正好卡在 cap 上的语音不该被误判，但明显超长的要在这一层就掐掉。
    '-t', String(cap + 1),
    '-f', 'wav', '-bitexact',
    target
  ];
  const run = await runChild(ffmpegPath, args, { timeoutMs, what: 'ffmpeg' });
  if (run.code !== 0) {
    result.reason = sniffed.silk
      // 这句是给运维/排查用的：silk 不是「再试一次」能解决的，必须换路径。
      ? `SILK 格式 ffmpeg 解不了（本机 ffmpeg 没有 silk 解码器）。让网关先转码：OneBot get_record 传 out_format="${ASR_DEFAULTS.gatewayOutFormat}"`
      : `ffmpeg 转码失败（退出码 ${run.code}）：${cleanStderr(run.stderr) || '没有输出'}`;
    return result;
  }
  const info = wavInfoFromFile(target);
  if (!info) {
    result.reason = `ffmpeg 没有产出可解析的 wav：${target}`;
    return result;
  }
  if (info.duration > cap) {
    result.reason = `语音时长 ${info.duration.toFixed(1)} 秒超过上限 ${cap} 秒`;
    result.duration = info.duration;
    try { fs.rmSync(target, { force: true }); } catch {}
    return result;
  }
  result.ok = true;
  result.path = target;
  result.bytes = fs.statSync(target).size;
  result.duration = info.duration;
  result.converted = target !== src;
  // -t 截断时 ffmpeg 不会报错，只能靠「时长贴着 cap+1」反推；这里给个近似提示。
  result.truncated = info.duration >= cap + 0.9;
  return result;
}

// ── 缓存：同一条语音不重复转写 ────────────────────────────────────────────────
// 用内容哈希做 key：同一条语音被转发/被重新下载（路径变了、mtime 变了）也能命中；
// 反过来，路径复用但内容变了不会误命中。范围 = 进程内 Map，重启即失效，不引数据库。
export function hashFile(file) {
  try {
    const buf = fs.readFileSync(file);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return '';
  }
}

/** 缓存 key：小文件用内容哈希，超大文件退回 路径+大小+mtime（避免为哈希多读一遍大文件）。 */
export function cacheKeyFor(file, { maxHashBytes = 32 * 1024 * 1024 } = {}) {
  let stat = null;
  try { stat = fs.statSync(file); } catch { return ''; }
  if (!stat.isFile()) return '';
  if (stat.size <= maxHashBytes) {
    const digest = hashFile(file);
    if (digest) return `sha256:${digest}`;
  }
  return `meta:${path.resolve(file)}:${stat.size}:${Math.round(stat.mtimeMs)}`;
}

/**
 * 轻量 LRU 缓存。get 命中会刷新顺序；超上限淘汰最旧一条。
 * ttl 是为了「模型换了但进程没重启」这种情况不至于一直吐旧结果。
 */
export function createAsrCache({ maxEntries = 128, ttlMs = 6 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const map = new Map();
  const stats = { hits: 0, misses: 0, evictions: 0 };
  return {
    get(key) {
      if (!key) return null;
      const hit = map.get(key);
      if (!hit) { stats.misses += 1; return null; }
      if (ttlMs > 0 && now() - hit.at > ttlMs) {
        map.delete(key);
        stats.misses += 1;
        return null;
      }
      map.delete(key);
      map.set(key, hit); // LRU：命中后挪到队尾
      stats.hits += 1;
      return hit.value;
    },
    set(key, value) {
      if (!key) return value;
      if (map.has(key)) map.delete(key);
      map.set(key, { at: now(), value });
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
        stats.evictions += 1;
      }
      return value;
    },
    clear() { map.clear(); },
    size() { return map.size; },
    stats() { return { ...stats, size: map.size }; }
  };
}

/** 默认缓存实例（桥接直接用这个；测试可以自己 new 一个隔离的）。 */
export const asrCache = createAsrCache();

// ── 并发闸门 ──────────────────────────────────────────────────────────────────
// 群里五个人同时发语音时，不能让桥接同时 fork 五个 python + 五个 int8 模型
// （16G 内存 + 6 核：那样互相拖慢，最坏 OOM 把整个桥接带走）。串行 + 有限排队。
const slotState = { active: 0, queue: [], maxConcurrent: 1, maxQueue: 8 };

/**
 * 拿一个执行槽。返回 release 函数；队列满时返回 null（调用方当「忙，跳过这次」处理，
 * 而不是排队到天荒地老）。
 */
export function acquireAsrSlot({ maxQueue = slotState.maxQueue, maxConcurrent = slotState.maxConcurrent } = {}) {
  if (slotState.active < maxConcurrent) {
    slotState.active += 1;
    return () => {
      slotState.active = Math.max(0, slotState.active - 1);
      const next = slotState.queue.shift();
      if (next) {
        slotState.active += 1;
        next();
      }
    };
  }
  if (slotState.queue.length >= maxQueue) return null;
  return new Promise((resolve) => {
    slotState.queue.push(() => {
      resolve(() => {
        slotState.active = Math.max(0, slotState.active - 1);
        const next = slotState.queue.shift();
        if (next) {
          slotState.active += 1;
          next();
        }
      });
    });
  });
}

/** 只给测试用：把闸门恢复出厂状态，避免用例之间互相卡住。 */
export function __resetAsrSlots() {
  slotState.active = 0;
  slotState.queue = [];
}

/**
 * 调 python 转写一个音频文件。
 *
 * 返回 { ok, text, language, duration, elapsedMs, model, cached, reason }；**永不抛**。
 *
 * 契约细节：
 *  • `ok:true` + 空 text 是**合法**结果（一段静音/纯噪声）——调用方据此退回 `[语音]`。
 *  • `elapsedMs` 是 Node 侧测到的墙钟时间（含 spawn + 模型加载），不是 python 自报的数字，
 *    这样「慢在哪儿」不会被抹平。
 *  • 结果 JSON 走**同目录**的临时文件，不写系统临时目录：C 盘只剩个位数 GB，
 *    而这里天然跟音频同卷（也都好清理）。
 */
export async function transcribe(file, {
  pythonPath = '',
  scriptPath = '',
  modelPath = '',
  modelDir = '',
  model = ASR_DEFAULTS.model,
  language = ASR_DEFAULTS.language,
  timeoutMs = ASR_DEFAULTS.timeoutMs,
  maxSeconds = ASR_DEFAULTS.maxSeconds,
  beamSize = ASR_DEFAULTS.beamSize,
  cache = asrCache,
  env = null,
  force = false
} = {}) {
  const startedAt = Date.now();
  const audio = cleanString(file, 1024);
  const cap = clampInt(maxSeconds, ASR_LIMITS.maxSeconds, ASR_DEFAULTS.maxSeconds);
  const limit = clampInt(timeoutMs, ASR_LIMITS.timeoutMs, ASR_DEFAULTS.timeoutMs);
  const modelLabel = cleanString(model, 120) || ASR_DEFAULTS.model;
  const fail = (reason, extra = {}) => ({
    ok: false,
    text: '',
    language: '',
    duration: 0,
    elapsedMs: Date.now() - startedAt,
    model: modelLabel,
    cached: false,
    reason,
    ...extra
  });

  if (!audio) return fail('没有音频文件');
  if (!isFile(audio)) return fail(`音频文件不存在：${audio}`);
  if (!pythonPath) return fail('没有可用的 Python（检查 socialV2.asr.pythonPath / ASR_PYTHON）');
  if (!scriptPath || !isFile(scriptPath)) return fail(`找不到转写脚本：${scriptPath || '(未配置)'}`);

  // 缓存键除了音频内容还要带上模型/语言/时长上限：换模型（small→base）或换语言之后，
  // 同一段音频**必须**重新转写，否则会把上一次模型的结果当成这次的答案 —— 那种
  // 「怎么改配置都没效果」的排查会非常费解。
  const contentKey = cacheKeyFor(audio);
  const key = contentKey ? `${contentKey}|${modelLabel}|${String(language ?? '')}|${cap}` : null;
  if (!force && cache && key) {
    const hit = cache.get(key);
    if (hit) return { ...hit, cached: true, elapsedMs: 0 };
  }

  const releaseOrWait = acquireAsrSlot();
  if (releaseOrWait === null) return fail('ASR 队列已满，跳过这条（稍后/下条再试）');
  const release = typeof releaseOrWait === 'function' ? releaseOrWait : await releaseOrWait;

  const outFile = path.join(
    path.dirname(audio),
    `.asr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  );
  try {
    const args = [
      scriptPath,
      '--audio', audio,
      '--out', outFile,
      '--model-label', modelLabel,
      '--language', String(language ?? ''),
      '--max-seconds', String(cap),
      '--beam-size', String(clampInt(beamSize, ASR_LIMITS.beamSize, ASR_DEFAULTS.beamSize))
    ];
    if (modelPath) {
      // 本地模型目录：完全不碰网络。HF_HUB_OFFLINE 一起设上，防止 huggingface_hub
      // 为了校验 revision 去做一次 etag 请求（没网时会卡到超时才失败）。
      args.push('--model', modelPath, '--local-files-only', '--model-dir', modelDir || path.dirname(modelPath));
    } else {
      args.push('--model', modelLabel);
      if (modelDir) args.push('--model-dir', modelDir);
      args.push('--no-vad'); // 没有本地模型的兜底路径只用于排查，vad 反而更容易剪没
    }
    const childEnv = {
      ...(env ?? process.env),
      // 中文输出：万一有人绕过 --out 用 stdout，也不会被 GBK 控制台打成 `??`。
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1',
      ...(modelDir ? { HF_HOME: modelDir } : {})
    };
    const run = await runChild(pythonPath, args, { timeoutMs: limit, env: childEnv, what: 'faster-whisper' });
    const payload = readJsonSafeLocal(outFile);
    if (!payload) {
      return fail(
        run.timedOut
          ? `转写超时（> ${Math.round(limit / 1000)} 秒）`
          : `转写进程没有写出结果（退出码 ${run.code}）${run.stderr ? `：${cleanStderr(run.stderr)}` : ''}`
      );
    }
    if (!payload.ok) {
      return fail(String(payload.reason || '转写失败'));
    }
    // python 侧自己测的耗时放 transcribeMs，elapsedMs 用墙钟（含模型加载 + spawn 开销）。
    const value = {
      ok: true,
      text: String(payload.text ?? ''),
      language: String(payload.language ?? ''),
      duration: Number(payload.duration) || 0,
      elapsedMs: Date.now() - startedAt,
      transcribeMs: Number(payload.elapsedMs) || 0,
      model: String(payload.model || modelLabel),
      device: String(payload.device ?? ''),
      computeType: String(payload.computeType ?? ''),
      vad: Boolean(payload.vad),
      cached: false,
      reason: ''
    };
    if (cache && key && value.ok) cache.set(key, value);
    return value;
  } catch (error) {
    // 兜底的兜底：任何意外的同步异常都不能冒到消息主循环里。
    return fail(`转写异常：${error?.message ?? error}`);
  } finally {
    release?.();
    try { fs.rmSync(outFile, { force: true }); } catch {}
  }
}

/** 读 JSON 文件（不存在/坏了/不是对象都返回 null），不抛。 */
function readJsonSafeLocal(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 把一条失败结果压成一行日志用的原因（含 ok:false 的各种 reason）。 */
export function describeAsrFailure(result) {
  if (!result) return '未知原因';
  if (result.ok) return '';
  return String(result.reason || '未知原因').replace(/\s+/g, ' ').slice(0, 240);
}

/** 给等待 cpu 的调用者用（主要给测试/调试）：不做任何 I/O 的忙等。 */
export async function waitForAsrIdle({ timeoutMs = 60000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (slotState.active === 0 && slotState.queue.length === 0) return true;
    await sleep(pollMs);
  }
  return false;
}
