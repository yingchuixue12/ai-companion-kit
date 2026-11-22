import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../src/brain.js';
import { Memory } from '../src/memory.js';

test('serialized budget drops recent conversation, then only the oldest whole topics needed to fit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-topics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memory = new Memory({ dir });
  const role = { build: ({ memory, recent, situation }) => ['STABLE', situation, memory, recent].join('\n') };
  const input = { key: 'private:current', userId: 'sample', text: 'INPUT', situation: 'SITUATION', record: false };
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, request) => {
    bodies.push(request.body);
    return { ok: true, text: async () => '{"choices":[{"message":{"content":"ok"}}]}' };
  };
  t.after(() => { globalThis.fetch = original; });
  const reply = async (limit, source = memory) => {
    await new Brain({ apiKey: 'offline-test', role, memory: source, maxInputChars: limit }).reply(input);
    return bodies.at(-1);
  };
  const system = (body) => JSON.parse(body).messages[0].content;

  const oldTopic = 'OLD_TOPIC "' + '\\'.repeat(60);
  const newTopic = 'NEW_TOPIC ' + '语'.repeat(50);
  memory.remember('sample', { fact: 'FACT', topic: oldTopic });
  memory.remember('sample', { pending: 'PENDING', topic: newTopic });
  memory.logTurn({ where: 'private:other', who: 'sample', text: 'OTHER_RECENT', reply: 'OTHER_REPLY' });
  const snapshot = fs.readFileSync(memory.peopleFile, 'utf8');
  const full = await reply(20_000);
  assert.ok(system(full).includes('OLD_TOPIC'));
  assert.ok(system(full).includes('OTHER_RECENT'));
  const sizeFor = (memory, situation = input.situation) => JSON.stringify({
    ...JSON.parse(full),
    messages: [{ role: 'system', content: role.build({ memory, recent: '', situation }) }, JSON.parse(full).messages[1]],
  }).length;

  const recentOnly = system(await reply(sizeFor(memory.renderPerson('sample'))));
  assert.ok(recentOnly.includes('OLD_TOPIC'));
  assert.ok(!recentOnly.includes('OTHER_RECENT'));

  const trimmed = await reply(sizeFor(memory.renderPerson('sample').replace(`${oldTopic}；`, '')));
  assert.ok(system(trimmed).startsWith('STABLE\nSITUATION'));
  assert.ok(system(trimmed).includes(`你们聊过：${newTopic}`));
  assert.ok(system(trimmed).includes('FACT'));
  assert.ok(system(trimmed).includes('PENDING'));
  assert.ok(!system(trimmed).includes('OLD_TOPIC'));
  assert.ok(!system(trimmed).includes('OTHER_RECENT'));
  assert.equal(fs.readFileSync(memory.peopleFile, 'utf8'), snapshot);

  const onlyNonTopics = memory.renderPerson('sample').replace(/^你们聊过：.*\n/m, '');
  const withoutTopics = system(await reply(sizeFor(onlyNonTopics)));
  assert.ok(withoutTopics.includes('FACT'));
  assert.ok(!withoutTopics.includes('你们聊过'));
  assert.ok(!system(await reply(sizeFor(''))).includes('FACT'));

  const legacy = { renderPerson: () => memory.renderPerson('sample'), renderRecent: () => '' };
  assert.ok(!system(await reply(sizeFor(onlyNonTopics), legacy)).includes('FACT'));
  const noMemory = { renderPerson: () => '', renderRecent: () => 'RECENT', personTopicView: () => assert.fail() };
  assert.ok(!system(await reply(sizeFor(''), noMemory)).includes('RECENT'));
});
