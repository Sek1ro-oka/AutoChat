#!/usr/bin/env node
// Offline Markdown link checker for the published docs (I-07 / A-4).
//
// Scope: relative link targets and `#anchors` inside this repository. External
// links are counted and listed only — the checker never touches the network, so
// it runs offline and stays dependency-free.
//
// What it deliberately ignores (each one used to be a false positive):
//   * fenced code blocks (``` / ~~~), including the shell comments inside them
//   * inline code spans (`…`)
//   * HTML comments (<!-- … -->)
//   * link targets that exist but are directories, or non-.md files
//
// Known limitations, stated rather than hidden: reference-style links
// (`[text][id]` + `[id]: target`) and links wrapped across lines are not
// collected; targets are resolved with `stat`, not case-folded, so a
// wrong-case path on a case-insensitive filesystem passes.
//
// Usage: node scripts/check-doc-links.js [文件或目录 ...]   (默认 docs README.md)
// Exit code: 1 when there is at least one local problem, 0 otherwise.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'downloads', 'data', 'runtime', 'logs']);
const EXTERNAL_RE = /^([a-z][a-z0-9+.-]*:|\/\/)/i;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const toPosix = path => path.split(sep).join('/');

// GitHub's five rules: lowercase, drop punctuation, spaces become `-`, trim, and
// a repeated heading gets `-1`, `-2`, … Inline markup is stripped first, so
// `## 与上游 \`qq-bridge\` 基线的差异` slugs as `与上游-qq-bridge-基线的差异`.
// CJK survives on purpose: `你好` → `你好`, `想找什么，去哪看` → `想找什么去哪看`.
export function stripInlineMarkup(text) {
  return String(text)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1');
}

export function slugify(heading) {
  return stripInlineMarkup(heading)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\p{M}_-]+/gu, '');
}

// Blank out the regions that never produce real links, keeping every offset and
// newline so reported line numbers still point at the original text.
export function maskIgnoredRegions(markdown) {
  const out = [...markdown];
  const blank = (from, to) => {
    for (let i = Math.max(0, from); i < Math.min(out.length, to); i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };
  let fence = null;
  let inComment = false;
  let offset = 0;
  for (const chunk of markdown.split(/(?<=\n)/)) {
    const body = chunk.replace(/\n$/, '');
    const start = offset;
    offset += chunk.length;
    if (fence) {
      blank(start, offset);
      const close = body.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    if (inComment) {
      blank(start, offset);
      if (body.includes('-->')) inComment = false;
      continue;
    }
    for (let cursor = 0; ;) {
      const from = body.indexOf('<!--', cursor);
      if (from === -1) break;
      const to = body.indexOf('-->', from + 4);
      if (to === -1) {
        blank(start + from, offset);
        inComment = true;
        break;
      }
      blank(start + from, start + to + 3);
      cursor = to + 3;
    }
    const masked = out.slice(start, start + body.length).join('');
    const open = masked.match(FENCE_RE);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      blank(start, offset);
    }
  }
  // Inline code spans: fences and comments are already blank, so every backtick
  // left here is a real code-span delimiter. An unmatched run is left alone.
  let i = 0;
  while (i < out.length) {
    if (out[i] !== '`') { i += 1; continue; }
    let run = 0;
    while (out[i + run] === '`') run += 1;
    let scan = i + run;
    let close = -1;
    while (scan < out.length) {
      if (out[scan] !== '`') { scan += 1; continue; }
      let closing = 0;
      while (out[scan + closing] === '`') closing += 1;
      if (closing === run) { close = scan; break; }
      scan += closing;
    }
    if (close === -1) { i += run; continue; }
    blank(i, close + run);
    i = close + run;
  }
  return out.join('');
}

// [text](target) and ![alt](target), with the optional `<…>` form and title.
export function extractLinks(markdown) {
  const masked = maskIgnoredRegions(markdown);
  const links = [];
  for (const match of masked.matchAll(/!?\[([^\]]*)\]\(\s*([^)]*?)\s*\)/g)) {
    if (match[2] === '') continue;
    links.push({
      line: lineAt(masked, match.index),
      text: match[1],
      target: match[2],
      image: match[0].startsWith('!'),
    });
  }
  return links;
}

// Anchor slugs of one document, in order, with GitHub's `-1`, `-2` suffixes.
export function headingSlugs(markdown) {
  const masked = maskIgnoredRegions(markdown);
  const lines = markdown.split('\n');
  const taken = new Map();
  const slugs = [];
  for (const match of masked.matchAll(/^ {0,3}(#{1,6})\s+(.+?)\s*$/gm)) {
    const line = lineAt(masked, match.index);
    const base = slugify(lines[line - 1].replace(/^ {0,3}#{1,6}\s+/, ''));
    const seen = taken.get(base) ?? 0;
    taken.set(base, seen + 1);
    slugs.push(seen === 0 ? base : `${base}-${seen}`);
  }
  return slugs;
}

// `decodeURIComponent` must never be able to kill the run, and `%C3%B6` must
// decode: a target that fails to decode is reported instead of throwing.
export function decodeTarget(raw) {
  let target = String(raw).trim();
  let error = null;
  if (target.startsWith('<')) {
    const end = target.indexOf('>');
    target = end === -1 ? target.slice(1) : target.slice(1, end);
  } else {
    target = target.split(/\s+/)[0];
  }
  const hash = target.indexOf('#');
  const rawPath = hash === -1 ? target : target.slice(0, hash);
  const rawAnchor = hash === -1 ? '' : target.slice(hash + 1);
  const decode = part => {
    try { return decodeURIComponent(part); }
    catch { error = '链接目标含非法百分号转义'; return part; }
  };
  return { path: decode(rawPath), anchor: decode(rawAnchor), error };
}

// Every .md file reachable from the given files/directories, deduplicated.
export function collectFiles(paths, root = ROOT) {
  const found = new Set();
  const walk = entry => {
    const stats = statSync(entry, { throwIfNoEntry: false });
    if (!stats) return;
    if (stats.isDirectory()) {
      for (const name of readdirSync(entry).sort()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(join(entry, name));
      }
      return;
    }
    if (entry.toLowerCase().endsWith('.md')) found.add(resolve(entry));
  };
  for (const path of paths) walk(resolve(root, path));
  return [...found].sort();
}

export function checkPaths(paths, root = ROOT) {
  const files = collectFiles(paths, root);
  const slugCache = new Map();
  const slugsOf = file => {
    if (!slugCache.has(file)) slugCache.set(file, headingSlugs(readFileSync(file, 'utf8')));
    return slugCache.get(file);
  };
  const problems = [];
  const totals = { links: 0, external: 0, anchorsOnly: 0, relative: 0, workLinks: 0 };
  const report = (file, line, message) => problems.push(`${toPosix(relative(root, file))}:${line}: ${message}`);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const own = new Set(slugsOf(file).map(slug => slug.toLowerCase()));
    const workRoot = join(root, 'work');
    // Only published docs are policed for work/ targets; files that already live
    // in the scratch workspace may of course link around inside it.
    const published = file !== workRoot && !file.startsWith(workRoot + sep);
    for (const link of extractLinks(source)) {
      totals.links += 1;
      if (EXTERNAL_RE.test(link.target)) { totals.external += 1; continue; }
      const { path, anchor, error } = decodeTarget(link.target);
      // Counted before the error check so that 外链 + 纯锚点 + 相对路径 always
      // adds up to the reported link total.
      if (path === '') totals.anchorsOnly += 1; else totals.relative += 1;
      if (error) { report(file, link.line, `${error}: ${link.target}`); continue; }
      let targetFile = file;
      let targetSlugs = own;
      if (path !== '') {
        targetFile = path.startsWith('/') ? resolve(root, path.slice(1)) : resolve(dirname(file), path);
        if (published && (targetFile === workRoot || targetFile.startsWith(workRoot + sep))) {
          totals.workLinks += 1;
          report(file, link.line, `链接指向未跟踪的工作区 work/: ${link.target}`);
        }
        const stats = statSync(targetFile, { throwIfNoEntry: false });
        if (!stats) { report(file, link.line, `链接目标不存在: ${link.target}`); continue; }
        if (!stats.isFile()) continue;
        if (anchor === '') continue;
        if (!targetFile.toLowerCase().endsWith('.md')) continue;
        targetSlugs = new Set(slugsOf(targetFile).map(slug => slug.toLowerCase()));
      }
      if (anchor !== '' && !targetSlugs.has(anchor.toLowerCase())) {
        report(file, link.line, `锚点不存在: ${link.target}`);
      }
    }
  }
  return { files, root, problems, ...totals };
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
const isMain = invoked !== '' && (process.platform === 'win32'
  ? invoked.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
  : invoked === fileURLToPath(import.meta.url));

if (isMain) {
  const result = checkPaths(process.argv.slice(2).length ? process.argv.slice(2) : ['docs', 'README.md']);
  console.log(`扫描 ${result.files.length} 个 .md 文件 / ${result.links} 条链接`
    + `（外链 ${result.external} 条、纯锚点 ${result.anchorsOnly} 条、相对路径 ${result.relative} 条）`);
  console.log(`指向工作区 work/ 的链接: ${result.workLinks}`);
  console.log(`本地问题: ${result.problems.length}`);
  for (const [index, problem] of result.problems.entries()) console.log(`  ${index + 1}. ${problem}`);
  process.exitCode = result.problems.length === 0 ? 0 : 1;
}
