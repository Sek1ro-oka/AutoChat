// src/asr-core.js 的离线测试：不联网、不依赖聊天进程，纯本地跑。
//
//   node scripts/test-asr-core.mjs
//   ASR_LIVE=1 node scripts/test-asr-core.mjs      # 额外跑一次真模型（要本地模型已就绪）
//
// 覆盖的是「容易静默出错」的地方：路径解析（找不到必须 ok:false 而不是抛）、
// 配置钳制（上限形同虚设就等于没有）、哈希缓存（换模型不能误命中）、
// 以及三条降级分支（silk 解不了 / 解释器不在 / 超时）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASR_DEFAULTS,
  __resetAsrSlots,
  acquireAsrSlot,
  cacheKeyFor,
  createAsrCache,
  hashFile,
  normalizeAsrConfig,
  readWavInfo,
  resolveAsrBinary,
  resolveModelPath,
  silkToWav,
  sniffAudioFormat,
  transcribe
} from '../src/asr-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
let passed = 0;

function check(ok, label, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail === undefined ? '' : `  → ${detail}`}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// 临时目录放在仓库内（state/ 已被 .gitignore 忽略）：C 盘只剩几个 G，
// 而且本机的 python/ffmpeg 对工作区之外的写入偶尔会被策略挡住。
const TMP = path.join(ROOT, 'state', 'asr-test');
fs.mkdirSync(TMP, { recursive: true });

let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch {
  console.log('（读不到 config.json，改用默认值跑）');
}
const asrCfg = config?.socialV2?.asr ?? {};
const ffmpegPath = asrCfg.ffmpegPath || process.env.FFMPEG_PATH || 'E:\\tools\\ffbin\\ffmpeg.exe';
const realPython = asrCfg.pythonPath || 'E:\\tools\\asr\\venv\\Scripts\\python.exe';
const realModels = asrCfg.modelsDir || 'E:\\tools\\asr\\models';
const realScript = asrCfg.scriptPath || 'E:\\tools\\asr\\transcribe.py';

// ── 1. 配置归一化：上限必须真的生效 ───────────────────────────────────────────
section('1. normalizeAsrConfig 钳制');
{
  const n = normalizeAsrConfig({});
  check(n.model === ASR_DEFAULTS.model, '空配置回落到默认模型', n.model);
  check(n.enabled === false, '默认不启用（没配就是关着的）', n.enabled);

  const wild = normalizeAsrConfig({ maxSeconds: 99999, maxBytes: 1, timeoutMs: 1, beamSize: 99, language: 'auto' });
  check(wild.maxSeconds <= 600 && wild.maxSeconds >= 1, `maxSeconds 钳到合法区间（${wild.maxSeconds}）`);
  check(wild.maxBytes >= 65536, `maxBytes 钳到最小值（${wild.maxBytes}）`);
  check(wild.timeoutMs >= 1000, `timeoutMs 钳到最小值（${wild.timeoutMs}）`);
  check(wild.beamSize <= 10 && wild.beamSize >= 1, `beamSize 钳到合法区间（${wild.beamSize}）`);
  // language:'auto' → 空串（= 让 whisper 自己检测），这是 allowed 的显式用法，不算配置错误
  check(wild.language === '', 'language:"auto" 归一成空串（自动检测）', JSON.stringify(wild.language));

  const str = normalizeAsrConfig({ maxSeconds: '30', maxBytes: '1048576', enabled: 'false' });
  check(str.maxSeconds === 30 && str.maxBytes === 1048576, '字符串数字被解析成数字');
  // 只认字面 true：配置写成 "false"（字符串）绝不能把功能打开
  check(str.enabled === false, '字符串 "false" 视为关闭（不猜人类意图）', str.enabled);
}

// ── 2. 文件头嗅探：QQ 的 .amr 其实常常是 silk，光看扩展名会走错路 ──────────────
section('2. sniffAudioFormat 按文件头判断');
{
  const silk = Buffer.concat([Buffer.from([0x02]), Buffer.from('#!SILK_V3', 'ascii'), Buffer.alloc(32)]);
  check(sniffAudioFormat(silk).format === 'silk', '0x02 + #!SILK_V3 → silk', sniffAudioFormat(silk).format);
  const silkPlain = Buffer.concat([Buffer.from('#!SILK_V3', 'ascii'), Buffer.alloc(32)]);
  check(sniffAudioFormat(silkPlain).format === 'silk', '裸 #!SILK_V3 → silk');
  const amr = Buffer.concat([Buffer.from('#!AMR\n', 'ascii'), Buffer.alloc(32)]);
  check(sniffAudioFormat(amr).format === 'amr', '#!AMR → amr');
  const wav = Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'ascii');
  check(sniffAudioFormat(wav).format === 'wav', 'RIFF....WAVE → wav');
  const mp3 = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.alloc(16)]);
  check(sniffAudioFormat(mp3).format === 'mp3', 'ID3 → mp3');
  check(sniffAudioFormat(Buffer.alloc(0)).format === 'unknown', '空 Buffer → unknown 而不是抛');
}

// ── 3. 模型目录解析：两种布局（自己下的目录 / HF hub 缓存）都要认 ──────────────
section('3. resolveModelPath');
{
  const direct = path.join(TMP, 'models-direct', 'small');
  fs.mkdirSync(direct, { recursive: true });
  fs.writeFileSync(path.join(direct, 'model.bin'), 'x');
  check(resolveModelPath(path.join(TMP, 'models-direct'), 'small') === direct,
    'models/<model>/model.bin 布局');

  const hub = path.join(TMP, 'models-hub', 'models--Systran--faster-whisper-small', 'snapshots', 'abc123');
  fs.mkdirSync(hub, { recursive: true });
  fs.writeFileSync(path.join(hub, 'model.bin'), 'x');
  check(resolveModelPath(path.join(TMP, 'models-hub'), 'small') === hub,
    'HF hub 的 snapshots 布局');

  // 配置里直接写死模型目录时，也要有 model.bin 才算数（空目录 = 没装）
  check(resolveModelPath('', direct) === direct, '直接写绝对目录也能认');
  check(resolveModelPath('', path.join(TMP, 'models-empty')) === '', '空目录 → 空串（不算装好）');
  check(resolveModelPath(TMP, 'no-such-model') === '', '都不存在 → 空串');
}

// ── 4. resolveAsrBinary：找不到一律 ok:false，绝不抛 ──────────────────────────
section('4. resolveAsrBinary');
{
  // 「哪儿都没有」的对照环境：config / env / 默认安装位置三者皆空。
  const NOWHERE = {
    home: path.join(TMP, 'nowhere'),
    pythonPath: path.join(TMP, 'no-python.exe'),
    scriptPath: path.join(TMP, 'no-script.py'),
    modelsDir: path.join(TMP, 'models-empty')
  };

  let threw = false;
  let bogus;
  try {
    bogus = resolveAsrBinary({ configured: {}, env: {}, knownPaths: NOWHERE });
  } catch (error) {
    threw = true;
    bogus = { reason: String(error?.message ?? error) };
  }
  check(!threw, '什么都没装时不抛异常');
  check(bogus.ok === false, '什么都没装 → ok:false', bogus.ok);
  check(/python|解释器/i.test(bogus.reason ?? ''), '原因里说清是 python 的问题', bogus.reason);

  if (!fs.existsSync(realPython)) {
    console.log('  · 本机没装 ASR 环境，后续几条跳过');
  } else {
    const noModel = resolveAsrBinary({
      configured: { pythonPath: realPython, scriptPath: realScript, modelsDir: path.join(TMP, 'models-empty'), model: 'small' },
      env: {},
      knownPaths: NOWHERE
    });
    check(noModel.ok === false, '模型没下载 → ok:false', noModel.ok);
    check(/模型/.test(noModel.reason ?? ''), '原因里说清是模型没下载', noModel.reason);

    // allowDownload:true 是为了「第一次调用顺便下模型」的场景显式放行
    const allowed = resolveAsrBinary({
      configured: { pythonPath: realPython, scriptPath: realScript, modelsDir: path.join(TMP, 'models-empty'), model: 'small' },
      env: {},
      knownPaths: NOWHERE,
      allowDownload: true
    });
    check(allowed.ok === true && allowed.modelReady === false, 'allowDownload:true 显式放行', JSON.stringify({ ok: allowed.ok, ready: allowed.modelReady }));

    const noScript = resolveAsrBinary({
      configured: { pythonPath: realPython, modelsDir: realModels, model: 'small' },
      env: {},
      knownPaths: NOWHERE
    });
    check(noScript.ok === false, '脚本不存在 → ok:false', noScript.ok);
    check(/transcribe|脚本/.test(noScript.reason ?? ''), '原因里说清是脚本的问题', noScript.reason);

    // 真环境（模型已下好）应当 ok:true；没装的环境不该判失败。
    const real = resolveAsrBinary({ configured: { ...asrCfg, pythonPath: realPython, scriptPath: realScript, modelsDir: realModels }, env: {}, knownPaths: NOWHERE });
    if (real.ok) {
      check(typeof real.modelPath === 'string' && real.modelPath.length > 0, '真环境解析出模型目录', real.modelPath);
      check(fs.existsSync(real.modelPath), '模型目录真实存在');
    } else {
      console.log(`  · 跳过真环境断言（${real.reason}）`);
    }
  }
}

// ── 5. 哈希缓存：同内容同键、换模型/换语言/换上限不能误命中 ──────────────────
section('5. hashFile / cacheKeyFor / createAsrCache');
{
  const a = path.join(TMP, 'a.wav');
  const b = path.join(TMP, 'b.wav');
  fs.writeFileSync(a, 'same-bytes');
  fs.writeFileSync(b, 'same-bytes');
  const ha = await hashFile(a);
  const hb = await hashFile(b);
  check(ha === hb && /^[0-9a-f]{64}$/.test(ha), '内容相同的两个文件哈希相同（路径不影响命中）', ha);

  const k1 = cacheKeyFor(a);
  const k2 = cacheKeyFor(b);
  const c = path.join(TMP, 'c.wav');
  fs.writeFileSync(c, 'other-bytes');
  const k3 = cacheKeyFor(c);
  check(/^sha256:/.test(k1), '小文件用内容哈希做键', k1);
  check(k1 === k2, '内容相同的两个文件 → 同键（转发的同一条语音也能命中）');
  check(k1 !== k3, '内容变了 → 键不同（路径复用不会误命中）');
  check(cacheKeyFor(path.join(TMP, 'missing.wav')) === '', '文件不存在 → 空键（不抛）');

  // 注意：模型/语言/时长上限不在 cacheKeyFor 里，而是 transcribe() 拼在内容键后面
  // （`${contentKey}|${model}|${language}|${cap}`），所以换模型一定重新转写。
  const cache = createAsrCache({ maxEntries: 2, ttlMs: 50 });
  cache.set('k1', { ok: true, text: '一' });
  cache.set('k2', { ok: true, text: '二' });
  cache.set('k3', { ok: true, text: '三' });
  check(cache.get('k1') === null, '超过 maxEntries 时淘汰最旧的');
  check(cache.get('k3')?.text === '三', '新条目还在');
  await new Promise((resolve) => setTimeout(resolve, 70));
  check(cache.get('k3') === null, '超过 ttl 后失效');
  const stats = cache.stats();
  check(stats.misses >= 1 && stats.evictions >= 1, '淘汰/未命中都有计数', JSON.stringify(stats));

  // 并发闸门：同时涌进来 5 条语音时，只能有一个 python 在跑，队列满了就果断跳过
  // （宁可这条语音不转写，也不能把桥接的内存和延迟拖垮）。
  __resetAsrSlots();
  const first = acquireAsrSlot();
  check(typeof first === 'function', '第一个请求立刻拿到执行槽');
  const queued = [];
  for (let i = 0; i < 8; i += 1) queued.push(acquireAsrSlot());
  check(queued.every((entry) => entry instanceof Promise), '后续请求排队而不是并发跑');
  check(acquireAsrSlot() === null, '队列满了 → null（调用方跳过这条）');
  first();
  for (const entry of queued) {
    const release = await entry;
    release();
  }
  __resetAsrSlots();
  check(true, '槽位全部释放（不会把后面的语音永久卡住）');
}

// ── 6. WAV 解析：时长算不出来就等于上限失效 ────────────────────────────────────
section('6. readWavInfo');
{
  // 算不出时长 = 时长上限失效，所以脏数据必须干净地返回 null 而不是抛。
  const bad = readWavInfo(fs.readFileSync(path.join(TMP, 'a.wav')));
  check(bad === null, '非 wav 数据 → null 不抛', JSON.stringify(bad));
  check(readWavInfo(Buffer.alloc(4)) === null, '太短的 buffer → null');
}

// ── 7. silkToWav：能转的转、不能转的说清为什么 ────────────────────────────────
section('7. silkToWav');
{
  // 48k 立体声正弦 → 必须被转成 16k 单声道
  const src = path.join(TMP, 'tone48-stereo.wav');
  const gen = await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000',
    '-ac', '2', '-ar', '48000', src]);
  if (gen.ok) {
    const out = path.join(TMP, 'tone16.wav');
    const conv = await silkToWav(src, { ffmpegPath, outPath: out });
    check(conv.ok, '48k 立体声 wav 转换成功', conv.reason);
    if (conv.ok) {
      const info = readWavInfo(fs.readFileSync(out));
      check(info !== null && info.sampleRate === 16000 && info.channels === 1, '输出是 16k 单声道', JSON.stringify(info));
      check(Math.abs((conv.duration ?? 0) - 2) < 0.3, '时长约 2 秒', conv.duration);
    }
    const again = await silkToWav(conv.ok ? out : src, { ffmpegPath });
    check(again.ok && again.converted === false, '已经是 16k 单声道 → 直接复用不重复转码', JSON.stringify({ ok: again.ok, converted: again.converted }));
  } else {
    console.log(`  · 跳过（ffmpeg 不可用：${gen.detail}）`);
  }

  // 真 QQ 语音（Ptt 缓存里随便捞一个）：本机 ffmpeg 没有 silk 解码器，必须给出可诊断的失败
  const silkSample = findSilkSample();
  if (silkSample) {
    const res = await silkToWav(silkSample, { ffmpegPath, outPath: path.join(TMP, 'silk.16k.wav') });
    check(res.ok === false, 'silk 语音转换失败（预期：本机 ffmpeg 没有 silk 解码器）', res.reason);
    check(/SILK|silk/.test(res.reason ?? ''), '失败原因点名 SILK', res.reason);
    check(/get_record|网关/.test(res.reason ?? ''), '失败原因给出出路（让网关转码）', res.reason);
  } else {
    console.log('  · 跳过 silk 实测（本机没找到 Ptt 语音样本）');
  }

  let threw = false;
  let missing;
  try {
    missing = await silkToWav(path.join(TMP, 'does-not-exist.amr'), { ffmpegPath });
  } catch (error) {
    threw = true;
    missing = { reason: String(error?.message ?? error) };
  }
  check(!threw && missing.ok === false, '文件不存在 → ok:false 不抛', missing.reason);
}

// ── 8. transcribe 的降级分支：解释器不在 / 文件不在 / 超时 ────────────────────
section('8. transcribe 降级');
{
  const wav = path.join(TMP, 'tone16.wav');
  const base = {
    scriptPath: realScript,
    modelPath: resolveModelPath(realModels, asrCfg.model || 'small') || '',
    model: asrCfg.model || 'small',
    language: 'zh',
    maxSeconds: 60,
    timeoutMs: 3000
  };

  let threw = false;
  let noPy;
  try {
    noPy = await transcribe(wav, { ...base, pythonPath: path.join(TMP, 'no-python.exe') });
  } catch (error) {
    threw = true;
    noPy = { reason: String(error?.message ?? error) };
  }
  check(!threw && noPy.ok === false, '解释器不存在 → ok:false 不抛', noPy.reason);

  const noFile = await transcribe(path.join(TMP, 'missing.wav'), { ...base, pythonPath: realPython });
  check(noFile.ok === false, '音频不存在 → ok:false', noFile.reason);

  if (fs.existsSync(realPython) && fs.existsSync(realScript) && base.modelPath) {
    // 超时分支：给 1ms（会被钳到 1s），模型加载都来不及，必须干净地失败而不是挂住。
    const slow = await transcribe(wav, { ...base, pythonPath: realPython, timeoutMs: 1 });
    check(slow.ok === false && /超时|timeout/i.test(slow.reason ?? ''), '超时 → ok:false + 可读原因', slow.reason);
    check(typeof slow.elapsedMs === 'number' && slow.elapsedMs < 15000, '超时后确实退出了（没有挂死）', slow.elapsedMs);
  } else {
    console.log('  · 跳过超时分支（本地没有可用的 python/模型）');
  }
}

// ── 9. 真模型（可选）：只有显式打开才跑，避免 CI 里下载/加载几百 MB ──────────
if (process.env.ASR_LIVE === '1') {
  section('9. 真模型转写（ASR_LIVE=1）');
  const liveWav = process.env.ASR_LIVE_WAV || path.join(ROOT, 'state', 'asr-selftest', 'tts-sample.16k.wav');
  // 样本不存在就自己合成一段：真机验证用的语音不该是仓库里的二进制（也不该指望
  // 上次跑留下的临时文件）。合成必须落在工作区内 —— edge-tts 那个解释器只能写
  // E:\AutoChat 和它自己的 venv，写 %TEMP% 会 PermissionError。
  if (!fs.existsSync(liveWav) && !process.env.ASR_LIVE_WAV) {
    try {
      const { synthesizeEdge } = await import('../src/tts-core.js');
      const mp3 = path.join(path.dirname(liveWav), 'tts-sample.mp3');
      const tts = await synthesizeEdge('今天天气不错，我们出去走走吧。', {
        outFile: mp3,
        pythonPath: process.env.EDGE_TTS_PYTHON || 'E:\\hxq\\ppt-master\\.venv\\Scripts\\python.exe',
        timeoutMs: 60000
      });
      const conv = await silkToWav(tts.file, { ffmpegPath, outPath: liveWav });
      if (conv.ok) console.log(`  · 已用 edge-tts 合成样本 → ${conv.path}`);
    } catch (error) {
      console.log(`  · 样本合成失败（真机验证需要现成的 wav）：${error?.message ?? error}`);
    }
  }
  if (!fs.existsSync(liveWav)) {
    console.log(`  · 跳过（没有样本音频：${liveWav}，可用 ASR_LIVE_WAV=<wav> 指定）`);
  } else {
    const out = await transcribe(liveWav, {
      pythonPath: realPython,
      scriptPath: realScript,
      modelPath: resolveModelPath(realModels, asrCfg.model || 'small'),
      modelDir: realModels,
      model: asrCfg.model || 'small',
      language: asrCfg.language || 'zh',
      maxSeconds: asrCfg.maxSeconds || 60,
      timeoutMs: asrCfg.timeoutMs || 60000
    });
    check(out.ok, '转写成功', out.reason);
    check(typeof out.text === 'string' && out.text.length > 0, '文本非空', out.text);
    console.log(`  · 文本：${out.text}（${out.elapsedMs}ms，模型 ${out.model}）`);
  }
} else {
  console.log('\n（真模型验证未开启：加 ASR_LIVE=1 才跑）');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);

// ── 辅助 ─────────────────────────────────────────────────────────────────────
async function runFfmpeg(args) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true });
    } catch (error) {
      resolve({ ok: false, detail: String(error?.message ?? error) });
      return;
    }
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => resolve({ ok: false, detail: String(error?.message ?? error) }));
    child.on('close', (code) => resolve({ ok: code === 0, detail: stderr.split('\n').slice(-2).join(' ') }));
  });
}

// 从 QQ 的 Ptt 缓存里找一个「文件名 .amr、内容其实是 silk」的样本（只读，不复制）。
function findSilkSample() {
  const bases = [
    path.join(os.homedir(), 'Documents', 'Tencent Files'),
  ];
  const stack = [...bases];
  let visited = 0;
  while (stack.length && visited < 4000) {
    const dir = stack.pop();
    visited += 1;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/\.amr$/i.test(entry.name)) continue;
      try {
        const fd = fs.openSync(full, 'r');
        const head = Buffer.alloc(16);
        fs.readSync(fd, head, 0, 16, 0);
        fs.closeSync(fd);
        if (sniffAudioFormat(head).format === 'silk') return full;
      } catch {
        /* 读不了就跳过 */
      }
    }
  }
  return '';
}
