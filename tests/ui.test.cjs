'use strict';

// This is an event/DOM contract harness, not a browser renderer. It runs the
// shipped core.js and app.js without extra packages; layout and browser storage
// policy still need the real-browser checks documented by the project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../dist/core.js');

const KEY = 'blind-pairs.records.v1';
const DRAFT = 'blind-pairs.draft.v1';
const html = fs.readFileSync(path.join(__dirname, '../dist/index.html'), 'utf8');
const coreSource = fs.readFileSync(path.join(__dirname, '../dist/core.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8');

class EventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback, options = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ callback, once: options.once });
    this.listeners.set(type, listeners);
  }
  async dispatch(type, details = {}) {
    const event = { type, target: this, preventDefault() { this.defaultPrevented = true; }, ...details };
    const current = [...(this.listeners.get(type) || [])];
    for (const listener of current) {
      if (listener.once) this.listeners.set(type, this.listeners.get(type).filter(item => item !== listener));
      await listener.callback(event);
    }
    return event;
  }
}

class Element extends EventTarget {
  constructor(tagName = 'div', harness) {
    super();
    this.tagName = tagName.toUpperCase();
    this.harness = harness;
    this.children = [];
    this.value = '';
    this._text = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.maxLength = -1;
    this.files = [];
    this.attributes = new Map();
    this.classList = { toggle() {} };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(_) { throw new Error('The app must render user text using textContent, not innerHTML.'); }
  set outerHTML(_) { throw new Error('The app must not render user text as outerHTML.'); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; this._text = ''; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  focus() { this.harness.focused = this; }
  showModal() { this.open = true; }
  async close(value) { this.returnValue = value; this.open = false; await this.dispatch('close'); }
  click() {
    if (this.tagName === 'A') this.harness.downloads.push({ href: this.href, filename: this.download });
    return this.dispatch('click');
  }
}

class Storage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); this.failReads = false; this.failWrites = false; }
  getItem(key) { if (this.failReads) throw new Error('Storage access denied'); return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.failWrites) throw new Error('Storage quota exceeded'); this.values.set(key, String(value)); }
  removeItem(key) { if (this.failWrites) throw new Error('Storage access denied'); this.values.delete(key); }
}

function fixture(id = 'fixture', text = '内容') {
  return core.createRecord({ question: '这次比较什么？', left: { text: text + '一', source: '第一来源' }, right: { text: text + '二', source: '第二来源' } },
    { rng: () => 0.8, id, now: '2026-11-06T00:00:00.000Z' });
}

function start(storage = new Storage()) {
  const harness = { storage, elements: new Map(), choices: [], downloads: [], blobs: new Map(), focused: null };
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const element = new Element(match[1], harness);
    element.id = match[3];
    element.hidden = /\bhidden\b/.test(match[2]);
    const length = /\bmaxlength="(\d+)"/i.exec(match[2]);
    if (length) element.maxLength = Number(length[1]);
    harness.elements.set(element.id, element);
  }
  for (const value of ['left', 'right', 'tie', 'neither']) {
    const radio = new Element('input', harness); radio.value = value; harness.choices.push(radio);
  }
  const document = {
    getElementById(id) { const element = harness.elements.get(id); if (!element) throw new Error('Unknown DOM ID: ' + id); return element; },
    createElement(tag) { return new Element(tag, harness); },
    createTextNode(text) { const node = new Element('#text', harness); node.textContent = text; return node; },
    querySelectorAll(selector) { assert.equal(selector, 'input[name="choice"]'); return harness.choices; },
    querySelector(selector) { assert.equal(selector, 'input[name="choice"]:checked'); return harness.choices.find(choice => choice.checked) || null; }
  };
  const window = new EventTarget(); window.scrollTo = () => {};
  const context = vm.createContext({
    document, window, localStorage: storage, crypto: webcrypto, Uint8Array, Uint32Array, Blob,
    URL: {
      createObjectURL(blob) { const url = 'blob:test-' + harness.blobs.size; harness.blobs.set(url, blob); return url; },
      revokeObjectURL() {}
    },
    setTimeout() { return 1; }, clearTimeout() {},
    fetch() { throw new Error('This offline app must not make network requests.'); }
  });
  vm.runInContext(coreSource, context, { filename: 'core.js' });
  vm.runInContext(appSource, context, { filename: 'app.js' });
  harness.$ = id => document.getElementById(id);
  harness.window = window;
  harness.click = id => harness.$(id).click();
  harness.submit = id => harness.$(id).dispatch('submit');
  harness.choose = async value => {
    harness.choices.forEach(radio => { radio.checked = radio.value === value; });
    await harness.choices.find(radio => radio.value === value).dispatch('change');
  };
  harness.fill = (overrides = {}) => {
    const data = { question: '测试比较场景', 'text-one': '第一版内容', 'source-one': '第一来源', 'text-two': '第二版内容', 'source-two': '第二来源', ...overrides };
    for (const [id, value] of Object.entries(data)) harness.$(id).value = value;
  };
  harness.import = async json => {
    const field = harness.$('import-file');
    field.value = 'chosen-file.json';
    field.files = [{ size: Buffer.byteLength(json, 'utf8'), async text() { return json; } }];
    await field.dispatch('change');
  };
  harness.exportJson = async () => {
    await harness.click('history-nav'); await harness.click('export-json');
    const latest = harness.downloads.at(-1);
    assert.ok(latest, 'A backup download should have been created');
    return harness.blobs.get(latest.href).text();
  };
  return harness;
}

function persisted(storage) { return core.importCollection(storage.getItem(KEY)); }
function historyOpenButton(app, row = 0) { return app.$('history-list').children[row].children[1].children[0]; }

test('real UI submission saves a pending record, clears its draft, and restores the same hidden placement', async () => {
  const storage = new Storage(); const first = start(storage);
  first.fill(); await first.$('question').dispatch('input');
  assert.ok(storage.getItem(DRAFT));
  await first.submit('pair-form');
  const [record] = persisted(storage);
  assert.equal(record.status, 'pending');
  assert.equal(storage.getItem(DRAFT), null);
  assert.equal(first.$('compare').hidden, false);
  assert.equal(first.$('left-source').hidden, true);
  assert.equal(first.$('left-source').textContent, '');
  assert.equal(first.$('right-source').textContent, '');
  const placement = [first.$('left-text').textContent, first.$('right-text').textContent];
  const second = start(storage);
  await second.click('history-nav'); await historyOpenButton(second).click();
  assert.deepEqual([second.$('left-text').textContent, second.$('right-text').textContent], placement);
  assert.equal(second.$('left-source').hidden, true);
  assert.equal(second.$('decision-form').hidden, false);
  assert.equal(second.$('count').textContent, '1');
});

test('real decision events reveal the matching source, lock the decision and restore the result', async () => {
  const storage = new Storage(); const app = start(storage);
  app.fill(); await app.submit('pair-form');
  await app.choose('right'); app.$('reason').value = '第二种表达更清楚。'; await app.$('reason').dispatch('input');
  await app.submit('decision-form');
  const [record] = persisted(storage); const expected = core.reveal(record);
  assert.equal(record.decision.choice, 'right');
  assert.equal(app.$('left-source').textContent, expected.left.source);
  assert.equal(app.$('right-source').textContent, expected.right.source);
  assert.equal(app.$('saved-reason').textContent, '第二种表达更清楚。');
  assert.equal(app.$('decision-form').hidden, true);
  const original = storage.getItem(KEY);
  await app.choose('left'); await app.submit('decision-form');
  assert.equal(storage.getItem(KEY), original, 'Even a synthetic second submit cannot replace the locked result');
  const reopened = start(storage); await reopened.click('history-nav'); await historyOpenButton(reopened).click();
  assert.equal(reopened.$('decision-form').hidden, true);
  assert.equal(reopened.$('right-source').textContent, expected.right.source);
  assert.equal(reopened.$('saved-reason').textContent, expected.reason);
});

test('no choice does not save a result; duplicate imports skip identical records and conflicts are atomic', async () => {
  const storage = new Storage(); const app = start(storage);
  app.fill(); await app.submit('pair-form'); await app.submit('decision-form');
  assert.equal(persisted(storage)[0].status, 'pending');
  assert.match(app.$('notice').textContent, /请先选择/);
  const backup = storage.getItem(KEY);
  await app.import(backup); await app.import(backup);
  assert.equal(persisted(storage).length, 1);
  assert.match(app.$('notice').textContent, /新增 0 组/);
  assert.equal(app.$('import-file').value, '');
  const conflicting = JSON.parse(JSON.stringify(persisted(storage)[0])); conflicting.question = '同编号不同内容';
  await app.import(core.exportCollection([fixture('new-but-not-committed'), conflicting]));
  assert.equal(storage.getItem(KEY), backup);
  assert.equal(app.$('count').textContent, '1');
  assert.match(app.$('notice').textContent, /同编号冲突/);
});

test('invalid imported records, malformed JSON and merged record limits leave the existing archive untouched', async () => {
  const storage = new Storage({ [KEY]: core.exportCollection([fixture('existing')]) });
  const app = start(storage); const original = storage.getItem(KEY);
  const damaged = JSON.parse(core.exportCollection([fixture('new-valid'), fixture('new-invalid')]));
  damaged.records[1].order = [0, 0];
  for (const value of ['not JSON', JSON.stringify(damaged), '{"format":"blind-pairs","version":1,"records":[],"__proto__":{"polluted":true}}']) {
    await app.import(value);
    assert.equal(storage.getItem(KEY), original);
    assert.equal(app.$('count').textContent, '1');
    assert.match(app.$('notice').textContent, /导入未完成/);
    assert.equal(app.$('import-file').value, '');
  }
  const hundred = Array.from({ length: 100 }, (_, index) => fixture('another-' + index));
  await app.import(core.exportCollection(hundred));
  assert.equal(storage.getItem(KEY), original, 'The merged 101-record archive must be rejected before saving');
  assert.equal(app.$('count').textContent, '1');
});

test('a save detects an external update even without a storage event and never overwrites it', async () => {
  const storage = new Storage(); const app = start(storage);
  app.fill(); await app.submit('pair-form');
  const external = core.exportCollection([fixture('external')]); storage.setItem(KEY, external);
  await app.choose('left'); await app.submit('decision-form');
  assert.equal(storage.getItem(KEY), external);
  assert.equal(app.$('storage-warning').hidden, false);
  assert.equal(app.$('decision-form').hidden, false);
  const backup = core.importCollection(await app.exportJson());
  assert.equal(backup.length, 1);
  assert.equal(backup[0].status, 'pending');
  assert.notEqual(backup[0].id, 'external');
});

test('a storage event locks writing while preserving the current in-memory backup', async () => {
  const storage = new Storage(); const app = start(storage);
  app.fill(); await app.submit('pair-form');
  const original = storage.getItem(KEY);
  await app.window.dispatch('storage', { key: KEY, newValue: 'changed-in-another-tab' });
  await app.choose('tie'); await app.submit('decision-form');
  assert.equal(storage.getItem(KEY), original);
  assert.equal(app.$('storage-warning').hidden, false);
  assert.equal(core.importCollection(await app.exportJson())[0].status, 'pending');
});

test('unavailable storage at startup still permits a recoverable in-memory session', async () => {
  const storage = new Storage(); storage.failReads = true; storage.failWrites = true;
  const app = start(storage);
  assert.equal(app.$('storage-warning').hidden, false);
  app.fill(); await app.submit('pair-form'); await app.choose('neither'); await app.submit('decision-form');
  assert.equal(app.$('count').textContent, '1');
  assert.equal(app.$('decision-form').hidden, true);
  const [result] = core.importCollection(await app.exportJson());
  assert.equal(result.decision.choice, 'neither');
  assert.equal(storage.values.has(KEY), false);
});

test('a quota failure preserves old disk data and warns while exporting the current result', async () => {
  const storage = new Storage(); const app = start(storage);
  app.fill(); await app.submit('pair-form'); const pendingBackup = storage.getItem(KEY);
  storage.failWrites = true;
  await app.choose('left'); await app.submit('decision-form');
  assert.equal(storage.getItem(KEY), pendingBackup);
  assert.equal(app.$('storage-warning').hidden, false);
  assert.match(app.$('storage-warning').textContent, /导出/);
  const [result] = core.importCollection(await app.exportJson());
  assert.equal(result.status, 'revealed');
});

test('a storage read failure during saving produces a persistent warning and an exportable result', async () => {
  const storage = new Storage(); const app = start(storage);
  app.fill(); await app.submit('pair-form'); storage.failReads = true;
  await app.choose('right'); await app.submit('decision-form');
  assert.equal(app.$('storage-warning').hidden, false, 'Losing storage access after startup must be visible');
  assert.match(app.$('storage-warning').textContent, /导出/);
  assert.equal(core.importCollection(await app.exportJson())[0].decision.choice, 'right');
});

test('a corrupt existing archive is preserved and prevents accidental replacement by a fresh record', async () => {
  const raw = '{"broken": original bytes'; const storage = new Storage({ [KEY]: raw }); const app = start(storage);
  assert.equal(app.$('storage-warning').hidden, false);
  app.fill(); await app.submit('pair-form');
  assert.equal(storage.getItem(KEY), raw);
  assert.equal(app.$('count').textContent, '0');
  assert.equal(app.$('question').value, '测试比较场景');
  const originalBackupButton = app.$('storage-warning').children.find(element => element.tagName === 'BUTTON');
  assert.ok(originalBackupButton, 'The user must have a way to download the unreadable original archive');
  await originalBackupButton.click();
  assert.equal(await app.blobs.get(app.downloads.at(-1).href).text(), raw);
});

test('restored drafts accept only known string fields and respect the input limits', () => {
  const storage = new Storage({ [DRAFT]: JSON.stringify({ question: '中'.repeat(7000), 'text-one': '<script>x</script>', 'source-one': 3, unexpected: 'ignored' }) });
  const app = start(storage);
  assert.equal(app.$('question').value.length, 6000);
  assert.equal(app.$('text-one').value, '<script>x</script>');
  assert.equal(app.$('source-one').value, '');
});

test('imported markup is rendered as text across history, comparison, sources and reasons', async () => {
  const hostile = '<img src=x onerror="globalThis.pwned=true"> [x](javascript:alert(1))';
  const record = core.createRecord({ question: hostile, left: { text: hostile, source: hostile }, right: { text: hostile + '二', source: '另一来源' } },
    { rng: () => 0, id: 'hostile', now: '2026-11-06T00:00:00.000Z' });
  const complete = core.finish(record, 'left', hostile, { now: '2026-11-06T00:01:00.000Z' });
  const storage = new Storage(); const app = start(storage); await app.import(core.exportCollection([complete]));
  assert.equal(app.$('history-list').children[0].children[0].children[0].textContent, hostile);
  await historyOpenButton(app).click();
  assert.equal(app.$('pair-question').textContent, hostile);
  assert.equal(app.$('left-text').textContent, hostile);
  assert.equal(app.$('left-source').textContent, hostile);
  assert.equal(app.$('saved-reason').textContent, hostile);
  assert.equal(app.$('left-text').children.length, 0, 'User markup is not constructed as DOM children');
});

test('a valid Unicode backup exported within the core character limit can be imported by the UI', async () => {
  const records = Array.from({ length: 25 }, (_, index) => core.createRecord({ question: '大文本往返测试', left: { text: '中'.repeat(30000), source: '一' }, right: { text: '文'.repeat(30000), source: '二' } },
    { rng: () => 0.2, id: 'unicode-' + index, now: '2026-11-06T00:00:00.000Z' }));
  const backup = core.exportCollection(records);
  assert.ok(backup.length < core.LIMITS.importCharacters);
  assert.ok(Buffer.byteLength(backup, 'utf8') > 4000000, 'Fixture crosses the old byte/character mismatch');
  const app = start(); await app.import(backup);
  assert.equal(app.$('count').textContent, '25', app.$('notice').textContent);
  assert.deepEqual(core.importCollection(await app.exportJson()), records);
});
