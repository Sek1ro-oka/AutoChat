// 情绪宣泄文案的三件纯函数工具（T-012 第五步）：清洗模型输出 / 拼一次性文案提示词 /
// 保守兜底模板。为什么单独一个文件：bridge.js 已经一万三千行，而这三件事都是
// 「输入输出用眼睛就能核对」的字符串变换，放进纯函数模块才能单测
// （scripts/test-affect-text.mjs），也才不会为了改一句模板而重启桥接。
//
// 三条硬约束（与 affect-core.js / affect-vent.js 相同）：
//   1. **纯函数**：不碰 IO、不读系统时钟、不用 Math.random —— 同样的入参永远同样的输出；
//   2. **永不抛**：任何脏输入（null / 数字 / 超长 / 控制字符 / 全空白）都回落成一个可用的字符串；
//   3. **不重写闸门**：字数上下限、禁用符号、去重这些**判定**仍然只由
//      affect-vent.checkVentText 说了算，这里只负责「尽量产出能过闸门的文本」。
//      兜底模板自己保证过闸门（test-affect-text.mjs 里四情绪 × 三通道逐条验）。
//
// 为什么提示词里**不出现**「模型 / 设置 / 数值」之外的元词：这段字符串会直接变成
// 模型的输入，而输出会发到 QQ 空间给人看。提示词自身必须干净（不含技术词、不含
// 任何 URL 或 @），输出的正文也必须在 rules 里被明确要求「只写感受、不写机制」。

import { AFFECT_EMOTIONS } from './affect-core.js';
// 档位阶梯只有 affect-vent.js 一份（0.25 / 0.5 / 0.75 / 1），这里复用而不是抄一遍：
// 抄一份的下场是「面板显示 0.75、提示词按 0.5 写」，而且改了一处忘了另一处。
import { VENT_STEPS } from './affect-vent.js';

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 四个情绪的中文名（与 bridge 的 AFFECT_LABELS 同口径，但这里不依赖 bridge）。 */
export const AFFECT_TEXT_LABELS = Object.freeze({
  anger: '生气',
  sadness: '难过',
  joy: '开心',
  boredom: '无聊'
});

/** 各出口的默认字数上限：qzone 与 affect-vent 的 TEXT_RULES.qzone.max 对齐。 */
export const AFFECT_TEXT_MAX_CHARS = Object.freeze({ qzone: 300, private: 120, diary: 300 });

/**
 * 档位的中文口气：档位是给模型的**粗指令**（research §2.1 的四档），
 * 数值模型未必理解，所以每一档都配一句人话。键必须覆盖 VENT_STEPS。
 */
const STEP_HINTS = Object.freeze({
  0.25: '还压得住，只是心里有点动静',
  0.5: '已经明显了，想找个地方说一句',
  0.75: '有点忍不住了，不说出来会憋得难受',
  1: '快溢出来了，非说不可'
});

/** 出口的中文叫法：提示词第一行直接说「写一条说说 / 说一句话 / 写一段日记」。 */
const CHANNEL_HINTS = Object.freeze({
  qzone: '在 QQ 空间发一条说说',
  private: '在私聊里说一句',
  diary: '写一段只给自己看的日记'
});

// 模型爱加的包装，全部按「反复剥到稳定」处理（最多 4 轮，避免死循环）：
// 「说说：」「正文：」这类前缀、外面套的引号、行首的 markdown 记号。
const PREFIX_RE = /^(?:说说|文案|正文|内容|结果|输出|回答|句子|一条说说)\s*[:：]\s*/;
const LEAD_MARK_RE = /^[*#>~\-—–\s]+/;
const EDGE_EMPHASIS_RE = /^[*_]+|[*_]+$/g;

/** 成对引号：只有**两端都成套**才剥（正文里的中文引号是内容，不能动）。 */
const QUOTE_PAIRS = Object.freeze([
  ['"', '"'],
  ['“', '”'],
  ["'", "'"],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
  ['`', '`']
]);

// ── 小工具（纯函数） ────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 剥掉两端成套的引号；不成套（只有左边）就不动，免得把正文的开引号吃掉。 */
function stripOuterQuotes(text) {
  let out = text;
  let changed = true;
  while (changed && out.length >= 2) {
    changed = false;
    for (const [open, close] of QUOTE_PAIRS) {
      if (out.length > open.length + close.length && out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(open.length, out.length - close.length).trim();
        changed = true;
      }
    }
  }
  return out;
}

/** 把任意档位钳到 VENT_STEPS 里最接近的一档（坏值给 0.5，永不抛）。 */
function nearestStep(step) {
  const numeric = typeof step === 'number' ? step : Number.parseFloat(String(step ?? ''));
  if (!Number.isFinite(numeric)) return 0.5;
  let best = VENT_STEPS[0];
  let bestGap = Math.abs(numeric - best);
  for (const candidate of VENT_STEPS) {
    const gap = Math.abs(numeric - candidate);
    if (gap < bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

/** 字数上限：坏值回落该出口的默认值，并至少留 1 个字的空间。 */
function normalizeMaxChars(maxChars, channel) {
  const numeric = typeof maxChars === 'number' ? maxChars : Number.parseFloat(String(maxChars ?? ''));
  const fallback = AFFECT_TEXT_MAX_CHARS[channel] ?? AFFECT_TEXT_MAX_CHARS.qzone;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.trunc(numeric));
}

/** 归一情绪键：认不出就当「无聊」（无聊的模板最中性，发错了也不扎人）。 */
function normalizeEmotion(emotion) {
  return AFFECT_EMOTIONS.includes(emotion) ? emotion : 'boredom';
}

/** 归一出口：认不出当 qzone（字数区间最宽的那个）。 */
function normalizeChannel(channel) {
  return Object.hasOwn(CHANNEL_HINTS, channel) ? channel : 'qzone';
}

// ── ① 清洗模型输出 ──────────────────────────────────────────────────────────

/**
 * 把模型吐出来的那坨东西压成一句能发的正文。
 *
 * 处理顺序（顺序本身是有原因的）：
 *   ① 去代码块围栏与行内反引号 —— 模型经常把正文包在 ``` 里；
 *   ② **先**把空白全压平（\r\n、制表、全角空格、连续换行 → 一个半角空格），
 *      这样后面所有「^ 开头」的规则都不用再考虑换行；
 *   ③ 反复剥：前缀「说说：」→ 行首 markdown 记号 → 两端成套引号 → 两端粗体记号，
 *      直到稳定（最多 4 轮）。模型常见组合是「「说说：正文」」，一轮剥不干净。
 *
 * **保留中文标点**：，。！？、；：和「」都不动 —— 它们是正文的语气，不是包装。
 * 空串 / 纯空白 / 纯标点由调用方（checkVentText）判 empty，这里只负责返回 ''。
 *
 * @param {unknown} raw 模型输出（也可能来自人工输入）
 * @returns {string} 清洗后的正文（可能为 ''）
 */
export function cleanVentText(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  let text = raw;
  // ① 代码块围栏：```js / ``` 都干掉，围栏后的换行由下一步的压空白吃掉
  text = text.replace(/```[^\n]*/g, '');
  text = text.replace(/`+/g, '');
  // ② 压平空白：含全角空格与不换行空格（\s 在 JS 里已覆盖 \u00a0 / \u3000 之外的部分，
  //    这里显式补上全角空格，中文输入法下很常见）
  text = text.replace(/[\s\u3000]+/g, ' ').trim();
  if (text === '') return '';
  // ③ 反复剥包装
  for (let guard = 0; guard < 4; guard += 1) {
    const before = text;
    text = text.replace(PREFIX_RE, '').trim();
    text = text.replace(LEAD_MARK_RE, '').trim();
    text = stripOuterQuotes(text).trim();
    text = text.replace(EDGE_EMPHASIS_RE, '').trim();
    if (text === before) break;
  }
  return text;
}

// ── ② 拼提示词 ──────────────────────────────────────────────────────────────

/**
 * 拼「写一条宣泄文案」的中文提示词（一次性的，会话里不保留上下文）。
 *
 * 硬要求（dev-doc §7 / research §3「提示词注入」）全部写进正文：
 *   第一人称、像随口说的一句心里话、只输出正文、不解释、不 @ 人、
 *   不复述聊天原文、不点名任何真实的人、不超过 maxChars 字。
 *
 * 注意：提示词**本身**也不写技术名词（不写模型/参数/判定这类元信息），
 * 免得模型顺着它把机制写进正文。
 *
 * @param {object} input
 * @param {string} [input.emotion]     情绪键（anger/sadness/joy/boredom）
 * @param {string} [input.label]       情绪中文名（不传则用内置标签表）
 * @param {number} [input.intensity]   0–1 的强度（只用于说明「有多满」）
 * @param {number} [input.step]        档位（会钳到 VENT_STEPS 里最近的一档）
 * @param {string} [input.causeSummary] 事件摘要（≤60 字，来自 affect-core 的上报）
 * @param {string} [input.channel]     出口（qzone/private/diary）
 * @param {number} [input.maxChars]    字数上限
 * @returns {string} 提示词（永不抛，永不返回空串）
 */
export function buildVentPrompt({ emotion, label, intensity, step, causeSummary, channel, maxChars } = {}) {
  const key = normalizeEmotion(emotion);
  const channelKey = normalizeChannel(channel);
  const name = typeof label === 'string' && label.trim() !== '' ? label.trim() : AFFECT_TEXT_LABELS[key];
  const level = nearestStep(step);
  const hint = STEP_HINTS[level] ?? STEP_HINTS[0.5];
  const limit = normalizeMaxChars(maxChars, channelKey);
  const intensityText = typeof intensity === 'number' && Number.isFinite(intensity)
    ? `（大约 ${Math.min(1, Math.max(0, intensity)).toFixed(2)}）`
    : '';
  const cause = typeof causeSummary === 'string' ? causeSummary.trim().slice(0, 60) : '';

  const lines = [];
  lines.push(`现在心里是「${name}」${intensityText}，档位 ${level}/1：${hint}。`);
  lines.push(`请${CHANNEL_HINTS[channelKey]}，用第一人称，像随口对自己说的一句心里话。`);
  if (cause !== '') {
    // 摘要只是「由头」，不是要复述的内容 —— 这一句必须说清楚，否则模型会把摘要抄进正文
    lines.push(`下面这条只是提示你「因为什么」在说这句话，不要照抄：${cause}`);
  }
  lines.push('');
  lines.push('要求：');
  lines.push('1. 只输出正文本身：不要引号、不要标题、不要任何解释或说明；');
  lines.push('2. 不要出现任何技术类词汇或机制说明（程序、设置、参数、打分标准之类的都不要写）；');
  lines.push('3. 不要 @ 任何人，不要贴聊天记录原文，也不要复述别人说过的话；');
  lines.push('4. 不要点名任何真实的人（姓名、昵称、账号都不写），只写自己的感受；');
  lines.push('5. 不要说教，不要喊口号，不要连用感叹号；');
  lines.push(`6. 最多 ${limit} 字，越短越好，一句话就够。`);
  return lines.join('\n');
}

// ── ③ 兜底模板 ──────────────────────────────────────────────────────────────

/**
 * 兜底模板：模型超时 / 报错 / 返回空时用它顶上。
 *
 * 每一条都自己满足对应出口的质量闸门（qzone ≥15 字、private ≥5 字、diary ≥100 字；
 * 不含 @、URL、长数字串，感叹号与问号各不超过 3 个，没有 5 个以上连续相同字符）。
 * 语气刻意保守：不指责任何人、不点具体事件 —— 模板句是「说不出话时的最小表达」，
 * 它不该比模型写得更具体，否则一旦退化就成了每天都在重复的同一句话。
 */
const FALLBACK_TEXTS = Object.freeze({
  anger: Object.freeze({
    qzone: '今天火气有点大，先在这儿放一放，不针对谁，也不打算跟谁较劲。',
    private: '有点上头，先不说话。',
    diary: '今天火气来得有点快，事情本身不大，是那种被人硬顶着说话的不舒服。写下来是想让自己先慢一点：先把话咽回去，别把火气甩到谁身上，也别拿别人的态度惩罚自己。等这股劲过去再看，多半没那么严重。先喝口水，晚点再说，明天起来又是新的一天。'
  }),
  sadness: Object.freeze({
    qzone: '心里有点空，先安静一会儿，明天再看。',
    private: '今天有点沉，想一个人待会儿。',
    diary: '今天有点沉，说不上具体是哪件事，就是提不起劲。写下来是想告诉自己：难受不用急着解释，也不用立刻好起来。先把手边最轻的事做掉，剩下的明天再说。有人陪着的时候不必硬撑，不想说话就少说两句，没人会因此觉得你不好。'
  }),
  joy: Object.freeze({
    qzone: '今天心情挺好，随手记一句，留着以后翻。',
    private: '今天挺开心。',
    diary: '今天心情不错，说不上什么大事，就是一些小的顺利凑在一起，让人想多走两步路。趁着这股劲把攒着的事做掉一点，也别忘了这份轻快是从哪儿来的。开心不用藏着，想笑就笑，想分享就找个人说一句。记在这儿，是怕过几天忘了今天其实挺好的。'
  }),
  boredom: Object.freeze({
    qzone: '有点无聊，坐着发会儿呆，看看一会儿会不会有别的念头冒出来。',
    private: '有点闲，发会儿呆。',
    diary: '今天有点闲，手边的事拖了又拖，坐着刷了会儿手机也说不上有多开心。无聊的时候容易乱想，写下来算是给自己找点事做。等下起来走两圈，或者找一件十分钟能做完的小事做掉，心里大概就不那么空了。反正时间还长，不急这一会儿。'
  })
});

/** 情绪与出口都认不出时用的中性句（同样按出口的字数区间各备一条）。 */
const NEUTRAL_TEXTS = Object.freeze({
  qzone: '说不上来是什么感觉，先写一句放这儿。',
  private: '发会儿呆。',
  diary: '说不上来是什么感觉，就是心里有点动静，坐了一会儿也没想明白。写下来算是给自己留个记录：今天大概不算顺利，但也没到需要担心的地步。等有空了再回头看看，也许能看出点线索。现在先去倒杯水，把窗口开一会儿。'
});

/**
 * 取一条保守模板句。
 *
 * 三级回退，保证**永远不会**返回空串：情绪+出口 → 该情绪的输出没配 → 中性句（按出口）
 * → qzone 的中性句。坏入参（undefined / 拼错 / 大小写不对）都走这条链。
 *
 * @param {string} emotion 情绪键
 * @param {string} channel 出口（qzone/private/diary）
 * @returns {string} 非空模板句
 */
export function pickFallbackText(emotion, channel) {
  const channelKey = normalizeChannel(channel);
  const byEmotion = FALLBACK_TEXTS[normalizeEmotion(emotion)];
  const picked = byEmotion?.[channelKey];
  if (typeof picked === 'string' && picked !== '') return picked;
  return NEUTRAL_TEXTS[channelKey] ?? NEUTRAL_TEXTS.qzone;
}

/** 给 bridge 判「这是个能用的配置对象吗」用；导出是为了让测试能直接验纯函数。 */
export function isVentTextInput(value) {
  return isPlainObject(value);
}
