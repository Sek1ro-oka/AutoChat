import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUARD_REASONS, POST_MAX_CHARS, POST_MIN_CHARS, REPEAT_SIMILARITY, guardPost, similarity,
} from '../src/qzone-guard.js';

// A context with one whitelisted group and one blocked term: the two rules that
// need configuration, everything else is absolute.
const CTX = { groupIds: ['20000'], blockTerms: ['赌博'], recent: [] };
const GOOD = '今天的风很舒服，适合出门走走。';
const reasonOf = (text, ctx = CTX) => guardPost(text, ctx).reason;

test('a post inside every rule passes with no reason', () => {
  const verdict = guardPost(GOOD, CTX);
  assert.deepEqual(verdict, { ok: true, reason: '', len: Array.from(GOOD).length });
});

test('length: a post below the floor or above the ceiling is refused', () => {
  assert.equal(reasonOf('嗯'.repeat(POST_MIN_CHARS - 1)), 'length');
  assert.equal(reasonOf('啊'.repeat(POST_MAX_CHARS + 1)), 'length');
  // The boundaries themselves are allowed.
  assert.equal(reasonOf('啊'.repeat(POST_MIN_CHARS)), '');
  assert.equal(reasonOf('啊'.repeat(POST_MAX_CHARS)), '');
});

test('groupid: a whitelisted group number is refused as a group id, not as a number', () => {
  assert.equal(reasonOf('我梦见了20000个人'), 'groupid');
});

test('number: a 5 to 12 digit run is refused', () => {
  assert.equal(reasonOf('今天打了123456789个喷嚏'), 'number');
});

test('link: http(s) and www links are refused', () => {
  assert.equal(reasonOf('看这个 https://example.com/page 挺有意思'), 'link');
  assert.equal(reasonOf('看这个 www.example.com 挺有意思'), 'link');
});

test('markup: @, our prompt brackets and a serialised segment are refused', () => {
  assert.equal(reasonOf('谢谢@小明 今天带我吃饭'), 'markup');
  assert.equal(reasonOf('【重点】今天下雨了记得带伞'), 'markup');
  assert.equal(reasonOf('表情[CQ:face,id=1]真可爱啊'), 'markup');
});

test('term: a blocked term is refused', () => {
  assert.equal(reasonOf('楼下又在赌博了真烦人'), 'term');
});

test('repeat: the same post again is refused, an unrelated one is not', () => {
  assert.equal(reasonOf(GOOD, { ...CTX, recent: [GOOD] }), 'repeat');
  assert.equal(reasonOf(GOOD, { ...CTX, recent: ['完全不相干的一句话也是一句'] }), '');
  // Punctuation and spacing are not what makes a post "the same post".
  assert.equal(reasonOf('好耶，今天真好！', { ...CTX, recent: ['好耶今天真好'] }), 'repeat');
});

test('the guard returns an enum and a length, never the text', () => {
  const text = '今天打了123456789个喷嚏';
  const verdict = guardPost(text, CTX);
  assert.deepEqual(Object.keys(verdict).sort(), ['len', 'ok', 'reason']);
  assert.equal(verdict.len, Array.from(text).length);
});

test('every declared reason is reachable', () => {
  const cases = [
    '短', '我梦见了20000个人', '今天打了123456789个喷嚏', '看这个https://example.com挺有意思',
    '谢谢@小明今天带我吃饭', '楼下又在赌博了真烦人',
  ];
  const seen = new Set(cases.map(text => reasonOf(text)));
  seen.add(reasonOf(GOOD, { ...CTX, recent: [GOOD] }));
  assert.deepEqual([...seen].sort(), [...GUARD_REASONS].sort());
});

test('similarity is 1 for the same line and 0 when one side is empty', () => {
  assert.equal(similarity('今天真好', '今天真好'), 1);
  assert.equal(similarity('今天真好', ''), 0);
  assert.ok(similarity('今天天气很好适合出门', '今天天气不错适合散步') < REPEAT_SIMILARITY);
  assert.equal(REPEAT_SIMILARITY, 0.8);
});

test('only the newest three posts are compared for a repeat', () => {
  const recent = ['第一条完全不同的话', '第二条也完全不同', '第三条同样不同', GOOD];
  // GOOD is fourth, outside the window, so it is not a repeat.
  assert.equal(reasonOf(GOOD, { ...CTX, recent }), '');
});
