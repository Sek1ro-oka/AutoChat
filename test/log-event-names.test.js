// Static guard for log event names (I-07 / E-11).
//
// `src/logger.js` silently drops any event whose name fails `/^[a-z_]+$/`, and
// only the first one leaves an `invalid_event_name` trace — a typo like
// `Slang_Imported` therefore looks exactly like a feature that never ran. Event
// names are string literals at every call site, so a scan can catch them before
// the log does.
//
// Known blind spot: this guard only sees *literal* arguments. A template string
// or a variable is invisible to it and always will be; the test prints how many
// such call sites exist as a diagnostic so the gap stays measured rather than
// forgotten. Call sites are deliberately NOT rewritten to make the number zero
// (that is batch 4/5 scope).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = 'src';
const EVENT_NAME_RE = /^[a-z_]+$/;
// Callees that name a log event. `console.log` is excluded on purpose: it takes
// prose, not event names (`src/main.js` prints Chinese sentences through it).
const CALLEE_NAMES = new Set(['log', 'logger']);
const NON_LOGGER_OBJECTS = new Set(['console']);

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out.sort();
}

// Blank out comments and string/template bodies while keeping every offset and
// newline in place, so a `log('…')` written inside prose, a comment or a string
// cannot be mistaken for a call site. String literals are remembered by the
// offset of their opening quote. `${…}` interpolations stay in code state (they
// are real expressions) while the literal text around them is blanked.
function maskSource(source) {
  const masked = [...source];
  const strings = new Map();
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (masked[i] !== '\n') masked[i] = ' ';
  };
  const stack = []; // 'template' | brace depth of a `${ … }` expression
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const top = stack[stack.length - 1];
    if (top === 'template') {
      if (char === '\\') { blank(i, i + 2); i += 2; continue; }
      blank(i, i + 1);
      if (char === '`') stack.pop();
      else if (char === '$' && source[i + 1] === '{') { stack.push(1); i += 2; continue; }
      i += 1;
      continue;
    }
    if (char === '`') { stack.push('template'); blank(i, i + 1); i += 1; continue; }
    if (char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === "'" || char === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length) {
        if (source[j] === '\\') { value += source[j + 1] ?? ''; j += 2; continue; }
        if (source[j] === char) break;
        value += source[j];
        j += 1;
      }
      if (j < source.length) strings.set(i, value);
      blank(i, j + 1);
      i = j + 1;
      continue;
    }
    if (typeof top === 'number' && (char === '{' || char === '}')) {
      const depth = char === '{' ? top + 1 : top - 1;
      if (depth === 0) stack.pop();
      else stack[stack.length - 1] = depth;
      i += 1;
      continue;
    }
    i += 1;
  }
  return { masked: masked.join(''), strings };
}

const lineAt = (source, index) => source.slice(0, index).split('\n').length;

// Every `log(...)` / `logger(...)` / `x.log(...)` call in one file, with the
// first argument classified: `literal` holds the string value, `dynamic` the raw
// source text of anything else (template, identifier, expression).
export function logCalls(source) {
  const { masked, strings } = maskSource(source);
  const calls = [];
  for (const match of masked.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (!CALLEE_NAMES.has(name)) continue;
    let before = match.index - 1;
    while (before >= 0 && /\s/.test(masked[before])) before -= 1;
    if (before >= 0 && masked[before] === '.') {
      let end = before - 1;
      while (end >= 0 && /\s/.test(masked[end])) end -= 1;
      let start = end;
      while (start >= 0 && /[\w$]/.test(masked[start])) start -= 1;
      if (NON_LOGGER_OBJECTS.has(masked.slice(start + 1, end + 1))) continue;
    }
    let arg = match.index + match[0].length;
    // Skip whitespace and comment blanks; stop at a string literal (its opening
    // quote sits on a blank, so it must be tested first) or at a template.
    while (arg < masked.length && !strings.has(arg) && source[arg] !== '`') {
      if (!/\s/.test(masked[arg])) break;
      arg += 1;
    }
    const literal = strings.get(arg);
    calls.push({
      line: lineAt(source, arg),
      literal: literal ?? null,
      argument: literal === undefined ? source.slice(arg, arg + 40).split('\n')[0] : null,
    });
  }
  return calls;
}

test('the scanner reads call sites, not comments or strings', () => {
  const snippet = [
    '// log(\'Commented_Out\')',
    'const note = "log(\'in_a_string\')";',
    'log(\'ok_name\');',
    'this.log(`tpl_${kind}`);',
    'logger(\'also_ok\');',
    'console.log(\'界面文案：这不是事件名\');',
  ].join('\n');
  assert.deepEqual(logCalls(snippet), [
    { line: 3, literal: 'ok_name', argument: null },
    { line: 4, literal: null, argument: '`tpl_${kind}`);' },
    { line: 5, literal: 'also_ok', argument: null },
  ]);
});

test('every literal logevent name matches /^[a-z_]+$/', t => {
  const files = sourceFiles(SRC);
  const literals = [];
  const dynamic = [];
  const invalid = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const call of logCalls(source)) {
      const where = `${relative('.', file).split(sep).join('/')}:${call.line}`;
      if (call.literal === null) { dynamic.push(`${where}: ${call.argument}`); continue; }
      literals.push(call.literal);
      if (!EVENT_NAME_RE.test(call.literal)) invalid.push(`${where}: ${call.literal}`);
    }
  }
  // A broken scanner must fail loudly instead of reporting "no problems".
  assert.ok(files.length >= 20, `expected to scan src/**, saw ${files.length} file(s)`);
  assert.ok(literals.length >= 60, `expected the literal call sites, saw ${literals.length}`);
  assert.deepEqual(invalid, [], 'log event names must match /^[a-z_]+$/ (file:line: literal)');
  t.diagnostic(
    `scanned ${files.length} files under src/: ${literals.length} literal event names, ` +
    `${dynamic.length} dynamic (blind spot, not checked):`,
  );
  for (const site of dynamic) t.diagnostic(`  ${site}`);
});
