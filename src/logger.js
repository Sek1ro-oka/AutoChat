import { mkdirSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function createLogger(directory = 'logs') {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true });
  let lastDay;
  return event => {
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
    const line = JSON.stringify({ time, event });
    console.log(line);
    try { appendFileSync(join(root, `${time.slice(0, 10)}.jsonl`), line + '\n'); }
    catch { console.error('log_write_failed'); }
  };
}
