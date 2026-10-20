// 情绪宣泄文案纯函数（src/affect-text.js）的单测。
//
// 跑法：`node scripts/test-affect-text.mjs`（全过 exit 0，有失败 exit 1）。
//
// 覆盖三组：
//   ① cleanVentText：去代码块围栏 / 去行内反引号 / 剥前缀「说说：」/ 剥两端成套引号 /
//      压平空白（含换行与全角空格）/ **保留中文标点** / 空串与非字符串回落 ''
//   ② buildVentPrompt：含情绪中文名、档位、原因、字数上限；不含「AI」与「阈值」字样；
//      四情绪 × 三出口都能生成非空提示词；超长原因被截断；未知情绪/出口回落
//   ③ pickFallbackText：四情绪 × 三通道都非空、互不相同、且**逐条**过
//      affect-vent.checkVentText（兜底模板自己就是质量合格的正文）
//
// 全部是不带 IO 的纯函数调用：不读 state/、不连网络、不读系统时钟。
import { cleanVentText, buildVentPrompt, pickFallbackText, AFFECT_TEXT_LABELS } from '../src/affect-text.js';
import { checkVentText, VENT_STEPS } from '../src/affect-vent.js';
import { AFFECT_EMOTIONS } from '../src/affect-core.js';

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? `  — ${extra}` : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? `  — ${extra}` : ''}`);
  }
}

const VENT_CHANNELS = ['qzone', 'private', 'diary'];

// ── ① cleanVentText ────────────────────────────────────────────────────────
console.log('① cleanVentText（清洗模型输出）');

check('普通中文正文原样返回', cleanVentText('今天有点烦，先不说话。') === '今天有点烦，先不说话。');
check(
  '保留中文标点（，。！？、「」）',
  cleanVentText('天黑了。先坐一会儿，等一等？「算了」。') === '天黑了。先坐一会儿，等一等？「算了」。'
);

// 代码块：模型经常把正文包在 ``` 里，围栏语言名与换行都要吃掉
const fenced = cleanVentText('```\n今天有点烦。\n```');
check('去代码块围栏（不带语言名）', fenced === '今天有点烦。', JSON.stringify(fenced));
const fencedLang = cleanVentText('```text\n今天有点烦。\n```');
check('去代码块围栏（带语言名）', fencedLang === '今天有点烦。', JSON.stringify(fencedLang));
const inline = cleanVentText('`今天有点烦。`');
check('去行内反引号', inline === '今天有点烦。', JSON.stringify(inline));

// 前缀：反复剥（模型常见「说说：」+ 引号 + 前缀三层包装）
check('剥前缀「说说：」', cleanVentText('说说：今天有点烦。') === '今天有点烦。');
check('剥前缀（全角冒号后带空格）', cleanVentText('说说： 今天有点烦。') === '今天有点烦。');
check('剥前缀「正文：」', cleanVentText('正文：今天有点烦。') === '今天有点烦。');
// 两端成套引号
check('剥两端双引号', cleanVentText('"今天有点烦。"') === '今天有点烦。');
check('剥两端中文引号', cleanVentText('“今天有点烦。”') === '今天有点烦。');
check('剥两端书名号/直角引号', cleanVentText('「今天有点烦。」') === '今天有点烦。');
// 组合包装：引号在外、前缀在内，需要多轮剥
check('拆组合包装（引号 + 前缀）', cleanVentText('「说说：今天有点烦。」') === '今天有点烦。');
// 行首 markdown 记号 + 粗体
check('剥行首列表记号与粗体', cleanVentText('- **今天有点烦。**') === '今天有点烦。');

// 压空白：换行 / 制表 / 全角空格都压成一个半角空格，首尾不留空白
check(
  '压平换行与制表（中文标点不动）',
  cleanVentText('  今天有点烦，\n\t先不说话。  ') === '今天有点烦， 先不说话。',
  JSON.stringify(cleanVentText('  今天有点烦，\n\t先不说话。  '))
);
check('压平全角空格', cleanVentText('今天　有点烦。') === '今天 有点烦。');

// 不成套的引号不能剥（正文里的引号是内容）
check('只有一个左引号时不剥', cleanVentText('「今天有点烦。') === '「今天有点烦。');

// 空 / 脏输入
check('空串 → 空串', cleanVentText('') === '');
check('纯空白 → 空串', cleanVentText('   \n\t  ') === '');
check('null → 空串', cleanVentText(null) === '');
check('数字 → 空串（不做隐式转字符串）', cleanVentText(123) === '');
check('undefined → 空串', cleanVentText(undefined) === '');
check('只有代码块围栏 → 空串', cleanVentText('```js\n```') === '');

// ── ② buildVentPrompt ─────────────────────────────────────────────────────
console.log('② buildVentPrompt（拼提示词）');

const prompt = buildVentPrompt({
  emotion: 'anger',
  label: '生气',
  intensity: 0.81,
  step: 0.75,
  causeSummary: '被当众否定',
  channel: 'qzone',
  maxChars: 240
});
check('提示词非空字符串', typeof prompt === 'string' && prompt.length > 0);
check('含情绪中文名', prompt.includes('生气'));
check('含档位数值', prompt.includes('0.75'));
check('含档位的口气说明', prompt.includes('忍不住'));
check('含原因摘要', prompt.includes('被当众否定'));
check('含字数上限', prompt.includes('240'));
check('说明「只输出正文」', prompt.includes('只输出正文'));
check('说明第一人称', prompt.includes('第一人称'));
check('说明不要 @ 人', prompt.includes('@'));
check('说明不要复述原文', prompt.includes('复述'));
check('**不含**「AI」字样', !/AI/i.test(prompt));
check('**不含**「阈值」字样', !prompt.includes('阈值'));
check('不含 URL', !/https?:\/\//i.test(prompt));

// 不传 label 时用内置标签表；四个情绪都能拼出含正确中文名的提示词
check(
  '按情绪键回落到内置中文标签',
  AFFECT_EMOTIONS.every((key) => buildVentPrompt({ emotion: key, channel: 'qzone' }).includes(AFFECT_TEXT_LABELS[key]))
);
// 每一档都要落在口径里：越高的档位口气越强（只验数值出现，避免把文案写死进测试）
check(
  '四个档位都能出现在提示词里',
  VENT_STEPS.every((step) => buildVentPrompt({ emotion: 'joy', step, channel: 'qzone' }).includes(String(step)))
);
// 坏的档位要钳到最近的一档，不能出现 0.9 这种「不存在的档」
const weirdStep = buildVentPrompt({ emotion: 'joy', step: 0.9, channel: 'qzone' });
check('坏档位钳到 VENT_STEPS 内的值', weirdStep.includes('1/1') || weirdStep.includes('0.75/1'), weirdStep.slice(0, 40));
// 三通道都能拼
check('三个出口都能拼出提示词', VENT_CHANNELS.every((channel) => buildVentPrompt({ emotion: 'sadness', channel }).length > 0));
check('未知出口不抛且非空', buildVentPrompt({ emotion: 'sadness', channel: 'weibo' }).length > 0);
check('未知情绪不抛且非空', buildVentPrompt({ emotion: 'curiosity', channel: 'qzone' }).length > 0);
check('空入参不抛且非空', typeof buildVentPrompt() === 'string' && buildVentPrompt().length > 0);
// 超长原因截断到 60 字（affect-core 的上报口径），不能把整段聊天塞进提示词
const longCause = buildVentPrompt({ emotion: 'anger', channel: 'qzone', causeSummary: '啊'.repeat(200) });
check('超长原因被截断（≤60 字）', (longCause.match(/啊/g) ?? []).length === 60, String((longCause.match(/啊/g) ?? []).length));
check('负向情绪提示词要求不点名真人', prompt.includes('不要点名任何真实的人'));

// ── ③ pickFallbackText ────────────────────────────────────────────────────
console.log('③ pickFallbackText（兜底模板）');

const seen = new Set();
let fallbackAllOk = true;
const fallbackReasons = [];
for (const emotion of AFFECT_EMOTIONS) {
  for (const channel of VENT_CHANNELS) {
    const text = pickFallbackText(emotion, channel);
    const verdict = checkVentText(text, [], channel);
    if (!verdict.ok) {
      fallbackAllOk = false;
      fallbackReasons.push(`${emotion}/${channel}: ${verdict.reasons.join(',')}`);
    }
    if (typeof text !== 'string' || text.trim() === '') {
      fallbackAllOk = false;
      fallbackReasons.push(`${emotion}/${channel}: 空`);
    }
    if (seen.has(text)) {
      fallbackAllOk = false;
      fallbackReasons.push(`${emotion}/${channel}: 与其他组合重复`);
    }
    seen.add(text);
  }
}
check(
  '四情绪 × 三通道：非空、互不相同、且都过 checkVentText',
  fallbackAllOk,
  fallbackReasons.join('；')
);

// 单条再验一遍「不该出现的东西」：模板句是最保守的表达，绝不能带联系方式或 @
let fallbackClean = true;
const dirty = [];
for (const emotion of AFFECT_EMOTIONS) {
  for (const channel of VENT_CHANNELS) {
    const text = pickFallbackText(emotion, channel);
    if (/[A-Za-z0-9]/.test(text) || text.includes('@')) {
      fallbackClean = false;
      dirty.push(`${emotion}/${channel}`);
    }
  }
}
check('模板句不含英数字符与 @', fallbackClean, dirty.join('；'));

// 坏入参：三级回退到中性句，永不返回空串
check('未知情绪回落到中性句', typeof pickFallbackText('curiosity', 'qzone') === 'string' && pickFallbackText('curiosity', 'qzone').length > 0);
check('未知出口回落到 qzone 的中性句', pickFallbackText('anger', 'weibo') === pickFallbackText('anger', 'qzone'));
check('完全空入参也有句子', pickFallbackText().length > 0);

// ── 汇总 ──────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n结果：${passed}/${total} passed${failed > 0 ? `，${failed} failed` : ''}`);
process.exit(failed > 0 ? 1 : 0);
