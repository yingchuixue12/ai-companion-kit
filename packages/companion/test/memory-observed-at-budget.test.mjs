import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetMemoryBlock } from '../src/memory/prompt-budget.js';

const topic = (id, observedAt, text = id) => Object.freeze({
  id, kind: 'topic', layer: 'shared_experience', observedAt, text,
});
const opt = { preferRecentExperiences: true };

test('time-based retention is explicit and keeps surviving entries in source order', () => {
  const inputs = Object.freeze([
    topic('middle', '2026-03-02T08:00:00+08:00'),
    topic('old', '2026-03-01T23:59:59Z'),
    Object.freeze({ id: 'legacy', kind: 'topic', text: 'legacy' }),
    topic('new', '2026-03-02T00:00:01Z'),
    Object.freeze({ id: 'fact', kind: 'fact', layer: 'user_fact', text: 'fact' }),
  ]);
  assert.deepEqual(budgetMemoryBlock(inputs, { maxRecords: 4 }).included, ['fact', 'middle', 'old', 'legacy']);
  const budget = budgetMemoryBlock(inputs, { ...opt, maxRecords: 4 });
  assert.deepEqual(budget.included, ['fact', 'middle', 'legacy', 'new']);
  assert.equal(budget.text, '他告诉过你：fact\n你们聊过：middle；legacy；new');
  assert.deepEqual(budget.omitted, [{ id: 'old', kind: 'topic', reason: 'budget' }]);
  assert.deepEqual(budgetMemoryBlock(inputs, opt), budgetMemoryBlock(inputs));
});

test('invalid or unzoned dates lose priority; equal instants preserve source order', () => {
  const inputs = [
    topic('missing', null),
    topic('day', '2026-02-30T00:00:00Z'),
    topic('bad-month', '2026-13-01T00:00:00Z'),
    topic('bad-offset', '2026-01-01T00:00:00+99:00'),
    topic('ambiguous', '2026-01-01T00:00:00'),
    topic('first', '2020-01-01T10:00:00+10:00'),
    topic('second', '2020-01-01T00:00:00.000Z'),
    topic('newest', '2020-01-01T00:00:00.001Z'),
  ];
  const budget = budgetMemoryBlock(inputs, { ...opt, maxRecords: 2 });
  assert.deepEqual(budget.included, ['first', 'newest']);
  assert.deepEqual(budget.omitted.map((entry) => entry.id), ['second', 'missing', 'day', 'bad-month', 'bad-offset', 'ambiguous']);
});

test('serialized text uses UTF-16 and an older experience cannot replace a too-long newer one', () => {
  const inputs = [
    topic('old', '2026-01-01T00:00:00Z', 'old-private'),
    topic('new', '2026-01-02T00:00:00Z', '😀😀'),
  ];
  const render = (entry) => entry.text;
  const exact = budgetMemoryBlock(inputs, { ...opt, render, maxChars: 4 });
  assert.equal(exact.charsUsed, 4);
  assert.equal(exact.text, '😀😀');
  assert.deepEqual(exact.included, ['new']);
  const tooLong = budgetMemoryBlock([topic('old', '2026-01-01T00:00:00Z', 'a'), inputs[1]], {
    ...opt, render, maxChars: 3,
  });
  assert.equal(tooLong.text, '');
  assert.deepEqual(tooLong.omitted.map((entry) => entry.id), ['new', 'old']);
  assert.doesNotMatch(JSON.stringify([exact.omitted, exact.diagnostics, tooLong.diagnostics]), /old-private|😀/u);
});
