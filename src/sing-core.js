/**
 * 唱歌（T-062）的纯逻辑：旋律解析 → 逐音符计划 → ffmpeg 片段参数。
 *
 * 为什么单独一个模块：bridge.js 已经 1.9 万行、`main()` 占 86%，
 * 任何能写成纯函数的东西都不该再往里塞。这边只做算术和字符串，
 * 不碰进程、不碰文件系统，可以拿假数据直接单测。
 *
 * 唱法（v1）：不训练模型、不做音频拼接的巫术 ——
 *   每个音节用 edge-tts 合成一次（同音节**缓存复用**），
 *   再用 ffmpeg 的 asetrate 把这个音节的音高搬到目标音上，按拍子截断，最后首尾相接。
 * 这条路的好处：音准是精确的半音（不是"大概高一点"），
 * 而且只依赖已经装好的 edge-tts + ffmpeg，不引入 torch/RVC 那套重依赖。
 * 代价：听起来是"变调的人声"，不是真·演唱；抖音/TikTok 那种效果，别期待 CD 音质。
 */

/** 音名 → 半音（相对 C）。支持 # 和 b 两种写法。 */
const SEMITONE = {
  C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5,
  'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11
};

/** 采样率：跟 edge-tts 产物对齐，省一次重采样。 */
export const SING_SAMPLE_RATE = 44100;

/** 半音范围夹子：超过 ±12 就退化得没法听，也会把 atempo 顶出 [0.5,2]。 */
export const SING_MAX_SEMITONES = 12;

/**
 * "C4" / "c#5" / "Bb3" / "6" → MIDI 号。
 *
 * 纯数字当 MIDI 号（模型有时候会给 60 这种更省 token 的写法）。
 * 认不出返回 null —— 由调用方决定是报错还是当休止符。
 */
export function noteToMidi(token) {
  const raw = String(token ?? '').trim();
  if (!raw) return null;
  if (/^\d{1,3}$/.test(raw)) {
    const n = Number(raw);
    return n >= 0 && n <= 127 ? n : null;
  }
  const m = /^([A-Ga-g][#b]?)(-?\d)$/.exec(raw);
  if (!m) return null;
  const semi = SEMITONE[m[1].toUpperCase()];
  if (semi === undefined) return null;
  const octave = Number(m[2]);
  const midi = (octave + 1) * 12 + semi;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/**
 * 解析旋律串："C4:1 D4:1 E4:2 R:0.5"（音名:拍数，省略拍数默认 1 拍）。
 * 也接受用逗号/空白分隔，方便模型随意。
 *
 * 休止符：R / rest / 0。
 * 容错：单个 token 写错**不抛异常**，落成一条 `invalid` 记录交给上层报错，
 * 因为模型经常会把中文标点混进来，直接抛会让整段作废。
 */
export function parseMelody(spec) {
  const text = String(spec ?? '').trim();
  if (!text) return { notes: [], invalid: [], count: 0 };
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  const notes = [];
  const invalid = [];
  for (const token of tokens) {
    const [nameRaw, beatsRaw] = token.split(':');
    const name = String(nameRaw ?? '').trim();
    let beats = 1;
    if (beatsRaw !== undefined && beatsRaw !== '') {
      const b = Number(beatsRaw);
      if (!Number.isFinite(b) || b <= 0) { invalid.push({ token, why: '拍数不是正数' }); continue; }
      beats = Math.min(8, b);
    }
    if (/^(r|rest|0|-)$/i.test(name)) { notes.push({ midi: null, beats, rest: true, token }); continue; }
    const midi = noteToMidi(name);
    if (midi === null) { invalid.push({ token, why: `认不出的音名「${name}」` }); continue; }
    notes.push({ midi, beats, rest: false, token });
  }
  return { notes, invalid, count: notes.length };
}

/**
 * 歌词 → 音节表。中文按**单字**切（一个汉字一个音，正好对应一个音符），
 * 英文按空白切；都不够时用 "啦" 补齐 —— 补齐比报错友好，
 * 模型给 12 个音 8 个字是常态，不该整首作废。
 */
export function splitSyllables(lyrics, need = 0, { fill = '啦' } = {}) {
  const text = String(lyrics ?? '').replace(/[\r\n]+/g, ' ').trim();
  const out = [];
  if (text) {
    // 先按空白切词，再把含中文的词拆成单字；纯 ASCII 词保持完整（"happy" 不该变 "h a p p y"）。
    for (const word of text.split(/\s+/).filter(Boolean)) {
      if (/[\u4e00-\u9fff]/.test(word)) {
        for (const ch of word) if (ch.trim()) out.push(ch);
      } else {
        out.push(word);
      }
    }
  }
  if (out.length < need) {
    const filler = String(fill ?? '').trim();
    if (!filler) return out.slice(0, need);
    for (let i = out.length; i < need; i += 1) out.push(filler);
  }
  return out.slice(0, need);
}

/** 单个音节的音高比：2^(半音/12)。1 表示原调。 */
export function semitoneRatio(semitones) {
  return Math.pow(2, Number(semitones) / 12);
}

/**
 * 逐个音符算出"该怎么放"。
 *
 * baseMidi 是**合成音的原始音高基准**：edge-tts 念一个汉字大概落在 A3/C4 附近，
 * 拿第一个非休止音的 midi 当中枢最稳（避免整首整体升/降八度听起来很怪），
 * 也可以由调用方指定。
 *
 * 每段输出：{ index, midi, syllable, rest, beats, seconds, semitones, ratio, atempo }
 *   - semitones 已夹到 ±12
 *   - atempo = 1/ratio（asetrate 会连速度一起变，用 atempo 拉回来，音长才对得上拍子）
 */
export function buildPlan({ notes, syllables, bpm = 100, baseMidi = null, maxSeconds = 300 } = {}) {
  const list = Array.isArray(notes) ? notes : [];
  const pace = Number.isFinite(Number(bpm)) && Number(bpm) > 0 ? Math.min(240, Math.max(30, Number(bpm))) : 100;
  const beatSeconds = 60 / pace;
  const firstTone = list.find((n) => !n.rest && Number.isFinite(n.midi));
  // 注意别写成 `Number.isFinite(Number(baseMidi))`：null / '' 会被 Number() 转成 0（是有限数），
  // 于是"没指定基准音"被当成"基准音是 MIDI 0"，整首会被夹到 +12 半音、听起来像被掐住脖子。
  // 所以先判空，再说能不能转数。
  const hasBase = baseMidi !== null && baseMidi !== undefined && String(baseMidi).trim() !== '' && Number.isFinite(Number(baseMidi));
  const base = hasBase ? Number(baseMidi) : (firstTone ? firstTone.midi : 60);
  const syl = Array.isArray(syllables) ? syllables : [];
  const segments = [];
  let elapsed = 0;
  for (let i = 0; i < list.length; i += 1) {
    const note = list[i];
    const seconds = Math.max(0.08, Number(note.beats) * beatSeconds);
    if (elapsed + seconds > maxSeconds && segments.length > 0) break;
    elapsed += seconds;
    if (note.rest) {
      segments.push({
        index: i, midi: null, rest: true, syllable: '', beats: note.beats,
        seconds: Number(seconds.toFixed(3)), semitones: 0, ratio: 1, atempo: 1
      });
      continue;
    }
    const raw = note.midi - base;
    const semitones = Math.max(-SING_MAX_SEMITONES, Math.min(SING_MAX_SEMITONES, raw));
    const ratio = semitoneRatio(semitones);
    segments.push({
      index: i,
      midi: note.midi,
      rest: false,
      syllable: String(syl[i] ?? '').trim() || '啦',
      beats: note.beats,
      seconds: Number(seconds.toFixed(3)),
      semitones,
      ratio: Number(ratio.toFixed(6)),
      atempo: Number((1 / ratio).toFixed(6))
    });
  }
  return {
    bpm: pace,
    beatSeconds: Number(beatSeconds.toFixed(4)),
    baseMidi: base,
    totalSeconds: Number(elapsed.toFixed(3)),
    segments,
    // 去重后的音节表 = 需要合成几次（同音节只合成一次，靠变调复用）
    syllables: [...new Set(segments.filter((s) => !s.rest).map((s) => s.syllable))]
  };
}

/**
 * atempo 只能吃 [0.5, 2]；超出就串两个。
 * ±12 半音正好落在 0.5/2.0 边界上，但夹子被别的路径放宽时这里要兜住。
 */
export function atempoChain(factor) {
  let f = Number(factor);
  if (!Number.isFinite(f) || f <= 0) f = 1;
  const parts = [];
  let guard = 0;
  while (f > 2 && guard < 4) { parts.push(2); f /= 2; guard += 1; }
  while (f < 0.5 && guard < 4) { parts.push(0.5); f /= 0.5; guard += 1; }
  parts.push(Number(f.toFixed(6)));
  return parts.filter((v) => Math.abs(v - 1) > 1e-6);
}

/**
 * 把"一个音节原始音频"变成"这个音高、这个时长"的滤镜串。
 *
 * 顺序有讲究：先 aresample 把源归一，asetrate 把音高和速度一起搬，aresample 再把采样率
 * 拉回 44100（否则播放器会按错误的采样率理解波形），atempo 把速度拉回去，最后按拍子截断。
 *
 * ⚠️ 为什么最前面那条 aresample 不能省：asetrate 是"声明输入采样率"而不是"按倍率移调"，
 * 真正的变调倍数 = 新采样率 / **源**采样率。edge-tts 吐出来的是 24kHz mp3，少了这一步归一，
 * 目标音高会额外乘上 44100/24000 ≈ 1.84，音准整体偏高近一个八度 —— 而单测里
 * 用 44.1k 源跑是正常的，只有真机才炸，属于必须写死在管线里的坑。
 */
export function pitchFilter({ ratio, seconds, sampleRate = SING_SAMPLE_RATE }) {
  const r = Number(ratio) > 0 ? Number(ratio) : 1;
  const parts = [];
  if (Math.abs(r - 1) > 1e-6) {
    parts.push(`aresample=${sampleRate}`);
    parts.push(`asetrate=${Math.round(sampleRate * r)}`);
    parts.push(`aresample=${sampleRate}`);
    for (const f of atempoChain(1 / r)) parts.push(`atempo=${f}`);
  }
  parts.push(`atrim=0:${Number(seconds).toFixed(3)}`);
  parts.push('asetpts=N/SR/TB');
  // 统一成单声道 44.1k PCM，后面 concat 才不会因为参数不一致炸掉
  parts.push(`aformat=sample_fmts=s16:channel_layouts=mono:sample_rates=${sampleRate}`);
  return parts.join(',');
}

/** 静音片段（休止符）用的滤镜串：时长要对，格式要跟别的段一致。 */
export function silenceFilter({ seconds, sampleRate = SING_SAMPLE_RATE }) {
  return [
    `atrim=0:${Number(seconds).toFixed(3)}`,
    'asetpts=N/SR/TB',
    `aformat=sample_fmts=s16:channel_layouts=mono:sample_rates=${sampleRate}`
  ].join(',');
}

/**
 * 内置几首：模型说"唱小星星"就不用自己写 42 个音符。
 * 旋律用主歌第一句，够听出是哪首；歌词按音符数对齐。
 */
export const SONGS = Object.freeze({
  xiaoxingxing: {
    title: '小星星',
    aliases: ['小星星', 'twinkle', 'twinkletwinkle'],
    bpm: 100,
    notes: 'C4:1 C4:1 G4:1 G4:1 A4:1 A4:1 G4:2 F4:1 F4:1 E4:1 E4:1 D4:1 D4:1 C4:2',
    lyrics: '一 闪 一 闪 亮 晶 晶 满 天 都 是 小 星 星'
  },
  shengrikuaile: {
    title: '生日快乐',
    aliases: ['生日快乐', 'happybirthday', 'birthday'],
    bpm: 108,
    notes: 'G4:0.75 G4:0.25 A4:1 G4:1 C5:1 B4:2 G4:0.75 G4:0.25 A4:1 G4:1 D5:1 C5:2',
    lyrics: '祝 你 生 日 快 乐 祝 你 生 日 快 乐'
  },
  liangzhilaohu: {
    title: '两只老虎',
    aliases: ['两只老虎', 'frerejacques', 'twotigers'],
    bpm: 116,
    notes: 'C4:1 D4:1 E4:1 C4:1 C4:1 D4:1 E4:1 C4:1 E4:1 F4:1 G4:2 E4:1 F4:1 G4:2',
    lyrics: '两 只 老 虎 两 只 老 虎 跑 得 快 跑 得 快'
  }
});

/** "小星星" / "xiaoxingxing" / "TWINKLE" → 内置曲目；找不到返回 null。 */
export function findSong(query) {
  const q = String(query ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!q) return null;
  for (const [id, song] of Object.entries(SONGS)) {
    if (id.toLowerCase() === q || song.aliases.some((a) => String(a).toLowerCase().replace(/[\s_-]+/g, '') === q)) {
      return { id, ...song };
    }
  }
  return null;
}

/**
 * 把一次请求归一成 {notes, syllables, bpm, baseMidi, source}。
 * 优先级：notes（自己写的旋律）> song（内置曲目）。
 */
export function resolveSingRequest({ song, notes, lyrics, bpm, baseMidi } = {}) {
  const picked = String(song ?? '').trim() ? findSong(song) : null;
  if (String(song ?? '').trim() && !picked) {
    return { error: `没有内置这首「${song}」；内置的只有：${Object.values(SONGS).map((s) => s.title).join('、')}。要唱别的请直接用 notes 给旋律（例如 "C4:1 D4:1 E4:1"）` };
  }
  const melodyText = String(notes ?? '').trim() || (picked ? picked.notes : '');
  if (!melodyText) return { error: '要么给 notes（旋律，如 "C4:1 D4:1 E4:1"），要么给 song（内置曲目）' };
  const parsed = parseMelody(melodyText);
  if (parsed.invalid.length) {
    return { error: `旋律里有认不出的音：${parsed.invalid.slice(0, 3).map((i) => `${i.token}（${i.why}）`).join('、')}` };
  }
  if (parsed.notes.length === 0) return { error: 'melody 里一个音都没有' };
  if (parsed.notes.length > 200) return { error: `音符太多（${parsed.notes.length} 个，上限 200）` };
  const realNotes = parsed.notes.filter((n) => !n.rest).length;
  const syllables = splitSyllables(String(lyrics ?? '').trim() || (picked ? picked.lyrics : ''), parsed.notes.length);
  const plan = buildPlan({
    notes: parsed.notes,
    syllables,
    bpm: bpm ?? (picked ? picked.bpm : 100),
    baseMidi
  });
  return {
    source: picked ? { kind: 'builtin', id: picked.id, title: picked.title } : { kind: 'custom' },
    plan,
    notes: parsed.notes,
    syllables,
    realNotes
  };
}
