/* Blind Pairs: dependency-free comparison records. Full records contain sources;
 * pass visiblePair(record) to the unrevealed view. This is local source hiding,
 * not access control, tamper-proof storage, or a scientific double-blind trial. */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BlindPairsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var LIMITS = Object.freeze({
    question: 6000, text: 30000, source: 160, reason: 4000,
    records: 100, importCharacters: 4000000
  });
  var CHOICES = Object.freeze(['left', 'right', 'tie', 'neither']);
  var FORMAT = 'blind-pairs';
  var VERSION = 1;
  var RECORD_KEYS = ['id', 'question', 'candidates', 'order', 'status', 'createdAt', 'completedAt', 'decision'];

  function fail(code, message) {
    var error = new Error(message);
    error.name = 'ValidationError';
    error.code = code;
    throw error;
  }

  function exactObject(value, keys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('INVALID_OBJECT', label + '必须是对象。');
    }
    var proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      fail('INVALID_OBJECT', label + '的对象类型无效。');
    }
    var actual = Object.keys(value);
    if (actual.length !== keys.length || actual.some(function (key) { return keys.indexOf(key) === -1; })) {
      fail('INVALID_FIELDS', label + '的字段不完整或包含未知字段。');
    }
  }

  function plainText(value, limit, required, label) {
    if (typeof value !== 'string') fail('INVALID_TEXT', label + '必须是文字。');
    if (value.length > limit) fail('TEXT_TOO_LONG', label + '不能超过 ' + limit + ' 个字符。');
    if (required && value.trim().length === 0) fail('EMPTY_TEXT', label + '不能为空。');
    return value;
  }

  function timestamp(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
      fail('INVALID_DATE', label + '必须是有效的 ISO 时间。');
    }
    var date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
      fail('INVALID_DATE', label + '必须是有效的 ISO 时间。');
    }
    return value;
  }

  function now(options) {
    var value = options && options.now;
    if (typeof value === 'function') value = value();
    return timestamp(value === undefined ? new Date().toISOString() : value, '记录时间');
  }

  function cryptoSource() {
    if (root.crypto && typeof root.crypto.getRandomValues === 'function') return root.crypto;
    if (typeof require === 'function') {
      try { return require('node:crypto').webcrypto; } catch (_) { /* Browser has no require. */ }
    }
    fail('CRYPTO_UNAVAILABLE', '当前环境没有安全随机数功能，请使用较新的浏览器。');
  }

  function randomFraction() {
    var bytes = new Uint32Array(1);
    cryptoSource().getRandomValues(bytes);
    return bytes[0] / 4294967296;
  }

  function newId() {
    var bytes = new Uint8Array(16);
    cryptoSource().getRandomValues(bytes);
    return 'bp-' + Array.from(bytes, function (value) { return value.toString(16).padStart(2, '0'); }).join('');
  }

  function recordId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
      fail('INVALID_ID', '记录编号无效。');
    }
    return value;
  }

  function candidate(value, label) {
    exactObject(value, ['text', 'source'], label);
    return Object.freeze({
      text: plainText(value.text, LIMITS.text, true, label + '正文'),
      source: plainText(value.source, LIMITS.source, false, label + '来源')
    });
  }

  function validateRecord(value) {
    exactObject(value, RECORD_KEYS, '记录');
    if (!Array.isArray(value.candidates) || value.candidates.length !== 2) {
      fail('INVALID_CANDIDATES', '每组必须恰好包含两个候选内容。');
    }
    if (!Array.isArray(value.order) || value.order.length !== 2 ||
        !((value.order[0] === 0 && value.order[1] === 1) || (value.order[0] === 1 && value.order[1] === 0))) {
      fail('INVALID_ORDER', '左右顺序必须是两个候选内容的一次排列。');
    }
    if (value.status !== 'pending' && value.status !== 'revealed') {
      fail('INVALID_STATUS', '记录状态无效。');
    }
    var decision = null;
    var completedAt = null;
    var createdAt = timestamp(value.createdAt, '创建时间');
    if (value.status === 'pending') {
      if (value.decision !== null || value.completedAt !== null) {
        fail('INVALID_STATE', '尚未揭晓的记录不能带有已提交的选择或完成时间。');
      }
    } else {
      exactObject(value.decision, ['choice', 'reason'], '选择');
      if (CHOICES.indexOf(value.decision.choice) === -1) fail('INVALID_CHOICE', '请选择左侧、右侧、差不多或都不合适。');
      decision = Object.freeze({
        choice: value.decision.choice,
        reason: plainText(value.decision.reason, LIMITS.reason, false, '选择理由')
      });
      completedAt = timestamp(value.completedAt, '完成时间');
      if (completedAt < createdAt) fail('INVALID_DATE_ORDER', '完成时间不能早于创建时间。');
    }
    return Object.freeze({
      id: recordId(value.id),
      question: plainText(value.question, LIMITS.question, true, '题目'),
      candidates: Object.freeze([candidate(value.candidates[0], '候选一'), candidate(value.candidates[1], '候选二')]),
      order: Object.freeze([value.order[0], value.order[1]]),
      status: value.status,
      createdAt: createdAt,
      completedAt: completedAt,
      decision: decision
    });
  }

  function createRecord(input, options) {
    exactObject(input, ['question', 'left', 'right'], '新建内容');
    options = options || {};
    var rng = options.rng === undefined ? randomFraction : options.rng;
    if (typeof rng !== 'function') fail('INVALID_RANDOM', '随机数生成器无效。');
    var draw = rng();
    if (typeof draw !== 'number' || !Number.isFinite(draw) || draw < 0 || draw >= 1) {
      fail('INVALID_RANDOM', '随机数必须在 0（含）至 1（不含）之间。');
    }
    return validateRecord({
      id: options.id === undefined ? newId() : options.id,
      question: input.question,
      candidates: [input.left, input.right],
      order: draw < 0.5 ? [0, 1] : [1, 0],
      status: 'pending',
      createdAt: now(options),
      completedAt: null,
      decision: null
    });
  }

  function project(record, includeSources) {
    var value = validateRecord(record);
    if (includeSources && value.status !== 'revealed') fail('NOT_REVEALED', '先提交选择，再揭晓来源。');
    function side(index) {
      var item = value.candidates[value.order[index]];
      return includeSources ? Object.freeze({ text: item.text, source: item.source }) : Object.freeze({ text: item.text });
    }
    return Object.freeze({
      id: value.id,
      question: value.question,
      left: side(0),
      right: side(1),
      status: value.status,
      createdAt: value.createdAt,
      completedAt: value.completedAt,
      choice: value.decision ? value.decision.choice : null,
      reason: value.decision ? value.decision.reason : ''
    });
  }

  function visiblePair(record) { return project(record, false); }
  function reveal(record) { return project(record, true); }

  function finish(record, choice, reason, options) {
    var value = validateRecord(record);
    if (value.status !== 'pending') fail('ALREADY_REVEALED', '这组已经揭晓，原选择已锁定。可以新建一组重新比较。');
    return validateRecord({
      id: value.id, question: value.question, candidates: value.candidates, order: value.order,
      status: 'revealed', createdAt: value.createdAt, completedAt: now(options),
      decision: { choice: choice, reason: reason === undefined ? '' : reason }
    });
  }

  function validateCollection(records) {
    if (!Array.isArray(records)) fail('INVALID_COLLECTION', '记录列表必须是数组。');
    if (records.length > LIMITS.records) fail('TOO_MANY_RECORDS', '最多保存 ' + LIMITS.records + ' 组记录。');
    var seen = new Set();
    return Object.freeze(records.map(function (record) {
      var clean = validateRecord(record);
      if (seen.has(clean.id)) fail('DUPLICATE_ID', '记录编号重复，无法确定应该恢复哪一组。');
      seen.add(clean.id);
      return clean;
    }));
  }

  function exportCollection(records) {
    var clean = validateCollection(records);
    var json = JSON.stringify({ format: FORMAT, version: VERSION, records: clean }, null, 2);
    if (json.length > LIMITS.importCharacters) fail('EXPORT_TOO_LARGE', '记录总量过大，请减少记录后再导出。');
    return json;
  }

  function importCollection(json) {
    if (typeof json !== 'string') fail('INVALID_JSON', '请导入 JSON 文本。');
    if (json.length > LIMITS.importCharacters) fail('IMPORT_TOO_LARGE', '导入文件过大，请选择本工具导出的较小文件。');
    var value;
    try { value = JSON.parse(json); } catch (_) { fail('INVALID_JSON', 'JSON 文件无法解析。'); }
    exactObject(value, ['format', 'version', 'records'], '导入文件');
    if (value.format !== FORMAT) fail('INVALID_FORMAT', '这不是回答盲选板的备份文件。');
    if (value.version !== VERSION) fail('UNSUPPORTED_VERSION', '暂不支持这个备份版本。');
    return validateCollection(value.records);
  }

  function markdownText(value) {
    return value.replace(/[&<>]/g, function (character) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character]; })
      .replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&');
  }

  function toMarkdown(records) {
    var clean = validateCollection(records);
    var labels = { left: '左侧', right: '右侧', tie: '差不多', neither: '都不合适' };
    var lines = ['# 回答盲选板记录', '', '本地隐藏来源对照；结果只代表记录者在该题上的选择。', ''];
    clean.forEach(function (record, index) {
      var view = record.status === 'revealed' ? reveal(record) : visiblePair(record);
      lines.push('## ' + (index + 1) + '. ' + markdownText(view.question), '', '创建时间：' + view.createdAt, '',
        '### 左侧', '', markdownText(view.left.text), '', '### 右侧', '', markdownText(view.right.text), '');
      if (record.status === 'revealed') {
        lines.push('选择：' + labels[view.choice], '', '理由：' + markdownText(view.reason || '未填写'), '',
          '左侧来源：' + markdownText(view.left.source || '未填写'), '',
          '右侧来源：' + markdownText(view.right.source || '未填写'), '', '完成时间：' + view.completedAt, '');
      } else {
        lines.push('状态：尚未揭晓；此报告不包含来源。', '');
      }
    });
    return lines.join('\n');
  }

  return Object.freeze({
    FORMAT: FORMAT, VERSION: VERSION, LIMITS: LIMITS, CHOICES: CHOICES,
    createRecord: createRecord, visiblePair: visiblePair, finish: finish, reveal: reveal,
    validateRecord: validateRecord, validateCollection: validateCollection,
    exportCollection: exportCollection, importCollection: importCollection, toMarkdown: toMarkdown
  });
});
