// 唱歌（T-062）：qq_sing 一个工具。
//
// 为什么单独一个模块：mcp-snowluma-safe.js 已经 2500 行，而"唱歌"这件事的做法全在桥接里
// （音节合成、ffmpeg 变调、按拍拼接、额度与闸门）。MCP 侧只需要一个参数表和一次 HTTP 调用，
// 塞回去只会让那个文件更难读。注册方式与 video-tools / device-tools 一致：registerXxxTools(server, opts)。
//
// 与桥接的分工（别破坏这条）：
// - 本模块**不**碰 TTS、不碰 ffmpeg、不落盘，也不自己拼音频 —— 一律 POST /api/socialV2/sing；
// - "能不能发"只有桥接一处判定（token / 范围 / 静默模式 / 语音库额度 / 工具开关）。
//   在这里补任何放行逻辑，都会变成绕过闸门的第二条路。
import { z } from 'zod';

/** 与桥接 singCfg().maxLyricsChars 对齐：这里先挡一次，省一次往返。 */
const MAX_LYRICS_CHARS = 80;

export function registerSongTools(server, opts = {}) {
  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => ({});
  const agentApi = typeof opts.agentApi === 'function' ? opts.agentApi : null;
  // 注意：不收 opts.root —— 本模块不落盘，产物由桥接写进语音库。

  function singEnabled() {
    const cfg = getConfig() || {};
    return !(cfg.socialV2?.sing?.enabled === false || cfg.socialV2?.voice?.enabled === false);
  }

  server.tool(
    'qq_sing',
    '唱一句歌，合成成 QQ 语音条发到**当前会话**。'
      + '用法：song 给内置曲名（小星星 / 生日快乐 / 两只老虎），或者 notes 自己写旋律（"C4:1 D4:1 E4:2 R:1"，音名:拍数，R 是休止符，省略拍数=1 拍）。'
      + '歌词可选：中文按**一个字一个音**切，英文按空格切；字数不够会自动补「啦」，所以只唱副歌那一句就直接给几个字。'
      + `歌词必须单行、≤${MAX_LYRICS_CHARS} 字（超了会直接报错，不会截断）。`
      + '唱法是「把一个字的读音变调后按拍子拼起来」，是抖音那种变调人声，不是真人演唱；音准是精确的半音，不是随便升调。'
      + '⚠️ 音节会发给微软的 TTS 端点合成（edge-tts），别把密码/密钥/本机路径当歌词唱；也别念群友隐私。'
      + '一首歌要跑十几次合成，比较慢（十几秒），一次只唱一首；失败就改发文字或改成更短的旋律，别连着重试。'
      + '语音库有频率/时长上限，超了会被桥接拒绝（返回里会说明原因）。',
    {
      key: z.string().describe('当前会话 key（如 group:123456 或 private:10001）—— 只能发到这个会话，不能指定别人的'),
      token: z.string().describe('二代会话令牌（reserved2 模式唤醒提示里给的那个，没有它桥接会直接 403）'),
      song: z.string().optional().describe('内置曲名：小星星 / 生日快乐 / 两只老虎（也可以用 xiaoxingxing 这类 id）'),
      notes: z.string().optional().describe('自定义旋律，如 "C4:1 D4:1 E4:1 G4:2 R:1"；给了 notes 就优先用它，忽略 song'),
      lyrics: z.string().optional().describe('歌词（单行、≤80 字）；不给就用内置歌词，自定义旋律不给词就全唱「啦」'),
      bpm: z.number().optional().describe('速度（拍/分钟，30–240）。默认内置曲目自带的速度，自定义旋律默认 100'),
      voice: z.string().optional().describe('音色：mandarin（默认）/ xiaoxiao / cantonese；也可以直接写 晓依 / 晓晓 / 曉曼'),
      rate: z.number().optional().describe('v1 不生效（拍长由 bpm 决定，变调只为音准）；传了会在返回里提示一句，别指望它变快变慢')
    },
    async ({ key, token, song, notes, lyrics, bpm, voice, rate }) => {
      if (!singEnabled()) {
        return { content: [{ type: 'text', text: '唱歌已关闭（config.json 里 socialV2.voice.enabled 或 socialV2.sing.enabled 是 false）。' }], isError: true };
      }
      const sessionKey = String(key ?? '').trim();
      if (!sessionKey) {
        return { content: [{ type: 'text', text: '唱歌需要当前会话 key（如 group:123456），这次没带，什么都没发出去。' }], isError: true };
      }
      if (!String(token ?? '').trim()) {
        return { content: [{ type: 'text', text: '缺少二代会话令牌 token：reserved2 模式下没有它桥接会直接拒绝（403），请用唤醒提示里给的那个。' }], isError: true };
      }
      if (!agentApi) {
        return { content: [{ type: 'text', text: '内部错误：MCP 没有拿到桥接 API，无法合成。' }], isError: true };
      }
      const lyricText = String(lyrics ?? '').replace(/[\r\n]+/g, ' ').trim();
      // 本地先挡一次超长：桥接也会挡，但那要跑完一次 HTTP 才报错。
      if ([...lyricText].length > MAX_LYRICS_CHARS) {
        return {
          content: [{ type: 'text', text: `歌词太长（${[...lyricText].length} 字，上限 ${MAX_LYRICS_CHARS} 字）：唱一句短的，或者干脆不给 lyrics（缺的音节会补「啦」）。` }],
          isError: true
        };
      }
      // notes 允许传数组（模型有时会写成 ["C4:1","D4:1"]）；统一成空格分隔的旋律串。
      const melody = Array.isArray(notes) ? notes.join(' ') : String(notes ?? '');
      if (!String(song ?? '').trim() && !melody.trim()) {
        return { content: [{ type: 'text', text: '要么给 song（内置曲名），要么给 notes（旋律），两个都空就没法唱。' }], isError: true };
      }
      try {
        const data = await agentApi('/api/socialV2/sing', {
          method: 'POST',
          headers: { 'x-agent-token': String(token).trim() },
          body: JSON.stringify({
            key: sessionKey,
            token: String(token).trim(),
            song,
            notes: melody,
            lyrics: lyricText,
            bpm,
            voice
          }),
          // 一首歌 = 十几次 edge-tts + 几十次 ffmpeg，比 qq_speak 慢一个数量级；
          // 给到 180 秒，避免桥接还在唱、客户端先超时（那样模型会以为失败又点一次）。
          timeoutMs: 180000
        });
        const title = data?.source?.title ?? '自定义旋律';
        const seconds = Number(data?.seconds ?? 0);
        const lines = [
          `唱完了：《${title}》，${seconds.toFixed(1)} 秒，${data?.segments ?? '?'} 段 / ${data?.syllables ?? '?'} 个音节（音色 ${data?.voice ?? '?'}）。`,
          `计划时长 ${Number(data?.plannedSeconds ?? 0).toFixed(1)} 秒，语音文件名 ${data?.file ?? '未回传'}，message_id=${data?.messageId ?? '未回传'}，verified=${data?.verified === true ? 'true' : 'false'}。`
        ];
        if (data?.verified !== true) {
          // 回读失败不等于没发出去（网关有时不回 record 段），但不能据此对用户断言"已经发了"。
          lines.push('没拿到语音消息回读：多半是发出去了但网关没回传 record 段，不要重复发送，也别对用户断言"已经发了"。');
        }
        if (Number(rate) !== 0 && Number.isFinite(Number(rate))) {
          lines.push('rate 在 v1 里不生效：音高靠 ffmpeg 变调、拍长靠 bpm，想快就把 bpm 调大。');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        // 桥接在非 2xx 与 ok:false 时都会抛出带 reason/status 的错误，按原因给可操作的说明。
        const reason = error?.reason ?? '';
        const status = Number(error?.status ?? 0);
        const detail = String(error?.message ?? error);
        const hint = reason === 'budget'
          ? '语音发得太勤了，等一会儿再唱。'
          : reason === 'tool'
            ? '桥接里 qq_sing 这个工具被关掉了（socialV2.tools.sing = false），别重试。'
            : status === 403
              ? '桥接拒绝了：token 不对/目标不在允许范围/静默模式开着，换参数重试也没用，跟对方改发文字。'
              : reason === 'tts_unavailable'
                ? '这台机器这会儿合成不了（edge-tts 不可用），改发文字。'
                : reason === 'bad_args'
                  ? '旋律或歌词有问题，按提示改参数再唱一次。'
                  : '';
        return { content: [{ type: 'text', text: `没唱成：${detail}${hint ? `（${hint}）` : ''}` }], isError: true };
      }
    }
  );
}
