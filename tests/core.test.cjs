'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../dist/core.js');
const CREATED = '2026-11-06T02:00:00.000Z';
const FINISHED = '2026-11-06T02:01:00.000Z';

function input() {
  return {
    question: '怎样说明三枚硬币规则？',
    left: { text: '原文一\n  保留空格  ', source: '来源一' },
    right: { text: '原文二：<script>alert(1)</script>', source: '来源二' }
  };
}

function make(draw = 0.1, id = 'test-record') {
  return core.createRecord(input(), { rng: () => draw, id, now: CREATED });
}

function mutable(value) { return JSON.parse(JSON.stringify(value)); }
function code(expected) { return (error) => error.name === 'ValidationError' && error.code === expected; }

test('random placement preserves originals and hides source and original-index fields', () => {
  const original = input();
  const record = core.createRecord(original, { rng: () => 0.9, id: 'mapping', now: CREATED });
  const visible = core.visiblePair(record);
  assert.deepEqual(record.order, [1, 0]);
  assert.equal(record.candidates[0].text, original.left.text);
  assert.equal(visible.left.text, original.right.text);
  assert.equal(visible.right.text, original.left.text);
  assert.deepEqual(Object.keys(visible.left), ['text']);
  assert.deepEqual(Object.keys(visible.right), ['text']);
  assert.equal(JSON.stringify(visible).includes('来源一'), false);
  assert.equal(JSON.stringify(visible).includes('candidates'), false);
  assert.equal(JSON.stringify(visible).includes('order'), false);
  assert.equal(visible.choice, null);
  assert.equal(visible.reason, '');
});

test('RNG boundary is unbiased by a strict half threshold', () => {
  for (const draw of [0, 0.1, 0.499999999]) assert.deepEqual(make(draw).order, [0, 1]);
  for (const draw of [0.5, 0.9, 0.999999999]) assert.deepEqual(make(draw).order, [1, 0]);
  for (const draw of [-1, 1, NaN, Infinity, '0.2', undefined]) {
    assert.throws(() => make(draw === undefined ? NaN : draw), code('INVALID_RANDOM'));
  }
});

test('reveal requires a submitted choice; finishing is immutable and locks the decision', () => {
  const pending = make(0.8);
  assert.throws(() => core.reveal(pending), code('NOT_REVEALED'));
  const completed = core.finish(pending, 'left', '更易读\n理由原样保留。', { now: () => FINISHED });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.decision, null);
  const visible = core.reveal(completed);
  assert.equal(visible.left.source, '来源二');
  assert.equal(visible.right.source, '来源一');
  assert.equal(visible.choice, 'left');
  assert.equal(visible.reason, '更易读\n理由原样保留。');
  assert.equal(visible.completedAt, FINISHED);
  assert.throws(() => core.finish(completed, 'right', '', { now: FINISHED }), code('ALREADY_REVEALED'));
  assert.throws(() => { completed.decision.choice = 'right'; }, TypeError);
  assert.throws(() => { completed.order[0] = 0; }, TypeError);
});

test('all four supported decisions survive reveal; empty reasons are allowed', () => {
  for (const choice of ['left', 'right', 'tie', 'neither']) {
    const result = core.finish(make(), choice, undefined, { now: FINISHED });
    assert.equal(core.reveal(result).choice, choice);
    assert.equal(core.reveal(result).reason, '');
  }
  assert.throws(() => core.finish(make(), 'both', '', { now: FINISHED }), code('INVALID_CHOICE'));
});

test('versioned backup round trip restores pending placement and revealed choices exactly', () => {
  const records = [make(0.8, 'pending'), core.finish(make(0.1, 'done'), 'right', '理由', { now: FINISHED })];
  const json = core.exportCollection(records);
  const wrapper = JSON.parse(json);
  assert.equal(wrapper.format, 'blind-pairs');
  assert.equal(wrapper.version, 1);
  const restored = core.importCollection(json);
  assert.deepEqual(restored, records);
  assert.deepEqual(core.visiblePair(restored[0]), core.visiblePair(records[0]));
  assert.deepEqual(core.reveal(restored[1]), core.reveal(records[1]));
  assert.notEqual(restored[0], records[0]);
});

test('invalid lifecycle combinations and modified mappings are rejected before restoring', () => {
  const invalid = [
    (value) => { value.order = [0, 0]; },
    (value) => { value.order = [1, 2]; },
    (value) => { value.order = ['0', '1']; },
    (value) => { value.status = 'completed'; },
    (value) => { value.status = 'revealed'; },
    (value) => { value.decision = { choice: 'left', reason: '' }; },
    (value) => { value.completedAt = FINISHED; },
    (value) => { value.candidates.push({ text: '第三项', source: '' }); },
    (value) => { value.id = '../../path'; }
  ];
  for (const mutate of invalid) {
    const record = mutable(make());
    mutate(record);
    assert.throws(() => core.importCollection(JSON.stringify({ format: 'blind-pairs', version: 1, records: [record] })), { name: 'ValidationError' });
  }
  const record = mutable(core.finish(make(), 'tie', '', { now: FINISHED }));
  record.decision.choice = 'unknown';
  assert.throws(() => core.validateRecord(record), code('INVALID_CHOICE'));
});

test('timestamp validation rejects invalid calendar dates and completion before creation', () => {
  for (const date of ['2026-02-30T00:00:00.000Z', 'today', 0, '2026-11-06T02:00:00+08:00']) {
    const record = mutable(make());
    record.createdAt = date;
    assert.throws(() => core.validateRecord(record), code('INVALID_DATE'));
  }
  assert.throws(() => core.finish(make(), 'left', '', { now: '2026-11-05T02:00:00.000Z' }), code('INVALID_DATE_ORDER'));
});

test('required strings, scalar types and documented input limits are enforced', () => {
  for (const [field, value] of [['question', '  \n'], ['question', null], ['question', 'x'.repeat(core.LIMITS.question + 1)]]) {
    const original = input(); original[field] = value;
    assert.throws(() => core.createRecord(original, { rng: () => 0, id: 'limits', now: CREATED }), { name: 'ValidationError' });
  }
  for (const [field, value] of [['text', ''], ['text', []], ['text', 'x'.repeat(core.LIMITS.text + 1)], ['source', 1], ['source', 'x'.repeat(core.LIMITS.source + 1)]]) {
    const original = input(); original.left[field] = value;
    assert.throws(() => core.createRecord(original, { rng: () => 0, id: 'limits', now: CREATED }), { name: 'ValidationError' });
  }
  assert.throws(() => core.finish(make(), 'tie', 'x'.repeat(core.LIMITS.reason + 1), { now: FINISHED }), code('TEXT_TOO_LONG'));
  const exact = input();
  exact.question = 'x'.repeat(core.LIMITS.question);
  exact.left = { text: 'x'.repeat(core.LIMITS.text), source: 'x'.repeat(core.LIMITS.source) };
  assert.equal(core.createRecord(exact, { rng: () => 0, id: 'at-limit', now: CREATED }).question.length, core.LIMITS.question);
});

test('unknown keys, prototype-bearing objects and JSON pollution payloads are rejected', () => {
  const record = mutable(make());
  record.unexpected = true;
  assert.throws(() => core.validateRecord(record), code('INVALID_FIELDS'));
  const object = Object.create({ attacker: true });
  Object.assign(object, mutable(make()));
  assert.throws(() => core.validateRecord(object), code('INVALID_OBJECT'));
  const validWrapper = core.exportCollection([make()]);
  const malicious = validWrapper.replace('"format": "blind-pairs",', '"format": "blind-pairs", "__proto__": {"polluted": true},');
  assert.throws(() => core.importCollection(malicious), code('INVALID_FIELDS'));
  assert.equal({}.polluted, undefined);
  const deep = mutable(make());
  Object.defineProperty(deep.candidates[0], '__proto__', { value: { polluted: true }, enumerable: true });
  assert.throws(() => core.validateRecord(deep), code('INVALID_FIELDS'));
  assert.equal({}.polluted, undefined);
});

test('imports are atomic and reject malformed envelopes, duplicate IDs and oversized collections', () => {
  for (const value of ['', '[', '{}', 'null', '[]', '{"format":"other","version":1,"records":[]}']) {
    assert.throws(() => core.importCollection(value), { name: 'ValidationError' });
  }
  assert.throws(() => core.importCollection(null), code('INVALID_JSON'));
  assert.throws(() => core.importCollection(' '.repeat(core.LIMITS.importCharacters + 1)), code('IMPORT_TOO_LARGE'));
  assert.throws(() => core.importCollection('{"format":"blind-pairs","version":2,"records":[]}'), code('UNSUPPORTED_VERSION'));
  assert.throws(() => core.validateCollection([make(), make()]), code('DUPLICATE_ID'));
  const tooMany = Array.from({ length: core.LIMITS.records + 1 }, (_, i) => make(0, 'r' + i));
  assert.throws(() => core.exportCollection(tooMany), code('TOO_MANY_RECORDS'));
  assert.deepEqual(core.importCollection(core.exportCollection([])), []);
});

test('markdown never exports sources of pending records and safely renders imported markup as text', () => {
  const pending = make(0.8);
  const markdown = core.toMarkdown([pending]);
  assert.equal(markdown.includes('来源一'), false);
  assert.equal(markdown.includes('<script>'), false);
  assert.equal(markdown.includes('&lt;script&gt;'), true);
  const complete = core.finish(pending, 'neither', '[link](javascript:alert(1))', { now: FINISHED });
  const output = core.toMarkdown([complete]);
  assert.match(output, /选择：都不合适/);
  assert.match(output, /左侧来源：来源二/);
  assert.equal(output.includes('[link]('), false);
});

test('browser script exposes the same API without CommonJS and uses injected crypto for ID and placement', () => {
  const context = vm.createContext({
    crypto: { getRandomValues(array) { array.fill(1); return array; } },
    Uint8Array, Uint32Array, Date
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/core.js'), 'utf8'), context);
  const result = vm.runInContext(`BlindPairsCore.createRecord({question:'题目',left:{text:'内容一',source:''},right:{text:'内容二',source:''}}, {now:'${CREATED}'})`, context);
  assert.equal(result.id, 'bp-' + '01'.repeat(16));
  assert.equal(result.order[0], 0);
  assert.equal(result.status, 'pending');
  assert.equal(typeof context.BlindPairsCore.importCollection, 'function');
});

test('secure randomness has no silent Math.random fallback in older browser environments', () => {
  const context = vm.createContext({ Uint8Array, Uint32Array, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/core.js'), 'utf8'), context);
  assert.throws(() => vm.runInContext(`BlindPairsCore.createRecord({question:'q',left:{text:'a',source:''},right:{text:'b',source:''}})`, context), (error) => error.code === 'CRYPTO_UNAVAILABLE');
});
