import { mkdirSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function createLogger(directory = 'logs') {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true });
  let lastDay;
  // `detail` is optional structured metadata — a label, a path, a reason string.
  // Only a plain object is accepted: strings, numbers and arrays are dropped on
  // purpose, because that is what a caller would pass while trying to log a chat
  // message, and the `/^[a-z_]+$/` guard below only ever sees the event name. It
  // is a boundary, not a formality — see docs/security.md §3.3.
  return (event, detail) => {
    if (!/^[a-z_]+$/.test(event)) return;
    const time = new Date().toISOString();
    const day = time.slice(0, 10);
    if (day !== lastDay) {
      const cutoff = new Date(Date.parse(time) - 6 * 86400000).toISOString().slice(0, 10);
      for (const file of readdirSync(root)) {
        if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) < cutoff) unlinkSync(join(root, file));
      }
      lastDay = day;
    }
    const record = { time, event };
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) record.detail = detail;
    const line = JSON.stringify(record);
    console.log(line);
    try { appendFileSync(join(root, `${time.slice(0, 10)}.jsonl`), line + '\n'); }
    catch { console.error('log_write_failed'); }
  };
}
