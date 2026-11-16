/**
 * 唱歌（T-062）的离线单测：**不联网、不调 TTS、不跑 ffmpeg**，只测 sing-core 的纯逻辑。
 *
 * 重点保四件已经在真机上踩过或一定会踩的事：
 *   1. 音名解析要认 MIDI 数字、要拒认不出的写法（模型经常写 H4 / C10）；
 *   2. bpm → 拍长 → 总时长必须自洽（成品长度全靠这个数对上，歪一点听起来就抢拍/拖拍）；
 *   3. 半音必须夹在 ±12（超出 atempo 会顶出 [0.5,2]，滤镜直接报错）；
 *   4. pitchFilter 的 asetrate 前面**必须**有一条 aresample：asetrate 是"声明输入采样率"，
 *      变调倍数 = 新采样率 / 源采样率，edge-tts 出来的 24k 源不归一就会整体高出 ~1.84 倍。
 *      这条用 44.1k 源是测不出来的，所以这里对滤镜串做**结构断言**（顺序 + 数值）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SING_MAX_SEMITONES,
  SING_SAMPLE_RATE,
  SONGS,
  atempoChain,
  buildPlan,
  findSong,
  noteToMidi,
  parseMelody,
  pitchFilter,
  resolveSingRequest,
  semitoneRatio,
  silenceFilter,
  splitSyllables
} from '../src/sing-core.js';

test('常量：采样率 44.1k、半音夹子 ±12、内置三首', () => {
  assert.equal(SING_SAMPLE_RATE, 44100);
  assert.equal(SING_MAX_SEMITONES, 12);
  assert.equal(Object.keys(SONGS).length, 3);
});

test('noteToMidi：音名 / 升降号 / 纯数字 MIDI，认不出返回 null', () => {
  assert.equal(noteToMidi('C4'), 60);
  assert.equal(noteToMidi('c#5'), 73);
  assert.equal(noteToMidi('Bb3'), 58);
  assert.equal(noteToMidi('A0'), 21);
  // 纯数字当 MIDI 号：模型有时会觉得写 60 比写 C4 省 token
  assert.equal(noteToMidi('60'), 60);
  assert.equal(noteToMidi('127'), 127);
  // 非法：没八度、字母越界、八度不是一位数、超出 MIDI 范围、空
  assert.equal(noteToMidi('C#'), null);
  assert.equal(noteToMidi('H4'), null);
  assert.equal(noteToMidi('C10'), null);
  assert.equal(noteToMidi('128'), null);
  assert.equal(noteToMidi(''), null);
  assert.equal(noteToMidi(null), null);
});

test('parseMelody：音符/拍数/休止符，坏 token 不抛异常而是进 invalid', () => {
  const parsed = parseMelody('C4:1 D4:1 E4:2 R:0.5');
  assert.equal(parsed.count, 4);
  assert.deepEqual(parsed.invalid, []);
  assert.equal(parsed.notes[0].midi, 60);
  assert.equal(parsed.notes[2].beats, 2);
  assert.equal(parsed.notes[3].rest, true);
  assert.equal(parsed.notes[3].midi, null);

  // 省略拍数 = 1 拍；逗号/分号也能当分隔符（模型常把旋律写成一行 CSV 的样子）
  assert.equal(parseMelody('C4,D4;E4').notes.length, 3);
  assert.equal(parseMelody('C4').notes[0].beats, 1);

  // 四种休止符写法都认
  for (const token of ['R:1', 'rest:1', '0:1', '-:1']) {
    assert.equal(parseMelody(token).notes[0].rest, true, token);
  }

  // 拍数夹到 8：模型写 20 拍会把一首歌唱成念经
  assert.equal(parseMelody('C4:20').notes[0].beats, 8);

  // 坏 token：拍数非正 / 音名认不出 —— 记录原因，等上层统一报错
  const bad = parseMelody('C4:0 H4:1');
  assert.equal(bad.count, 0);
  assert.equal(bad.invalid.length, 2);
  assert.match(bad.invalid[0].why, /拍数/);
  assert.match(bad.invalid[1].why, /认不出的音名/);
});

test('splitSyllables：中文按字切、英文按词切、不够补「啦」、多了截掉', () => {
  assert.deepEqual(splitSyllables('一闪一闪', 4), ['一', '闪', '一', '闪']);
  assert.deepEqual(splitSyllables('happy birthday', 2), ['happy', 'birthday']);
  // 一个字一个音；8 个字配 10 个音符就补两个「啦」
  assert.deepEqual(splitSyllables('一二三', 5), ['一', '二', '三', '啦', '啦']);
  // 歌词比音符多：多出来的不唱
  assert.deepEqual(splitSyllables('一二三四五', 3), ['一', '二', '三']);
  assert.deepEqual(splitSyllables('', 2), ['啦', '啦']);
  // 换行不该把音节带进来
  assert.deepEqual(splitSyllables('一\n闪', 2), ['一', '闪']);
});

test('findSong：id / 中文名 / 别名都能找到，找不到返回 null', () => {
  assert.equal(findSong('小星星').id, 'xiaoxingxing');
  assert.equal(findSong('xiaoxingxing').id, 'xiaoxingxing');
  assert.equal(findSong(' TWINKLE ').id, 'xiaoxingxing');
  assert.equal(findSong('happy birthday').id, 'shengrikuaile');
  assert.equal(findSong('两只老虎').id, 'liangzhilaohu');
  assert.equal(findSong('不存在的歌'), null);
  assert.equal(findSong(''), null);
});

test('resolveSingRequest：内置《小星星》—— 14 段、10 个去重音节、9.6 秒', () => {
  const resolved = resolveSingRequest({ song: '小星星' });
  assert.equal(resolved.error, undefined);
  assert.deepEqual(resolved.source, { kind: 'builtin', id: 'xiaoxingxing', title: '小星星' });
  assert.equal(resolved.plan.bpm, 100);
  assert.equal(resolved.plan.beatSeconds, 0.6);
  assert.equal(resolved.plan.segments.length, 14);
  // 16 拍 × 0.6s —— 成品时长要对上这个数（±0.5s 以内才算唱对了拍子）
  assert.equal(resolved.plan.totalSeconds, 9.6);
  assert.equal(resolved.realNotes, 14);
  // 「一 闪 一 闪 亮 晶 晶 满 天 都 是 小 星 星」去重后 10 个：这就是要合成几次 TTS
  assert.deepEqual(resolved.plan.syllables, ['一', '闪', '亮', '晶', '满', '天', '都', '是', '小', '星']);
  // 逐音符的音节表（14 个，含重复）和去重后的合成表（10 个）是两个不同的东西，
  // 别混用：合成次数看 plan.syllables，配词看 syllables。
  assert.equal(resolved.syllables.length, 14);
  assert.equal(new Set(resolved.syllables).size, 10);
});

test('resolveSingRequest：自定义旋律 —— 歌词不足补「啦」，source 记 custom', () => {
  const resolved = resolveSingRequest({ notes: 'C4:1 D4:1 E4:1', lyrics: '你 好' });
  assert.deepEqual(resolved.source, { kind: 'custom' });
  assert.equal(resolved.plan.segments.length, 3);
  assert.deepEqual(resolved.plan.segments.map((s) => s.syllable), ['你', '好', '啦']);
  assert.equal(resolved.plan.baseMidi, 60);
  // 自定义旋律不给 bpm 默认 100
  assert.equal(resolved.plan.bpm, 100);
  // 同时给了 song 和 notes 时，旋律由 notes 决定，但 source 仍记你点的是哪首内置曲
  // （这是既有语义，别改：调用方靠 source 判断"要不要按内置曲的名字回话"）。
  const mixed = resolveSingRequest({ song: '小星星', notes: 'C4:1 D4:1' });
  assert.equal(mixed.source.id, 'xiaoxingxing');
  assert.equal(mixed.plan.segments.length, 2);
});

test('resolveSingRequest：四类错误都给可读原因（不抛异常，交给路由挑状态码）', () => {
  const missing = resolveSingRequest({ song: '七里香' });
  assert.match(missing.error, /没有内置这首/);
  assert.match(missing.error, /小星星/);
  assert.match(resolveSingRequest({ notes: 'C4:1 H4:1' }).error, /认不出的音/);
  assert.match(resolveSingRequest({}).error, /要么给 notes/);
  assert.match(resolveSingRequest({ notes: ',;' }).error, /一个音都没有/);
});

test('buildPlan：bpm → 拍长，段秒数 = 拍数 × 拍长，总时长 = 各段之和', () => {
  const notes = parseMelody('C4:1 D4:2 R:1 E4:0.5').notes;
  const plan = buildPlan({ notes, syllables: ['a', 'b', 'c', 'd'], bpm: 120 });
  assert.equal(plan.bpm, 120);
  assert.equal(plan.beatSeconds, 0.5);
  assert.deepEqual(plan.segments.map((s) => s.seconds), [0.5, 1, 0.5, 0.25]);
  assert.equal(plan.totalSeconds, 2.25);
  // 休止符：没有音节、不变调，但占满时间
  assert.equal(plan.segments[2].rest, true);
  assert.equal(plan.segments[2].syllable, '');
  assert.equal(plan.segments[2].ratio, 1);
  // 短到离谱的拍也要给一个下限，不能出现 0 秒段（ffmpeg 会当成空输入）
  assert.equal(buildPlan({ notes: [{ midi: 60, beats: 0.01, rest: false }], syllables: ['a'], bpm: 240 }).segments[0].seconds, 0.08);
});

test('buildPlan：bpm 夹在 30–240，baseMidi 默认取第一个非休止音', () => {
  const notes = parseMelody('R:1 C4:1 G4:1').notes;
  assert.equal(buildPlan({ notes, syllables: ['', 'a', 'b'], bpm: 5 }).bpm, 30);
  assert.equal(buildPlan({ notes, syllables: ['', 'a', 'b'], bpm: 9999 }).bpm, 240);
  const plan = buildPlan({ notes, syllables: ['', 'a', 'b'], bpm: 60 });
  // 第一个非休止音是 C4 → 它就是"原始音高"，所以原调唱、半音差 0
  assert.equal(plan.baseMidi, 60);
  assert.equal(plan.segments[1].semitones, 0);
  assert.equal(plan.segments[2].semitones, 7);
  // 显式 baseMidi 优先于默认
  assert.equal(buildPlan({ notes, syllables: ['', 'a', 'b'], bpm: 60, baseMidi: 67 }).segments[1].semitones, -7);
});

test('buildPlan：半音夹在 ±12（超出会让 atempo 顶出 [0.5,2]）', () => {
  const notes = parseMelody('C2:1 C7:1').notes; // 相对 C4 分别 -24 / +36 半音
  const plan = buildPlan({ notes, syllables: ['低', '高'], bpm: 100, baseMidi: 60 });
  assert.equal(plan.segments[0].semitones, -SING_MAX_SEMITONES);
  assert.equal(plan.segments[1].semitones, SING_MAX_SEMITONES);
  assert.equal(plan.segments[0].ratio, 0.5);
  assert.equal(plan.segments[1].ratio, 2);
  // ratio 与 atempo 是一对倒数：asetrate 会连速度一起变，atempo 负责拉回来
  for (const seg of plan.segments) assert.ok(Math.abs(seg.ratio * seg.atempo - 1) < 1e-5);
});

test('buildPlan：超过 maxSeconds 就不再往外吐段（长旋律不会跑成 10 分钟）', () => {
  const notes = parseMelody('C4:8 C4:8 C4:8 C4:8').notes; // 每段 4.8 秒（bpm 100）
  const plan = buildPlan({ notes, syllables: ['a', 'b', 'c', 'd'], bpm: 100, maxSeconds: 10 });
  assert.equal(plan.segments.length, 2);
  assert.equal(plan.totalSeconds, 9.6);
});

test('atempoChain：把任意倍率拆成 [0.5, 2] 内的串接', () => {
  assert.deepEqual(atempoChain(1), []);
  assert.deepEqual(atempoChain(0.8), [0.8]);
  assert.deepEqual(atempoChain(2), [2]);
  // 一个八度就落在边界上
  assert.deepEqual(atempoChain(0.5), [0.5]);
  // 超出边界的要串起来：0.25 = 0.5×0.5，4 = 2×2
  assert.deepEqual(atempoChain(0.25), [0.5, 0.5]);
  assert.deepEqual(atempoChain(4), [2, 2]);
  // 非法输入当 1 处理（返回空数组，不往滤镜串里塞 atempo=NaN）
  assert.deepEqual(atempoChain(0), []);
  assert.deepEqual(atempoChain(-2), []);
  assert.deepEqual(atempoChain('x'), []);
});

test('pitchFilter：原调只截断，不动音高', () => {
  const chain = pitchFilter({ ratio: 1, seconds: 0.6 });
  assert.equal(chain, 'atrim=0:0.600,asetpts=N/SR/TB,aformat=sample_fmts=s16:channel_layouts=mono:sample_rates=44100');
  assert.ok(!chain.includes('asetrate'));
});

test('pitchFilter：高八度 = aresample → asetrate ×2 → aresample → atempo 0.5', () => {
  const ratio = semitoneRatio(12); // 2
  const chain = pitchFilter({ ratio, seconds: 1 });
  const parts = chain.split(',');
  // ⚠️ 关键顺序：归一的 aresample 必须在 asetrate 之前，否则 24k 源会整体再高 1.84 倍
  assert.equal(parts[0], `aresample=${SING_SAMPLE_RATE}`);
  assert.equal(parts[1], `asetrate=${SING_SAMPLE_RATE * 2}`);
  assert.equal(parts[2], `aresample=${SING_SAMPLE_RATE}`);
  assert.equal(parts[3], 'atempo=0.5');
  assert.equal(parts[4], 'atrim=0:1.000');
  assert.equal(parts[5], 'asetpts=N/SR/TB');
  assert.match(parts[6], /^aformat=.*sample_rates=44100$/);
});

test('pitchFilter：低八度用 atempo=2 把速度拉回来', () => {
  const chain = pitchFilter({ ratio: semitoneRatio(-12), seconds: 0.5 });
  assert.match(chain, new RegExp(`^aresample=${SING_SAMPLE_RATE},asetrate=${SING_SAMPLE_RATE / 2},`));
  assert.ok(chain.includes('atempo=2'));
  assert.ok(chain.includes('atrim=0:0.500'));
});

test('pitchFilter 与 plan 串接：±3 半音的 atempo 是 1/ratio，且都带时长截断', () => {
  const notes = parseMelody('C4:1 E4:1 G4:1').notes;
  // 基准音取 D4：三个音都不是原调，才测得到 asetrate 那一段
  const plan = buildPlan({ notes, syllables: ['一', '二', '三'], bpm: 120, baseMidi: 62 });
  for (const seg of plan.segments) {
    assert.notEqual(seg.ratio, 1);
    const chain = pitchFilter({ ratio: seg.ratio, seconds: seg.seconds });
    assert.ok(chain.includes(`atrim=0:${seg.seconds.toFixed(3)}`), chain);
    assert.ok(chain.includes(`asetrate=${Math.round(SING_SAMPLE_RATE * seg.ratio)}`), chain);
    const factor = 1 / seg.ratio;
    if (Math.abs(factor - 1) > 1e-6) {
      // atempo 的倍数要和 plan 算出来的 atempo 一致（串接后逐项相等）
      const applied = chain.match(/atempo=([\d.]+)/g).map((m) => Number(m.slice(7)));
      assert.deepEqual(applied, atempoChain(factor));
    }
  }
});

test('silenceFilter：等长静音，不带变调', () => {
  const chain = silenceFilter({ seconds: 1.2 });
  assert.equal(chain, 'atrim=0:1.200,asetpts=N/SR/TB,aformat=sample_fmts=s16:channel_layouts=mono:sample_rates=44100');
  assert.ok(!chain.includes('asetrate'));
  assert.ok(!chain.includes('atempo'));
});
