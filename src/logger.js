import { mkdirSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

// A log file is named after the UTC day (`toISOString().slice(0, 10)`), which is
// a different calendar from the billing day: budgets and counters roll over at
// China time (UTC+8, see src/store.js). A file named 2026-01-02 therefore opens
// at 08:00 Beijing time. Never derive one of those dates from the other.
const MAX_MESSAGE = 300;

// Only the name and a bounded single-line message of a thrown error. A stack
// holds absolute paths and source excerpts, and the error object itself holds
// arbitrary fields — either one could carry a chat message into a log file.
export function errorDetail(error) {
  const name = typeof error?.name === 'string' && error.name ? error.name : 'Error';
  const message = typeof error?.message === 'string' ? error.message : '';
  return { name: name.slice(0, 60), message: message.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE) };
}

export function createLogger(directory = 'logs') {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true });
  let lastDay;
  let invalidWarned = false;

  // `detail` is optional structured metadata: a label, a path, a reason string.
  // Only a plain object is accepted — a string, a number or an array is dropped
  // on purpose, because that is what a caller passes while trying to log a chat
  // message. The `/^[a-z_]+$/` guard only ever sees the event name.
  // It is a boundary, not a formality — see docs/security.md §3.3.
  const write = (event, detail) => {
    const time = new Date().toISOString();
    const day = time.slice(0, 10);
    if (day !== lastDay) {
      const cutoff = new Date(Date.parse(time) - 6 * 86400000).toISOString().slice(0, 10);
      // A file being held by an editor or a `tail` makes unlinkSync throw
      // EPERM/EBUSY on Windows; a log must never break the work it records.
      try {
        for (const file of readdirSync(root)) {
          if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) < cutoff) unlinkSync(join(root, file));
        }
      } catch (error) { console.error('log_rotate_failed', errorDetail(error)); }
      lastDay = day;
    }
    const record = { time, event };
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) record.detail = detail;
    const line = JSON.stringify(record);
    console.log(line);
    try { appendFileSync(join(root, `${time.slice(0, 10)}.jsonl`), line + '\n'); }
    catch (error) { console.error('log_write_failed', errorDetail(error)); }
  };

  return (event, detail) => {
    // An event name that fails the guard is still dropped exactly as before, but
    // the first one leaves a trace: a typo like `slang_import_v2` otherwise looks
    // like a feature that simply never ran. `kind` is the only field — the name
    // itself is caller text and never reaches a log (see docs/security.md §3.3).
    if (!/^[a-z_]+$/.test(event)) {
      if (!invalidWarned) {
        invalidWarned = true;
        write('invalid_event_name', { kind: typeof event });
      }
      return;
    }
    write(event, detail);
  };
}
