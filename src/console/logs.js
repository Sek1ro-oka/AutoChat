// Read the append-only event log for the console.
//
// `logs/*.jsonl` only ever contains `{ time, event }` records — never chat text
// or credentials (see `src/logger.js`), so exposing the tail here leaks nothing.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
        out.push({ time: typeof record.time === 'string' ? record.time : null, event: record.event });
      }
      if (out.length >= cap) return out;
    }
  }
  return out;
}
