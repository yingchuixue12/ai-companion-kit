/**
 * presence/persistence · 状态文件的离线测试
 * ─────────────────────────────────────────────────────────────
 * 只用注入时钟 + 临时目录，不联网、不装定时器、不读写生产 data/。
 * 覆盖：白名单 schema、内容盲、原子写、损坏 fail-closed、TTL、超限、清空、
 * 台账编解码，以及「不联网 / 不装定时器」的源码守卫。
 *
 * 边界补强（与上面十条同口径，全部使用合成数据）：
 *   - 每个归一化分支的**负向**错误码，避免「只测到 ok:false」漏掉具体原因；
 *   - 冷却表的未知键（读/写两种严格度）、台账去重与截断、白名单缺省值；
 *   - 读/写两侧的 IO 异常（unreadable / not-a-file / 目录不可建 / 目标被占用）；
 *   - 注入时钟抛错或返回不可解析值 → clock-unavailable，绝不猜时间。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PresenceStateStore, {
  PRESENCE_DELIVERED_LEDGER_STATUSES,
  PRESENCE_COOLDOWN_KEYS,
  PRESENCE_LEDGER_STATUSES,
  PRESENCE_STATE_KEYS,
  PRESENCE_STATE_KIND,
  PRESENCE_STATE_VERSION,
  PresenceStateStore as NamedStore,
  createPresenceStateStore,
  formatPresenceLedgerEntry,
  isPresenceDeliveredEntry,
  parsePresenceLedgerEntry,
  presenceLocalDayKey,
} from '../src/presence/persistence.js';

const T0 = Date.parse('2026-10-29T12:00:00.000Z');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'presence-state-'));
}

function validState(overrides = {}) {
  return {
    version: PRESENCE_STATE_VERSION,
    state: 'present',
    updatedAt: T0,
    sessionStartedAt: T0,
    activeMs: 1234,
    cooldowns: { welcome: T0 - 60_000, break: null, proactive: null },
    deliveredIds: [],
    ...overrides,
  };
}

function withDir(run) {
  const dir = tempDir();
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 写入一份状态文件并断言它确实被读回；返回 load() 结果。 */
function writeRaw(file, value) {
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

test('save then load round-trips the whitelisted state and nothing else', () => {
  withDir((dir) => {
    const file = path.join(dir, 'presence-web-state.json');
    const store = new PresenceStateStore({ file, now: () => T0 + 5_000 });
    const entry = formatPresenceLedgerEntry({ dayKey: presenceLocalDayKey(T0), status: 'sent', id: 'presence-interaction:welcome-back:1' });
    const saved = store.save(validState({ deliveredIds: [entry] }));
    assert.deepEqual(saved, { ok: true, persisted: true });
    assert.equal(fs.existsSync(file), true);

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(raw).sort(), [
      'activeMs', 'cooldowns', 'deliveredIds', 'kind', 'sessionStartedAt', 'state', 'updatedAt', 'version',
    ]);
    assert.equal(raw.kind, PRESENCE_STATE_KIND);
    assert.equal(raw.version, 1);
    assert.equal(raw.updatedAt, T0 + 5_000, 'updatedAt is stamped at save time');

    const loaded = store.load();
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.diagnostics, []);
    assert.deepEqual(loaded.state, {
      version: 1,
      state: 'present',
      updatedAt: T0 + 5_000,
      sessionStartedAt: T0,
      activeMs: 1234,
      cooldowns: { welcome: T0 - 60_000, break: null, proactive: null },
      deliveredIds: [entry],
    });
  });
});

test('content stays out of the file even if the caller passes text/title/url/account', () => {
  withDir((dir) => {
    const file = path.join(dir, 'presence-qq-state.json');
    const store = new PresenceStateStore({ file, now: () => T0 });
    const noisy = validState({
      text: 'SECRET_MESSAGE_TEXT_SHOULD_NOT_PERSIST',
      windowTitle: 'SECRET_WINDOW_TITLE',
      app: 'SECRET_APP_NAME',
      url: 'https://secret.example.com/private',
      account: 'owner-account-12345',
      transcript: 'SECRET_TRANSCRIPT',
      userId: 'someone',
    });
    assert.equal(store.save(noisy).ok, true);

    const text = fs.readFileSync(file, 'utf8');
    for (const secret of [
      'SECRET_MESSAGE_TEXT_SHOULD_NOT_PERSIST', 'SECRET_WINDOW_TITLE', 'SECRET_APP_NAME',
      'secret.example.com', 'owner-account-12345', 'SECRET_TRANSCRIPT', 'someone',
    ]) {
      assert.equal(text.includes(secret), false, 'state file must not contain ' + secret);
    }
    assert.deepEqual(Object.keys(store.load().state).sort(), [
      'activeMs', 'cooldowns', 'deliveredIds', 'sessionStartedAt', 'state', 'updatedAt', 'version',
    ]);
  });
});

test('writes atomically: no temp files left behind, previous file survives a failed write', () => {
  withDir((dir) => {
    const file = path.join(dir, 'presence-web-state.json');
    const store = new PresenceStateStore({ file, now: () => T0 });
    store.save(validState({ activeMs: 10 }));
    assert.deepEqual(fs.readdirSync(dir), ['presence-web-state.json']);
    assert.equal(fs.readdirSync(dir).some((name) => name.includes('.tmp-')), false);

    store.save(validState({ activeMs: 20 }));
    assert.deepEqual(fs.readdirSync(dir), ['presence-web-state.json']);
    assert.equal(store.load().state.activeMs, 20);

    // 让目录不可创建：把目标文件的父目录换成一个普通文件。
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const brokenStore = new PresenceStateStore({ file: path.join(blocker, 'state.json'), now: () => T0 });
    const failed = brokenStore.save(validState());
    assert.equal(failed.ok, false);
    assert.equal(failed.persisted, false);
    assert.equal(typeof failed.error, 'string');
    // 原来那份完整文件没有被半截数据覆盖。
    assert.equal(store.load().state.activeMs, 20);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['blocker', 'presence-web-state.json']);
  });
});

test('corrupt or unexpected files fail closed instead of guessing', () => {
  withDir((dir) => {
    const file = path.join(dir, 'presence-web-state.json');
    const store = new PresenceStateStore({ file, now: () => T0 });

    writeRaw(file, '{ this is not json');
    const invalidJson = store.load();
    assert.equal(invalidJson.ok, false);
    assert.equal(invalidJson.state, null);
    assert.equal(invalidJson.diagnostics[0].code, 'corrupt');
    assert.equal(fs.existsSync(file), true, 'corrupt file is preserved for diagnosis');

    writeRaw(file, { ...validState(), kind: 'some-other-kind' });
    assert.equal(store.load().diagnostics[0].code, 'corrupt');

    writeRaw(file, { ...validState(), version: 99 });
    assert.equal(store.load().diagnostics[0].code, 'incompatible-version');

    writeRaw(file, { ...validState(), note: 'smuggled content' });
    assert.equal(store.load().diagnostics[0].code, 'corrupt');
    assert.equal(store.load().diagnostics[0].detail, 'unexpected-fields');

    writeRaw(file, validState({ state: 'busy' }));
    assert.equal(store.load().ok, false);

    writeRaw(file, validState({ cooldowns: { welcome: 'yesterday' } }));
    assert.equal(store.load().ok, false);

    writeRaw(file, validState({ deliveredIds: ['not-a-ledger-entry'] }));
    assert.equal(store.load().ok, false);

    writeRaw(file, validState({ updatedAt: T0 + 60 * 60 * 1000 }));
    assert.equal(store.load().ok, false, 'far-future updatedAt is treated as corrupt');

    fs.rmSync(file);
    assert.deepEqual(store.load(), { ok: true, state: null, diagnostics: [{ code: 'absent' }] });
  });
});

test('TTL expires stale state without calling it corrupt', () => {
  withDir((dir) => {
    const file = path.join(dir, 'presence-web-state.json');
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    new PresenceStateStore({ file, now: () => T0, maxAgeMs }).save(validState());

    const fresh = new PresenceStateStore({ file, now: () => T0 + maxAgeMs - 1, maxAgeMs }).load();
    assert.equal(fresh.ok, true);
    assert.equal(fresh.state.state, 'present');

    const stale = new PresenceStateStore({ file, now: () => T0 + maxAgeMs + 1, maxAgeMs }).load();
    assert.equal(stale.ok, true);
    assert.equal(stale.state, null);
    assert.equal(stale.diagnostics[0].code, 'expired');
    assert.equal(fs.existsSync(file), true, 'expired state is not deleted behind the caller');
  });
});

test('oversized files and oversized state are rejected', () => {
  withDir((dir) => {
    const file = path.join(dir, 'presence-web-state.json');
    writeRaw(file, 'x'.repeat(2048));
    const store = new PresenceStateStore({ file, now: () => T0, maxBytes: 512 });
    const oversized = store.load();
    assert.equal(oversized.ok, false);
    assert.equal(oversized.diagnostics[0].code, 'oversized');

    fs.rmSync(file);
    const tiny = new PresenceStateStore({ file, now: () => T0, maxBytes: 120 });
    const saved = tiny.save(validState());
    assert.equal(saved.ok, false);
    assert.equal(saved.persisted, false);
    assert.equal(saved.error, 'state-too-large');
    assert.equal(fs.existsSync(file), false);
  });
});

test('clear() removes the file and is idempotent', () => {
  withDir((dir) => {
    const file = path.join(dir, 'presence-web-state.json');
    const store = new PresenceStateStore({ file, now: () => T0 });
    store.save(validState());
    assert.deepEqual(store.clear(), { ok: true });
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(store.clear(), { ok: true });
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('ledger entries are strict, content-blind strings', () => {
  const dayKey = presenceLocalDayKey(T0);
  assert.match(dayKey, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(presenceLocalDayKey('nope'), '');

  const sent = formatPresenceLedgerEntry({ dayKey, status: 'sent', id: 'presence-interaction:welcome-back:1' });
  assert.equal(sent, dayKey + '|sent|presence-interaction:welcome-back:1');
  assert.deepEqual(parsePresenceLedgerEntry(sent), { dayKey, status: 'sent', id: 'presence-interaction:welcome-back:1' });
  assert.equal(isPresenceDeliveredEntry(sent), true);
  assert.equal(isPresenceDeliveredEntry(formatPresenceLedgerEntry({ dayKey, status: 'unknown', id: 'x' })), false);

  assert.equal(formatPresenceLedgerEntry({ dayKey, status: 'sent', id: 'has|pipe' }), null);
  assert.equal(formatPresenceLedgerEntry({ dayKey, status: 'sent', id: 'has space' }), null);
  assert.equal(formatPresenceLedgerEntry({ dayKey, status: 'sent', id: 'x'.repeat(121) }), null);
  assert.equal(formatPresenceLedgerEntry({ dayKey: '2026/10/29', status: 'sent', id: 'x' }), null);
  assert.equal(formatPresenceLedgerEntry({ dayKey, status: 'exploded', id: 'x' }), null);
  assert.equal(parsePresenceLedgerEntry('garbage'), null);
  assert.equal(parsePresenceLedgerEntry(42), null);
});

test('constructor validates its file path and factories stay wired', () => {
  assert.throws(() => new PresenceStateStore({}), TypeError);
  assert.throws(() => new PresenceStateStore({ file: '   ' }), TypeError);
  assert.equal(NamedStore, PresenceStateStore);
  const store = createPresenceStateStore({ file: path.join(os.tmpdir(), 'presence-factory-unused.json') });
  assert.equal(store instanceof PresenceStateStore, true);
  assert.equal(store.file.endsWith('presence-factory-unused.json'), true);
  assert.equal(store.maxAgeMs, 7 * 24 * 60 * 60 * 1000);
});

test('module is offline, timer-free and only touches fs', () => {
  const source = fs.readFileSync(new URL('../src/presence/persistence.js', import.meta.url), 'utf8');
  const importLines = source.match(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?/gm) ?? [];
  assert.deepEqual(importLines.map((line) => /from\s+(['"][^'"]+['"])/.exec(line)[1]), [
    "'node:fs'",
    "'node:path'",
  ]);
  for (const pattern of [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bsetInterval\b/,
    /\bsetTimeout\b/,
    /\bsetImmediate\b/,
    /\bMath\.random\b/,
    /\bchild_process\b/,
    /from\s+['"][^'"]*qq\.js['"]/,
    /from\s+['"][^'"]*server\.js['"]/,
  ]) {
    assert.equal(pattern.test(source), false, 'unexpected pattern in persistence.js: ' + pattern);
  }
});

// ───────────────────────── 边界补强（合成数据，仍只碰临时目录） ─────────────────────────

test('every normalization branch reports its own error code (write side, lenient)', () => {
  withDir((dir) => {
    const store = new PresenceStateStore({ file: path.join(dir, 'state.json'), now: () => T0 });
    // 注意：updatedAt 由 save() 按注入时钟重新盖章，写入侧永远不会报 invalid-updated-at；
    // 该校验只在读回旧文件时生效（见下面 read side 的 strict 用例）。
    const cases = [
      ['invalid-state', null],
      ['invalid-state', 'present'],
      ['invalid-state', [1, 2]],
      ['invalid-state-value', validState({ state: 'awake' })],
      ['invalid-state-value', validState({ state: 7 })],
      ['invalid-session-started-at', validState({ sessionStartedAt: 'noon' })],
      ['invalid-active-ms', validState({ activeMs: 'a lot' })],
      ['invalid-active-ms', validState({ activeMs: -5 })],
      ['invalid-cooldowns', validState({ cooldowns: 'welcome' })],
      ['invalid-cooldowns', validState({ cooldowns: [T0] })],
      ['invalid-cooldowns', validState({ cooldowns: { welcome: 'yesterday' } })],
      ['invalid-delivered-ids', validState({ deliveredIds: 'a|sent|x' })],
      ['invalid-delivered-ids', validState({ deliveredIds: ['2026-10-29|breakfast|x'] })],
      ['incompatible-version', validState({ version: 2 })],
      ['incompatible-version', validState({ version: 'one' })],
    ];
    for (const [error, state] of cases) {
      const result = store.save(state);
      assert.deepEqual(result, { ok: false, persisted: false, error }, `write side must reject with ${error}`);
    }
    assert.equal(fs.existsSync(path.join(dir, 'state.json')), false, 'a rejected write leaves no file behind');
  });
});

test('normalization defaults: omitted fields become canonical nulls and zeros', () => {
  withDir((dir) => {
    const file = path.join(dir, 'state.json');
    const store = new PresenceStateStore({ file, now: () => T0 });
    assert.equal(store.save({ state: 'idle' }).ok, true, 'only `state` is mandatory; updatedAt is stamped by save()');
    assert.deepEqual(store.load().state, {
      version: 1,
      state: 'idle',
      updatedAt: T0,
      sessionStartedAt: null,
      activeMs: 0,
      cooldowns: { welcome: null, break: null, proactive: null },
      deliveredIds: [],
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).cooldowns, { welcome: null, break: null, proactive: null });
  });
});

test('read side is strict: unknown cooldown keys and partial objects fail closed', () => {
  withDir((dir) => {
    const file = path.join(dir, 'presence-web-state.json');
    const store = new PresenceStateStore({ file, now: () => T0 });

    writeRaw(file, { ...validState(), cooldowns: { welcome: null, break: null, proactive: null, bedtime: null } });
    assert.equal(store.load().diagnostics[0].detail, 'unexpected-cooldown-keys');

    writeRaw(file, validState({ sessionStartedAt: 'noon' }));
    assert.equal(store.load().diagnostics[0].detail, 'invalid-session-started-at');

    writeRaw(file, validState({ activeMs: -1 }));
    assert.equal(store.load().diagnostics[0].detail, 'invalid-active-ms');

    writeRaw(file, validState({ deliveredIds: 'a|sent|x' }));
    assert.equal(store.load().diagnostics[0].detail, 'invalid-delivered-ids');

    writeRaw(file, validState({ deliveredIds: ['2026-10-29|breakfast|x'] }));
    assert.equal(store.load().diagnostics[0].detail, 'invalid-delivered-ids');

    writeRaw(file, validState({ cooldowns: [T0] }));
    assert.equal(store.load().diagnostics[0].detail, 'invalid-cooldowns');

    writeRaw(file, validState({ version: 'one' }));
    assert.equal(store.load().diagnostics[0].code, 'incompatible-version');

    writeRaw(file, '[]');
    assert.equal(store.load().diagnostics[0].detail, 'not-an-object');

    writeRaw(file, '42');
    assert.equal(store.load().diagnostics[0].detail, 'not-an-object');
  });
});

test('lenient write side drops unknown keys instead of failing (whitelist rebuild)', () => {
  withDir((dir) => {
    const file = path.join(dir, 'state.json');
    const store = new PresenceStateStore({ file, now: () => T0 });
    const noisy = validState({
      cooldowns: { welcome: T0, break: null, proactive: null, bedtime: T0 },
      extra: { nested: 'dropped' },
    });
    assert.equal(store.save(noisy).ok, true, 'unknown cooldown keys are ignored on the lenient write path');
    assert.deepEqual(store.load().state.cooldowns, { welcome: T0, break: null, proactive: null });
    assert.equal('extra' in store.load().state, false);
  });
});

test('deliveredIds is deduplicated in order and truncated to the configured bound', () => {
  withDir((dir) => {
    const file = path.join(dir, 'state.json');
    const dayKey = presenceLocalDayKey(T0);
    const ids = Array.from({ length: 5 }, (_, index) => formatPresenceLedgerEntry({ dayKey, status: 'sent', id: 'm' + index }));
    const store = new PresenceStateStore({ file, now: () => T0, maxLedgerEntries: 3 });

    assert.equal(store.save(validState({ deliveredIds: [...ids, ids[0], ids[3]] })).ok, true);
    assert.deepEqual(store.load().state.deliveredIds, ids.slice(-3), 'duplicates collapse and the tail is kept');
  });
});

test('ledger helpers accept every whitelisted status and reject shapes that are not strings', () => {
  const dayKey = presenceLocalDayKey(T0);
  assert.deepEqual([...PRESENCE_STATE_KEYS].sort(), [
    'activeMs', 'cooldowns', 'deliveredIds', 'sessionStartedAt', 'state', 'updatedAt', 'version',
  ]);
  assert.deepEqual([...PRESENCE_COOLDOWN_KEYS], ['welcome', 'break', 'proactive']);
  assert.deepEqual([...PRESENCE_DELIVERED_LEDGER_STATUSES], ['sent', 'accepted']);

  for (const status of PRESENCE_LEDGER_STATUSES) {
    const entry = formatPresenceLedgerEntry({ dayKey, status, id: 'probe-' + status });
    assert.equal(entry, dayKey + '|' + status + '|probe-' + status);
    assert.deepEqual(parsePresenceLedgerEntry(entry), { dayKey, status, id: 'probe-' + status });
    assert.equal(isPresenceDeliveredEntry(entry), (status === 'sent' || status === 'accepted'));
  }

  assert.equal(formatPresenceLedgerEntry({ dayKey: 7, status: 'sent', id: 'x' }), null);
  assert.equal(formatPresenceLedgerEntry({ dayKey, status: 'sent', id: '   ' }), null);
  assert.equal(formatPresenceLedgerEntry({ dayKey, status: 'sent', id: 42 }), null);
  assert.equal(formatPresenceLedgerEntry(), null);
  assert.equal(parsePresenceLedgerEntry(null), null);
  assert.equal(isPresenceDeliveredEntry('not-a-ledger-entry'), false);
  assert.equal(isPresenceDeliveredEntry(undefined), false);

  assert.equal(presenceLocalDayKey(undefined), '');
  assert.equal(presenceLocalDayKey(new Date(T0)), dayKey, 'a Date is accepted as well as milliseconds');
});

test('dates and numeric inputs are normalized without trusting strings', () => {
  withDir((dir) => {
    const file = path.join(dir, 'state.json');
    const store = new PresenceStateStore({ file, now: () => T0 });
    const saved = store.save(validState({ sessionStartedAt: new Date(T0 - 1_000), activeMs: 1_234.9 }));
    assert.equal(saved.ok, true);
    const state = store.load().state;
    assert.equal(state.sessionStartedAt, T0 - 1_000, 'Date is stored as milliseconds');
    assert.equal(state.activeMs, 1_234, 'activeMs is truncated to an integer');
  });
});

test('injected clock failures surface as clock-unavailable instead of guessing', () => {
  withDir((dir) => {
    const file = path.join(dir, 'state.json');
    const throwing = new PresenceStateStore({ file, now: () => { throw new Error('clock exploded'); } });
    assert.deepEqual(throwing.save(validState()), { ok: false, persisted: false, error: 'clock-unavailable' });
    assert.equal(fs.existsSync(file), false);

    const nonsensical = new PresenceStateStore({ file, now: () => 'soon' });
    assert.equal(nonsensical.save(validState()).error, 'clock-unavailable');

    // 读侧：时钟不可用时仍然把结构合法的状态交回，并明确标注 clock-unavailable（不做过期判断）。
    const good = new PresenceStateStore({ file, now: () => T0 });
    good.save(validState());
    const loaded = new PresenceStateStore({ file, now: () => { throw new Error('clock exploded'); } }).load();
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.diagnostics, [{ code: 'clock-unavailable' }]);
    assert.equal(loaded.state.state, 'present');
  });
});

test('read side distinguishes unreadable, directory and IO failures from absence', () => {
  withDir((dir) => {
    const file = path.join(dir, 'presence-web-state.json');

    const asDirectory = new PresenceStateStore({ file: dir, now: () => T0 });
    assert.deepEqual(asDirectory.load().diagnostics, [{ code: 'not-a-file' }]);

    writeRaw(file, JSON.stringify(validState()));
    fs.mkdirSync(file + '.d', { recursive: true });
    // 用一个目录替代「文件被替换成目录」：statSync 成功但 isFile() 为 false。
    const swapped = new PresenceStateStore({ file: file + '.d', now: () => T0 });
    assert.equal(swapped.load().diagnostics[0].code, 'not-a-file');

    // 「父路径是普通文件」在部分文件系统上 stat 抛 ENOENT、在另一些上抛 ENOTDIR；
    // 产品只把 ENOENT 当 absent，其余按 unreadable 返回。这里按文件系统实际抛出的 code 断言。
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const under = new PresenceStateStore({ file: path.join(blocker, 'state.json'), now: () => T0 });
    const probeCode = (() => {
      try { fs.statSync(path.join(blocker, 'state.json')); return 'no-error'; } catch (error) { return error.code; }
    })();
    const underResult = under.load();
    assert.equal(underResult.state, null);
    if (probeCode === 'ENOENT') {
      assert.deepEqual(underResult, { ok: true, state: null, diagnostics: [{ code: 'absent' }] });
    } else {
      assert.equal(underResult.ok, false);
      assert.equal(underResult.diagnostics[0].code, 'unreadable');
      assert.equal(typeof underResult.diagnostics[0].detail, 'string');
    }
  });
});

test('save failures clean up the temp file and keep the previous snapshot intact', () => {
  withDir((dir) => {
    const file = path.join(dir, 'presence-web-state.json');
    const store = new PresenceStateStore({ file, now: () => T0 });
    assert.equal(store.save(validState({ activeMs: 100 })).ok, true);

    // 目标路径变成目录 → rename 失败，临时文件必须被清理，旧文件保持完整。
    fs.rmSync(file);
    fs.mkdirSync(file);
    const failed = store.save(validState({ activeMs: 200 }));
    assert.equal(failed.ok, false);
    assert.equal(failed.persisted, false);
    assert.equal(typeof failed.error, 'string');
    assert.deepEqual(fs.readdirSync(dir), ['presence-web-state.json'], 'no .tmp- leftovers after a failed save');

    // clear() 对目录同样不抛，返回结构化错误。
    const cleared = store.clear();
    assert.equal(cleared.ok, false);
    assert.equal(typeof cleared.error, 'string');

    fs.rmdirSync(file);
    assert.deepEqual(store.load(), { ok: true, state: null, diagnostics: [{ code: 'absent' }] });
  });
});

test('invalid options fall back to defaults instead of throwing', () => {
  withDir((dir) => {
    const store = new PresenceStateStore({
      file: path.join(dir, 'state.json'),
      maxAgeMs: -1,
      maxBytes: 0,
      maxLedgerEntries: 0,
      now: 'not a function',
    });
    assert.equal(store.maxAgeMs, 7 * 24 * 60 * 60 * 1000);
    assert.equal(Number.isFinite(store.file), false);
    // now 不是函数时退回 Date.now()；只验证它能正常保存并读回，不依赖真实时间。
    const saved = store.save(validState());
    assert.equal(saved.ok, true);
    const loaded = store.load();
    assert.equal(loaded.ok, true);
    assert.equal(loaded.state.state, 'present');
    assert.equal(loaded.state.updatedAt >= T0, true, 'save() stamps the current time');
  });
});

test('a path the filesystem rejects is reported as unreadable, never as absent', () => {
  // NUL 字符在 Windows 上让 statSync 直接抛 ERR_INVALID_ARG_VALUE（非 ENOENT）。
  // 这是真实可触发的路径：产品必须把它归为 unreadable，而不能当成「没有状态」从而静默从干净状态重启。
  const invalid = path.join(os.tmpdir(), 'presence-state-bad\u0000name.json');
  const store = new PresenceStateStore({ file: invalid, now: () => T0 });
  const loaded = store.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.state, null);
  assert.equal(loaded.diagnostics[0].code, 'unreadable');
  assert.equal(typeof loaded.diagnostics[0].detail, 'string');
  assert.notDeepEqual(loaded.diagnostics, [{ code: 'absent' }], 'absence is only reported for a genuinely missing file');
  assert.equal(fs.existsSync(invalid), false);

  // 写入侧同样不抛，而是返回结构化错误。
  const saved = store.save({ state: 'present' });
  assert.equal(saved.ok, false);
  assert.equal(saved.persisted, false);
  assert.equal(typeof saved.error, 'string');
  assert.equal(store.clear().ok, false);
});

test('a state that cannot be serialized is refused before any file is touched', () => {
  withDir((dir) => {
    const file = path.join(dir, 'state.json');
    const store = new PresenceStateStore({ file, now: () => T0 });
    assert.equal(store.save(validState()).ok, true, 'baseline file exists and is valid');

    // JSON.stringify 失败只能来自全局 toJSON 抛错：验证路径是“序列化失败 → 不动磁盘”。
    const original = Object.prototype.toJSON;
    Object.prototype.toJSON = () => { throw new Error('toJSON exploded'); };
    let result;
    try {
      result = store.save(validState({ activeMs: 999 }));
    } finally {
      Object.prototype.toJSON = original;
    }
    assert.deepEqual(result, { ok: false, persisted: false, error: 'unserializable-state' });
    assert.deepEqual(store.load().state.activeMs, 1234, 'previous snapshot is untouched');
    assert.deepEqual(fs.readdirSync(dir), ['state.json'], 'no temp file is created for an unserializable state');
  });
});
