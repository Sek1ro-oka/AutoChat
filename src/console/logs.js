// Read the append-only event log for the console.
//
// `logs/*.jsonl` never contains chat text or credentials (see `src/logger.js`):
// the event name must match `/^[a-z_]+$/`, and the optional `detail` field only
// accepts a plain object, which is how the hardening failures record the target
// label and the reason. `detail` holds labels, paths and error reasons — never
// message bodies and never keys. The response below still reaches a browser that
// can read it, so the detail is scrubbed here as well: bounded keys, bounded
// scalars, secret-shaped strings replaced. Anything this reader cannot vouch for
// degrades to `null`, and a bad record must never make it throw.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DETAIL_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const DETAIL_KEYS = 8;
const DETAIL_LENGTH = 120;
// The three shapes that actually reach a `detail` through a label, a path or an
// error string. Replacing the whole match keeps the sentence readable while the
// value itself never leaves.
const SECRETS = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|(?:token|key|secret)=[^\s&"'，,]+)/gi;
const HIDDEN = '[已隐去]';

// A scalar the page can print, or `null` when the value is not one. A string is
// trimmed and cut at 120 characters, then scrubbed — scrubbing last means a
// truncated string cannot smuggle an almost-match past the pattern.
function scalar(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null; // objects, arrays, null, undefined
  const text = value.trim();
  const bounded = text.length > DETAIL_LENGTH ? `${text.slice(0, DETAIL_LENGTH)}…` : text;
  return bounded.replace(SECRETS, HIDDEN);
}

// A detail is display metadata, not a payload: keys must look like identifiers,
// sorted so the table keeps a stable column order, at most eight of them.
function scrub(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const out = {};
  for (const key of Object.keys(detail).filter(key => DETAIL_KEY.test(key)).sort().slice(0, DETAIL_KEYS)) {
    const value = scalar(detail[key]);
    if (value !== null) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function detailOf(record) {
  try { return scrub(record.detail); } catch { return null; }
}

export function readLogs(directory = 'logs', limit = 120) {
  const root = resolve(directory);
  let files;
  try {
    files = readdirSync(root).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse();
  } catch { return []; }
  const cap = Math.max(1, Math.min(1000, Number(limit) || 120));
  const out = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; } // skip a half-written trailing line
      if (record && typeof record === 'object' && typeof record.event === 'string') {
        out.push({ time: typeof record.time === 'string' ? record.time : null, event: record.event, detail: detailOf(record) });
      }
      if (out.length >= cap) return out;
    }
  }
  return out;
}
