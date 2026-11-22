import assert from 'node:assert/strict';
import test from 'node:test';
import { Brain } from '../src/brain.js';
import { Role } from '../src/role.js';

const input = { key: 'private:fixture', userId: 'fixture', text: 'user-marker', record: false };
const layeredRole = () => {
  const role = new Role({ layered: true });
  role.read = () => 'stable-card-marker:' + '白'.repeat(195);
  return role;
};

function setup(t, options = {}) {
  const calls = [];
  const events = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, { body }) => {
    calls.push(body);
    return { ok: true, text: async () => '{"choices":[{"message":{"content":"ok"}}]}' };
  };
  t.after(() => { globalThis.fetch = original; });
  const brain = new Brain({
    apiKey: 'test',
    role: layeredRole(),
    memory: { renderPerson: () => '', renderRecent: () => '' },
    maxInputChars: 4_000,
    onMemoryBudget: (event) => events.push(event),
    ...options,
  });
  return { brain, events, calls };
}

const sys = (body) => JSON.parse(body).messages[0].content;
const rows = (items, countName) => ({
  text: items.join('\n'),
  [countName]: items.length,
  renderFrom: (n) => items.slice(n).join('\n'),
});

test('opt-in quota keeps newest complete units, with count-only diagnostics', async (t) => {
  const rounds = rows(['old-round:' + '🟠'.repeat(150), 'new-round'], 'roundCount');
  const topics = rows(['old-topic:' + '字'.repeat(230), 'new-topic'], 'topicCount');
  const { brain, calls, events } = setup(t, {
    systemBudgetChars: 1_000,
    memory: {
      renderPerson: () => topics.text,
      recentRoundView: () => rounds,
      personTopicView: () => topics,
    },
  });
  await brain.reply({
    ...input,
    situation: 'context-marker:' + 's'.repeat(100),
    platform: 'platform-marker:' + 'p'.repeat(50),
    taskReferences: 'task-marker',
  });
  const prompt = sys(calls[0]);
  assert.ok(prompt.includes('stable-card-marker:'));
  assert.ok(prompt.includes('new-round'));
  assert.ok(prompt.includes('new-topic'));
  assert.ok(prompt.includes('platform-marker:'));
  assert.ok(prompt.includes('task-marker'));
  for (const marker of ['old-round', 'old-topic', 'context-marker']) assert.ok(!prompt.includes(marker));
  const [event] = events;
  assert.equal(event.version, 2);
  assert.equal(event.roundsDropped, 1);
  assert.equal(event.topicsDropped, 1);
  assert.deepEqual(event.quotas.dropped, ['recent', 'memory', 'situation']);
  assert.equal(event.quotas.systemCharsUsed, prompt.length);
  assert.equal(event.quotas.protocolOverTarget, true);
  assert.deepEqual(event.evictedParts, ['situation']);
  assert.doesNotMatch(JSON.stringify(event), /marker|fixture|new-round|new-topic/);
});

test('system target removes older rounds before memory and task references', async (t) => {
  const rounds = rows(['a'.repeat(115), 'new-round'], 'roundCount');
  const role = layeredRole();
  const parts = { recent: 'new-round', memory: 'keep-memory', situation: 'keep-situation', taskReferences: 'keep-task' };
  const cap = role.build(parts).length;
  const { brain, calls, events } = setup(t, {
    role,
    systemBudgetChars: cap,
    memory: { renderPerson: () => parts.memory, recentRoundView: () => rounds },
  });
  await brain.reply({ ...input, situation: parts.situation, taskReferences: parts.taskReferences });
  assert.equal(sys(calls[0]), role.build(parts));
  assert.deepEqual(events[0].quotas.dropped, ['recent']);
  assert.equal(events[0].roundsKept, 1);
});

test('quota never truncates stable role or protocol; request overflow never dispatches', async (t) => {
  const { brain, calls, events } = setup(t, { systemBudgetChars: 300, maxInputChars: 900 });
  const platform = 'required-protocol:' + 'p'.repeat(600);
  await assert.rejects(brain.reply({ ...input, platform, taskReferences: 'r'.repeat(200) }), {
    code: 'context-budget-overflow',
  });
  assert.equal(calls.length, 0);
  assert.equal(events[0].withinBudget, false);
  assert.deepEqual(events[0].quotas.dropped, ['taskReferences']);
  assert.equal(events[0].quotas.l1WithinTarget, false);
  assert.equal(events[0].quotas.protocolOverTarget, true);
});

test('default gives the existing request and event; quotas require an explicit compatible role', async (t) => {
  const { brain, calls, events } = setup(t);
  await brain.reply(input);
  assert.equal(sys(calls[0]), brain.role.build());
  assert.equal(events[0].version, 1);
  assert.equal(Object.hasOwn(events[0], 'quotas'), false);
  for (const systemBudgetChars of [0, 50_000, 0.5]) {
    assert.throws(() => new Brain({ systemBudgetChars, role: layeredRole() }), /systemBudgetChars/);
  }
  assert.throws(() => new Brain({ systemBudgetChars: 500, role: new Role() }), /systemBudgetChars/);
});

test('opaque memory and a failed recent renderer fall back to whole reference blocks', async (t) => {
  const data = 'too-long:' + '🟠'.repeat(200);
  const { brain, calls, events } = setup(t, {
    systemBudgetChars: 900,
    memory: {
      renderPerson: () => data,
      recentRoundView: () => ({ text: data, roundCount: 2, renderFrom() { throw Error('fixture'); } }),
      personTopicView: () => ({ text: 'different snapshot', topicCount: 2, renderFrom: () => 'wrong' }),
    },
  });
  await brain.reply(input);
  assert.doesNotMatch(sys(calls[0]), /too-long|wrong/);
  assert.deepEqual(events[0].evictedParts, ['recent', 'memory']);
});
