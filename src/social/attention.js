// Relevance scoring: "should this message get a reaction at all?" (V2 · Phase 3)
//
// Pure rules, no model call, no money. This is the whole point of the "rules
// decide *when*, the model decides *what*" split: deciding to stay silent must
// be free, otherwise a chatty group costs as much as a curious one.
//
// Every signal below is deliberately explainable, because the console shows the
// reasons next to the score — a number nobody can argue with is a number nobody
// can tune.

export const WEIGHTS = Object.freeze({
  base: 1,
  reply: 4,        // replies to something we said: we are already in the thread
  name: 3,         // our name / catchphrase appears in the text
  question: 2,     // a question is an invitation
  others: 1,       // talking to someone else, but still a live thread
  activity: 0.5,   // per recent message, capped
  activityCap: 6,
  night: -3,       // 00:00–05:59 China time: people are asleep
  repeat: -8,      // we would only be repeating ourselves
});

export const NIGHT_FROM_HOUR = 0;
export const NIGHT_TO_HOUR = 6;

// A trailing question mark is the strongest cheap signal; the word list covers
// the Chinese questions that never end in one.
const QUESTION_MARK_RE = /[?？]\s*$/u;
const QUESTION_WORDS_RE = /(怎么|为什么|为啥|如何|是不是|能不能|可不可以|有没有|知不知道|哪[个里儿]|多少|几点|谁|干嘛|干啥)/u;

export function isQuestion(text) {
  const value = String(text ?? '');
  return QUESTION_MARK_RE.test(value) || QUESTION_WORDS_RE.test(value);
}

// Whitespace-, punctuation- and case-insensitive form, so "好耶！" and "好耶"
// are the same utterance.
const normalize = text => String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

// True when this text would only repeat something the bot just said. Short
// fragments (< 4 characters) are ignored: "哈" after "哈哈哈" is not repetition,
// it is conversation. Containment is checked both ways because the bot stores
// its bubbles separately but may now answer with the whole line at once.
export function isRepeat(text, recent = []) {
  const key = normalize(text);
  if (key.length < 4) return false;
  return recent.some(item => {
    const other = normalize(item);
    if (other.length < 4) return false;
    return other === key || other.includes(key) || key.includes(other);
  });
}

export function score({
  text = '', mentionedBot = false, repliesBot = false, mentionsOthers = false,
  activity = 0, hour = 12, botNames = [], recentBotTexts = [],
} = {}) {
  const reasons = ['base'];
  // Being addressed is not a score, it is an obligation — but the answering
  // path owns that reply (see engine.js `addressed`), so `force` only means
  // "stop scoring, this message is not ours".
  if (mentionedBot) return { score: 100, force: true, reasons: [...reasons, 'addressed'] };

  let value = WEIGHTS.base;
  const add = (weight, reason) => { value += weight; reasons.push(reason); };

  if (repliesBot) add(WEIGHTS.reply, 'reply');
  if (Array.isArray(botNames) && botNames.some(name => name && text.includes(name))) add(WEIGHTS.name, 'name');
  if (isQuestion(text)) add(WEIGHTS.question, 'question');
  if (mentionsOthers) add(WEIGHTS.others, 'others');
  const active = Math.min(Math.max(0, Number(activity) || 0), WEIGHTS.activityCap);
  if (active > 0) add(active * WEIGHTS.activity, 'activity');
  if (hour >= NIGHT_FROM_HOUR && hour < NIGHT_TO_HOUR) add(WEIGHTS.night, 'night');
  if (isRepeat(text, recentBotTexts)) add(WEIGHTS.repeat, 'repeat');

  return { score: Number(value.toFixed(2)), force: false, reasons };
}
