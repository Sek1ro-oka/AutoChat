// Human-like rendering of a model answer (V2 · Phase 3).
//
// A group member does not answer in one tidy paragraph. They type a short line,
// pause, maybe add a second. This module turns the raw completion into that
// shape and nothing more:
//
//   * strip markdown and stage directions the model likes to add;
//   * split into at most `max` short messages, breaking over-long ones at
//     commas rather than mid-word;
//   * produce a plausible pause in front of each message.
//
// Voice — catchphrases, tone, what the character refuses to say — belongs to the
// persona layer (Phase 2). The renderer never fabricates vocal tics, because a
// randomly appended "喵~" reads as a bot, not as a person.
//
// `random` is injectable so tests can pin the delays.

export const DEFAULT_MIN_DELAY_MS = 900;
export const DEFAULT_MAX_DELAY_MS = 2600;
export const DEFAULT_MAX_CHARS = 60;

// Remove the presentation the model adds out of habit. A bracketed aside at the
// start of a line is narration ("（叹气）这题不难"); the same bracket in the middle
// of a sentence is usually real content, so it is left alone.
export function stripNarration(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*[（(][^）)\n]{0,30}[）)]\s*/gm, '')
    .replace(/^\s*【[^】\n]{0,20}】\s*/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

// Break a piece that is longer than one bubble at natural boundaries.
function breakLong(parts, maxChars) {
  const out = [];
  for (const part of parts) {
    if (part.length <= maxChars) { out.push(part); continue; }
    let buffer = '';
    for (const piece of part.split(/(?<=[，,；;])/u)) {
      if (buffer && (buffer + piece).length > maxChars) { out.push(buffer.trim()); buffer = piece; }
      else buffer += piece;
    }
    if (buffer.trim()) out.push(buffer.trim());
  }
  return out.filter(Boolean);
}

// Keep the sentences separate — a person sends two short bubbles, not one long
// one — and only start merging when there are more pieces than the bubble cap.
function pack(parts, max) {
  if (parts.length <= max) return parts;
  const size = Math.ceil(parts.length / max);
  const out = [];
  for (let index = 0; index < parts.length; index += size) {
    out.push(parts.slice(index, index + size).join(''));
  }
  return out;
}

export function splitSentences(text, { max = 3, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const flat = stripNarration(text).replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  const sentences = flat.split(/(?<=[。！？!?…~～])\s*/u).map(part => part.trim()).filter(Boolean);
  return pack(breakLong(sentences, Math.max(12, maxChars)), Math.max(1, max));
}

// `delays[i]` is the pause to wait for *before* sending `chunks[i]`: the first
// one models reaction time, the rest model typing.
export function render(text, {
  max = 3, maxChars = DEFAULT_MAX_CHARS,
  minDelayMs = DEFAULT_MIN_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS,
  random = Math.random,
} = {}) {
  const chunks = splitSentences(text, { max, maxChars });
  const low = Math.max(0, Number(minDelayMs) || 0);
  const span = Math.max(0, (Number(maxDelayMs) || 0) - low);
  const delays = chunks.map(() => Math.round(low + random() * span));
  return { chunks, delays };
}
