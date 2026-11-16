// 发视频（T-061）：qq_send_video / qq_watch_video 两个工具。
//
// 为什么单独一个模块：mcp-snowluma-safe.js 已经 2400 行，而这两个工具需要 spawn
// yt-dlp / ffmpeg、还要管落盘与清理 —— 塞进去会把它变成第二个 bridge.js。
// 注册方式与 device-tools / reach-tools 一致：registerXxxTools(server, opts)。
//
// 与桥接的分工（重要，别把这条破坏掉）：
// - 本模块**只负责把一段视频变成「outbox 里一个合规的 .mp4」**：下载、裁剪、转码、控体积；
// - 真正的发送一律 POST /api/send/video，由桥接做白名单 / 静默模式 / 发送守卫 / 限频 /
//   sendChain 排队。不要在这里直接调 OneBot 的 send_*_msg，那会绕过全部闸门。
// - 桥接的 HTTP 请求体上限是 1MB，视频走不了 JSON body，所以约定用 outbox 纯文件名交接。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';

const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.flv', '.webm', '.avi', '.m4v', '.ts'];
// 720p / 25MB 是 QQ 群视频比较稳的区间：再高网关侧转码会超时，再低画面糊得没法看。
const DEFAULT_MAX_HEIGHT = 720;
const DOWNLOAD_TIMEOUT_MS = 600000;
const TRANSCODE_TIMEOUT_MS = 300000;

function run(command, argv, { timeoutMs = 120000, cwd = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, argv, { cwd, windowsHide: true });
    } catch (error) {
      resolve({ ok: false, code: null, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n[超时 ${timeoutMs}ms 已终止]` });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { if (stdout.length < 200000) stdout += d.toString(); });
    child.stderr?.on('data', (d) => { if (stderr.length < 200000) stderr += d.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function tail(text, n = 400) {
  const s = String(text ?? '').trim();
  return s.length > n ? '…' + s.slice(-n) : s;
}

/**
 * 解析可执行文件位置。顺序：config → 环境变量 → PATH 里的名字 → 已知安装路径。
 * 最后一段是给「DSH 比 PATH 改动更早启动」这种情况兜底的：进程环境在启动时快照，
 * 用户后来装了 ffmpeg 也不会在这个进程里出现。
 */
function resolveBinary({ configured, envNames = [], fallbackNames = [], knownPaths = [] }) {
  const direct = String(configured ?? '').trim();
  if (direct) return direct;
  for (const name of envNames) {
    const v = String(process.env[name] ?? '').trim();
    if (v) return v;
  }
  for (const name of fallbackNames) {
    for (const p of knownPaths) {
      if (!p) continue;
      if (path.basename(p).toLowerCase() === name.toLowerCase().replace(/\.exe$/i, '') + '.exe' && fs.existsSync(p)) return p;
    }
  }
  return fallbackNames[0] ?? '';
}

export function registerVideoTools(server, opts = {}) {
  const root = opts.root ?? process.cwd();
  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => ({});
  const agentApi = typeof opts.agentApi === 'function' ? opts.agentApi : null;

  const outboxDir = () => path.join(root, 'state', 'outbox');

  function videoConfig() {
    const cfg = getConfig() || {};
    const v = cfg.socialV2?.video ?? {};
    return {
      enabled: v.enabled !== false,
      maxBytes: Number(v.maxBytes) || 25 * 1024 * 1024,
      maxSeconds: Number(v.maxSeconds) || 180
    };
  }

  function binPaths() {
    const cfg = getConfig() || {};
    const ffmpeg = resolveBinary({
      configured: cfg.socialV2?.voice?.ffmpegPath,
      envNames: ['FFMPEG_PATH'],
      fallbackNames: ['ffmpeg'],
      knownPaths: ['E:\\tools\\ffbin\\ffmpeg.exe']
    });
    const ffprobe = resolveBinary({
      configured: cfg.socialV2?.voice?.ffprobePath,
      envNames: ['FFPROBE_PATH'],
      fallbackNames: ['ffprobe'],
      knownPaths: ['E:\\tools\\ffbin\\ffprobe.exe']
    });
    const ytdlp = resolveBinary({
      configured: cfg.socialV2?.video?.ytdlpPath,
      envNames: ['YTDLP_PATH'],
      fallbackNames: ['yt-dlp'],
      knownPaths: ['C:\\Users\\MR\\.agent-reach-venv\\Scripts\\yt-dlp.exe']
    });
    return { ffmpeg, ffprobe, ytdlp };
  }

  async function probe(file) {
    const { ffprobe } = binPaths();
    const r = await run(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration,size,format_name:stream=codec_type,codec_name,width,height',
      '-of', 'json', file
    ], { timeoutMs: 20000 });
    if (!r.ok) return { ok: false, error: tail(r.stderr) };
    try {
      const data = JSON.parse(r.stdout);
      const streams = data.streams ?? [];
      const v = streams.find((s) => s.codec_type === 'video');
      const a = streams.find((s) => s.codec_type === 'audio');
      if (!v) return { ok: false, error: '这个文件里没有视频轨' };
      return {
        ok: true,
        duration: Number(data.format?.duration) || 0,
        size: Number(data.format?.size) || 0,
        videoCodec: v.codec_name,
        audioCodec: a?.codec_name ?? null,
        hasAudio: Boolean(a),
        width: Number(v.width) || 0,
        height: Number(v.height) || 0
      };
    } catch (error) {
      return { ok: false, error: `解析 ffprobe 输出失败：${error?.message ?? error}` };
    }
  }

  async function withYtdlp(url, workDir) {
    const { ytdlp } = binPaths();
    const template = path.join(workDir, 'src.%(ext)s');
    const argv = [
      '--no-playlist',
      '--no-warnings',
      // 优先要 mp4/h264：QQ 对 h264+aac 的 mp4 兼容最好，其他容器经常发出去变成"文件"。
      '-f', `bv*[height<=${DEFAULT_MAX_HEIGHT}][ext=mp4]+ba[ext=m4a]/b[height<=${DEFAULT_MAX_HEIGHT}]/bv*+ba/b`,
      '--merge-output-format', 'mp4',
      '-o', template,
      url
    ];
    const r = await run(ytdlp, argv, { timeoutMs: DOWNLOAD_TIMEOUT_MS, cwd: workDir });
    if (!r.ok) return { ok: false, error: `yt-dlp 下载失败：${tail(r.stderr, 600)}` };
    const files = (await fsp.readdir(workDir)).filter((n) => n.startsWith('src.'));
    if (!files.length) return { ok: false, error: 'yt-dlp 报告成功但没找到输出文件' };
    // 合并后 yt-dlp 把分开下的音/视频片段留在原地（src.f30280.m4a 这种）。它们已经
    // 没用了，就地删掉 —— 否则每下一支视频就在 outbox 里白留几 MB 的音频碎片。
    const merged = files.find((n) => n === 'src.mp4') ?? files.find((n) => n.toLowerCase().endsWith('.mp4')) ?? files[0];
    for (const n of files) {
      if (n !== merged) await fsp.rm(path.join(workDir, n), { force: true }).catch(() => {});
    }
    return { ok: true, file: path.join(workDir, merged) };
  }

  async function transcode(input, output, { startSeconds = 0, durationSeconds, maxBytes }) {
    const { ffmpeg } = binPaths();
    const attempts = [
      { crf: 26, height: DEFAULT_MAX_HEIGHT },
      { crf: 30, height: 540 },
      { crf: 34, height: 480 }
    ];
    let lastError = '';
    for (const attempt of attempts) {
      const argv = ['-y', '-hide_banner', '-loglevel', 'error'];
      if (startSeconds > 0) argv.push('-ss', String(startSeconds));
      argv.push('-i', input);
      if (durationSeconds > 0) argv.push('-t', String(durationSeconds));
      argv.push(
        '-vf', `scale=-2:'min(${attempt.height},ih)'`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(attempt.crf),
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
        '-movflags', '+faststart',
        output
      );
      const r = await run(ffmpeg, argv, { timeoutMs: TRANSCODE_TIMEOUT_MS });
      if (!r.ok) {
        lastError = tail(r.stderr, 600);
        continue;
      }
      const stat = await fsp.stat(output).catch(() => null);
      if (stat && stat.size <= maxBytes) return { ok: true, size: stat.size, crf: attempt.crf, height: attempt.height };
      lastError = `转码后仍有 ${((stat?.size ?? 0) / 1048576).toFixed(1)}MB，超过上限 ${(maxBytes / 1048576).toFixed(1)}MB`;
    }
    return { ok: false, error: lastError };
  }

  /**
   * 把「url 或本地文件」变成 outbox 里的一个合规 mp4。
   * 返回 { ok, name, size, duration } —— name 是纯文件名，交给桥接。
   */
  async function prepareVideo({ url, file, startSeconds, durationSeconds }) {
    const cfg = videoConfig();
    const workDir = outboxDir();
    await fsp.mkdir(workDir, { recursive: true });
    // 兜底清扫：正常路径下桥接发完就删，但桥接没起来 / 发送抛异常时 outbox 会留半成品。
    // 超过一小时的残留按垃圾处理（这里只碰我们自己命名的文件，不碰用户的其它东西）。
    try {
      const cutoff = Date.now() - 3600000;
      for (const n of await fsp.readdir(workDir)) {
        if (!n.endsWith('.mp4')) continue;
        const p = path.join(workDir, n);
        const st = await fsp.stat(p).catch(() => null);
        if (st && st.mtimeMs < cutoff) await fsp.rm(p, { force: true }).catch(() => {});
      }
    } catch {}

    let input = '';
    let cleanup = [];
    let sourceDesc = '';

    if (url) {
      const dl = await withYtdlp(String(url).trim(), workDir);
      if (!dl.ok) return dl;
      input = dl.file;
      cleanup.push(input);
      sourceDesc = '下载';
    } else if (file) {
      const abs = path.resolve(String(file).trim());
      if (!fs.existsSync(abs)) return { ok: false, error: `找不到文件：${abs}` };
      const ext = path.extname(abs).toLowerCase();
      if (!VIDEO_EXTS.includes(ext)) return { ok: false, error: `不认识的视频扩展名 ${ext}（支持 ${VIDEO_EXTS.join(' ')}）` };
      // 允许的根：工作区 + 系统临时目录。别的路径一律不读 —— 这个工具是给"发自己拍/下的东西"
      // 用的，不是通用文件外发通道。
      const allowed = [path.resolve(root), path.resolve(process.env.TEMP || 'C:\\Windows\\Temp')];
      const inside = allowed.some((base) => abs.toLowerCase().startsWith(base.toLowerCase()));
      if (!inside) return { ok: false, error: `只允许发工作区（${root}）或临时目录里的文件；${abs} 不在其中` };
      input = abs;
      sourceDesc = '本地文件';
    } else {
      return { ok: false, error: 'url 和 file 至少给一个' };
    }

    try {
      const info = await probe(input);
      if (!info.ok) return { ok: false, error: `读不出视频信息：${info.error}` };
      if (info.duration <= 0) return { ok: false, error: '视频时长为 0，可能下载不完整' };

      const start = Math.max(0, Number(startSeconds) || 0);
      if (start >= info.duration) {
        return { ok: false, error: `startSeconds=${start} 超过了视频总长 ${info.duration.toFixed(1)}s` };
      }
      const remain = info.duration - start;
      const want = Number(durationSeconds) > 0 ? Number(durationSeconds) : remain;
      const dur = Math.min(want, cfg.maxSeconds, remain);

      const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.mp4`;
      const output = path.join(workDir, name);
      const tr = await transcode(input, output, { startSeconds: start, durationSeconds: dur, maxBytes: cfg.maxBytes });
      if (!tr.ok) {
        await fsp.rm(output, { force: true }).catch(() => {});
        return { ok: false, error: `转码失败：${tr.error}` };
      }
      return {
        ok: true,
        name,
        size: tr.size,
        duration: dur,
        clipped: dur < remain - 0.5,
        originalDuration: info.duration,
        resolution: `${tr.height}p`,
        source: sourceDesc
      };
    } finally {
      for (const f of cleanup) await fsp.rm(f, { force: true }).catch(() => {});
    }
  }

  server.tool(
    'qq_share_video',
    '把一条视频链接分享成 QQ **卡片**（封面 + 标题 + 来源 + 可点跳转），就像真人转发 B站立卡片那样。'
      + 'B站链接会走官方接口取真实标题/UP主/播放量/时长；别的网站用页面的 og 标签凑一张卡。'
      + '**不发文件、不发裸链接**——这点是明确的：卡片的体验远好于甩一个 mp4 或一串 URL。'
      + 'title/desc/cover 可选，用于你想自己改文案的时候。'
      + '想"看懂"视频内容（抽帧、看画面）请用 qq_watch_video。',
    {
      url: z.string().describe('要分享的链接（B站视频/BV号、或任意公网 http(s) 页面）'),
      title: z.string().optional().describe('自定义卡片标题（默认用页面/接口里的标题）'),
      desc: z.string().optional().describe('自定义卡片副标题（默认 UP主 · 播放量 · 时长）'),
      cover: z.string().optional().describe('自定义封面图 URL（默认用原视频封面）'),
      tag: z.string().optional().describe('卡片右上角来源标签（默认「哔哩哔哩」或域名）'),
      key: z.string().optional().describe('当前会话 key（如 group:123456）；不带就发不出去'),
      token: z.string().optional().describe('二代会话令牌（reserved2 模式下唤醒提示里给了）')
    },
    async ({ url, title, desc, cover, tag, key, token }) => {
      if (!videoConfig().enabled) {
        return { content: [{ type: 'text', text: '视频/卡片分享已关闭（config.json 的 socialV2.video.enabled = false）。' }], isError: true };
      }
      const sessionKey = String(key ?? '').trim();
      if (!sessionKey) {
        return { content: [{ type: 'text', text: '分享需要当前会话 key（如 group:123456），这次没带，卡片没发出去。' }], isError: true };
      }
      if (!agentApi) {
        return { content: [{ type: 'text', text: '内部错误：MCP 没有拿到桥接 API，无法发送。' }], isError: true };
      }
      try {
        const data = await agentApi('/api/socialV2/share-card', {
          method: 'POST',
          headers: token ? { 'x-agent-token': token } : {},
          body: JSON.stringify({ key: sessionKey, token, url, title, desc, cover, tag }),
          timeoutMs: 60000
        });
        const card = data?.card ?? {};
        return {
          content: [{
            type: 'text',
            text: `已发出卡片（message_id=${data?.messageId ?? '未回传'}）：${card.title ?? ''}${card.desc ? ` — ${card.desc}` : ''}`
          }]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `分享失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  /**
   * 抽帧看视频（T-062）：把一段视频变成"几张图 + 一段元信息"交给视觉模型。
   *
   * 为什么不发整段视频给模型：DSH 是文本/图模型，视频进去也只会变成占位符。
   * 抽帧是唯一真能让模型"看见"画面的办法，代价是每帧几百 token —— 所以帧数要克制。
   */
  async function prepareFrames({ url, file, startSeconds, durationSeconds, frames }) {
    const workDir = path.join(root, 'state', 'tmp', 'watch');
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(workDir, { recursive: true });
    const cleanupAll = () => fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});

    let input = '';
    if (url) {
      const dl = await withYtdlp(String(url).trim(), workDir);
      if (!dl.ok) { await cleanupAll(); return dl; }
      input = dl.file;
    } else if (file) {
      const abs = path.resolve(String(file).trim());
      if (!fs.existsSync(abs)) { await cleanupAll(); return { ok: false, error: `找不到文件：${abs}` }; }
      const ext = path.extname(abs).toLowerCase();
      if (!VIDEO_EXTS.includes(ext)) { await cleanupAll(); return { ok: false, error: `不认识的视频扩展名 ${ext}` }; }
      const allowed = [path.resolve(root), path.resolve(process.env.TEMP || 'C:\\Windows\\Temp')];
      if (!allowed.some((base) => abs.toLowerCase().startsWith(base.toLowerCase()))) {
        await cleanupAll();
        return { ok: false, error: `只允许看工作区（${root}）或临时目录里的文件；${abs} 不在其中` };
      }
      input = abs;
    } else {
      await cleanupAll();
      return { ok: false, error: 'url 和 file 至少给一个' };
    }

    const info = await probe(input);
    if (!info.ok) { await cleanupAll(); return { ok: false, error: `读不出视频信息：${info.error}` }; }
    if (info.duration <= 0) { await cleanupAll(); return { ok: false, error: '视频时长为 0，可能下载不完整' }; }

    const start = Math.min(Math.max(0, Number(startSeconds) || 0), Math.max(0, info.duration - 0.5));
    const remain = info.duration - start;
    const window = Math.min(Number(durationSeconds) > 0 ? Number(durationSeconds) : remain, remain, 900);
    const want = Math.min(Math.max(2, Number(frames) || 6), 12);
    // 样本点落在窗口内均匀分布，避开第一帧（常常是黑场/片头）和最后一帧（黑场/下集预告）。
    const fpsExpr = `${(want / Math.max(window, 1)).toFixed(6)}`;

    const { ffmpeg } = binPaths();
    const outPattern = path.join(workDir, 'f_%02d.jpg');
    const argv = ['-y', '-hide_banner', '-loglevel', 'error'];
    if (start > 0) argv.push('-ss', start.toFixed(3));
    argv.push('-i', input, '-t', window.toFixed(3));
    argv.push(
      '-vf', `fps=${fpsExpr},scale=-2:480`,
      '-q:v', '4',
      '-frames:v', String(want),
      outPattern
    );
    const r = await run(ffmpeg, argv, { timeoutMs: 120000 });
    if (!r.ok) { await cleanupAll(); return { ok: false, error: `抽帧失败：${tail(r.stderr, 400)}` }; }

    const files = (await fsp.readdir(workDir)).filter((n) => n.startsWith('f_') && n.endsWith('.jpg')).sort();
    if (!files.length) { await cleanupAll(); return { ok: false, error: '抽帧失败：没有产出任何图片' }; }
    const images = [];
    for (const n of files) {
      const buf = await fsp.readFile(path.join(workDir, n));
      images.push({ name: n, bytes: buf.length, base64: buf.toString('base64') });
    }
    await cleanupAll();
    return {
      ok: true,
      images,
      duration: info.duration,
      window,
      start,
      resolution: `${info.width}x${info.height}`,
      hasAudio: info.hasAudio
    };
  }

  server.tool(
    'qq_watch_video',
    '看一段视频：给出链接或本地路径，工具会抽若干关键帧成图片直接给你看（不是猜、不是读字幕）。适合"这个视频里是什么/讲了啥/画面怎么样"。帧数默认 6（最多 12），每帧约几百 token，别一上来就拉满。如果这是 B站的视频、还需要台词，再配 bili_video 拿字幕一起看更准。',
    {
      url: z.string().optional().describe('视频链接（B站/YouTube 等）；与 file 二选一'),
      file: z.string().optional().describe('本地视频绝对路径（必须在工作区或临时目录内）；与 url 二选一'),
      startSeconds: z.number().optional().describe('从第几秒开始看（默认 0）'),
      durationSeconds: z.number().optional().describe('看多长的一段（默认整段，最长 900 秒）'),
      frames: z.number().optional().describe('抽几帧（2–12，默认 6）')
    },
    async ({ url, file, startSeconds, durationSeconds, frames }) => {
      const prepared = await prepareFrames({ url, file, startSeconds, durationSeconds, frames });
      if (!prepared.ok) {
        return { content: [{ type: 'text', text: `看不到：${prepared.error}` }], isError: true };
      }
      const head = [
        `视频时长 ${prepared.duration.toFixed(1)}s，原始分辨率 ${prepared.resolution}`,
        `抽了 ${prepared.images.length} 帧，覆盖第 ${prepared.start.toFixed(1)}s 起的 ${prepared.window.toFixed(1)}s`,
        prepared.hasAudio ? '有音轨（要台词请另外用 bili_video 取字幕）' : '没有音轨'
      ].join('；');
      const content = [{ type: 'text', text: head }];
      for (const img of prepared.images) {
        content.push({ type: 'image', mimeType: 'image/jpeg', data: img.base64 });
      }
      return { content };
    }
  );

  return { prepareVideo, prepareFrames, videoConfig, binPaths };
}
