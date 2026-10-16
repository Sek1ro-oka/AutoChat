// Unit tests for scripts/check-doc-links.js (issue I-07 / task A-4).
//
// The linked-documentation checker is repo-internal tooling, so its four known
// defect classes — fenced code, inline code and HTML comments, duplicate-heading
// `-1` suffixes, and unparsable percent escapes — each get an explicit case here
// instead of being trusted to a manual run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkPaths,
  decodeTarget,
  extractLinks,
  headingSlugs,
  maskIgnoredRegions,
  slugify,
  stripInlineMarkup,
} from '../scripts/check-doc-links.js';

test('headings slug the way GitHub anchors do', () => {
  // GitHub's published rule set: lowercase, keep letters and digits, turn runs
  // of whitespace into `-`, drop the rest. CJK survives; punctuation does not.
  assert.equal(slugify('硬规矩'), '硬规矩');
  assert.equal(slugify('想找什么，去哪看'), '想找什么去哪看');
  assert.equal(slugify('1. 背景与目标'), '1-背景与目标');
  assert.equal(
    slugify("This'll be a _Helpful_ Section About the Greek Letter Θ!"),
    'thisll-be-a-helpful-section-about-the-greek-letter-θ',
  );
  // Inline markup is stripped before slugging, so a heading that quotes code
  // still matches the anchor GitHub derives for it.
  assert.equal(stripInlineMarkup('与上游 `qq-bridge` 基线的差异'), '与上游 qq-bridge 基线的差异');
  assert.equal(slugify('与上游 `qq-bridge` 基线的差异'), '与上游-qq-bridge-基线的差异');
  assert.equal(slugify('**加粗** 与 [链接](x.md)'), '加粗-与-链接');
});

test('repeated headings get -1 and -2 suffixes', () => {
  const markdown = [
    '# 标题',
    '',
    '## 重名标题',
    '',
    '正文',
    '',
    '## 重名标题',
    '',
    '## 重名标题',
  ].join('\n');
  assert.deepEqual(headingSlugs(markdown), ['标题', '重名标题', '重名标题-1', '重名标题-2']);
  // Two headings, not three: identical text in a fence is not an anchor.
  assert.deepEqual(headingSlugs('## same\n\n## same'), ['same', 'same-1']);
});

test('fences, inline code and HTML comments are ignored', () => {
  const markdown = [
    '# 真标题',
    '',
    '```md',
    '# 围栏里的注释',
    '[围栏](missing-fence.md)',
    '```',
    '',
    '行内代码 `[行内](missing-inline.md)` 与 `# 行内注释`',
    '',
    '<!-- [注释](missing-comment.md) -->',
    '',
    '<!-- 跨行',
    '[注释二](missing-comment-two.md)',
    '-->',
    '',
    '## 真标题二',
  ].join('\n');
  assert.deepEqual(extractLinks(markdown), []);
  assert.deepEqual(headingSlugs(markdown), ['真标题', '真标题二']);
  // Masking only swaps characters for spaces, so line numbers stay exact.
  const masked = maskIgnoredRegions(markdown);
  assert.equal(masked.length, markdown.length);
  assert.equal(masked.split('\n').length, markdown.split('\n').length);
  assert.equal(extractLinks(markdown).length, 0);
  assert.equal(extractLinks('[真](real.md)').length, 1);
});

test('extractLinks keeps line numbers, angle targets and image markers', () => {
  const markdown = [
    '# 索引',
    '',
    '- 普通：[一](one.md)',
    '- 图片：![二](two.png "标题")',
    '- 尖括号：[三](<three.md>)',
    '- 纯锚点：[四](#四)',
    '- 空目标：[五]()',
  ].join('\n');
  assert.deepEqual(
    extractLinks(markdown).map(link => [link.line, link.target, link.image]),
    [[3, 'one.md', false], [4, 'two.png "标题"', true], [5, '<three.md>', false], [6, '#四', false]],
  );
});

test('decodeTarget splits target from anchor without ever throwing', () => {
  assert.deepEqual(decodeTarget('target.md#你好'), { path: 'target.md', anchor: '你好', error: null });
  // Percent escapes decode: a file deployed as `caf%C3%B6.md` really is `cafö.md`.
  assert.deepEqual(decodeTarget('caf%C3%B6.md'), { path: 'cafö.md', anchor: '', error: null });
  assert.deepEqual(decodeTarget('a.md#%E4%BD%A0%E5%A5%BD'), { path: 'a.md', anchor: '你好', error: null });
  assert.deepEqual(decodeTarget('<with space.md>'), { path: 'with space.md', anchor: '', error: null });
  assert.deepEqual(decodeTarget('x.md "title"'), { path: 'x.md', anchor: '', error: null });
  // A malformed escape is a reportable problem, not a crash (the previous
  // implementation died with `URIError: URI malformed`).
  const broken = decodeTarget('bad%zz.md');
  assert.match(broken.error ?? '', /非法百分号转义/);
  assert.equal(broken.path, 'bad%zz.md');
});

test('checkPaths reports real problems and nothing else', t => {
  const root = mkdtempSync(join(tmpdir(), 'check-doc-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (relative, content) => {
    const file = join(root, relative);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  };
  write('docs/index.md', [
    '# 索引',
    '',
    '- 正常锚点：[你好](target.md#你好)',
    '- 重名第二项：[重名](target.md#重名-1)',
    '- 转义路径：[转义](caf%C3%B6.md)',
    '- 目录链接：[assets](../assets)',
    '- 希腊字母（大小写不敏感）：[Θ](target.md#thisll-be-a-helpful-section-about-the-greek-letter-Θ)',
    '- 工作区链接：[笔记](../work/notes.md)',
    '- 外链：[例子](https://example.com/)',
    '- 断链：[断链](missing.md)',
    '- 非法转义：[坏](bad%zz.md)',
  ].join('\n'));
  write('docs/target.md', [
    '# 你好',
    '',
    '## 重名',
    '',
    '## 重名',
    '',
    "## This'll be a _Helpful_ Section About the Greek Letter Θ!",
  ].join('\n'));
  write('docs/cafö.md', '# 转义文件名\n');
  write('work/notes.md', '# 工作区笔记\n\n- 指向发布文档：[目标](../docs/target.md#你好)\n');
  mkdirSync(join(root, 'assets'), { recursive: true });

  const result = checkPaths(['docs', 'work'], root);
  assert.deepEqual(result.files.map(file => file.slice(root.length + 1)), [
    join('docs', 'cafö.md'),
    join('docs', 'index.md'),
    join('docs', 'target.md'),
    join('work', 'notes.md'),
  ]);
  // Only published docs are policed: `work/notes.md` may link inside work/, and
  // its own link to released documentation still has to resolve.
  assert.deepEqual(result.problems, [
    'docs/index.md:8: 链接指向未跟踪的工作区 work/: ../work/notes.md',
    'docs/index.md:10: 链接目标不存在: missing.md',
    'docs/index.md:11: 链接目标含非法百分号转义: bad%zz.md',
  ]);
  assert.deepEqual(
    { links: result.links, external: result.external, relative: result.relative, anchorsOnly: result.anchorsOnly, workLinks: result.workLinks },
    { links: 10, external: 1, relative: 9, anchorsOnly: 0, workLinks: 1 },
  );
});
