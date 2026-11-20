/**
 * 任务状态词表 · 共享模块与消费方测试
 * ────────────────────────────────────────────────────────────
 * 覆盖：agent-loop 转发导出的顺序与冻结、unknown 的归属、终态优先于
 * 已触发标志、陌生状态不猜、派发保留 unknown 且后轮不重发。
 * 全程离线：派发只读临时目录里的快照，sender 是内存里的假函数。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  DELIVERY_TASK_STATUSES,
} from '../src/agent-loop.js';
import * as shared from '../src/task-status.js';
import { classifyReminderRecovery } from '../src/reminder-recovery.js';
import { createReminderDispatcher } from '../src/reminder-dispatcher.js';
import { createReminderStore } from '../src/reminder-store.js';

test('agent-loop 转发导出：原有顺序、同一份对象、全部冻结', () => {
  assert.deepEqual(TASK_STATUSES, [
    'created', 'queued', 'due', 'processing', 'delivery_pending',
    'sent', 'partial', 'failed', 'unknown', 'canceled', 'expired', 'pending',
  ]);
  assert.deepEqual(TERMINAL_TASK_STATUSES, ['sent', 'partial', 'failed', 'canceled', 'expired']);
  assert.deepEqual(DELIVERY_TASK_STATUSES, ['sent', 'partial', 'failed', 'unknown']);

  // 转发导出必须是同一份对象，不是复制出来的新数组。
  assert.equal(TASK_STATUSES, shared.TASK_STATUSES);
  assert.equal(TERMINAL_TASK_STATUSES, shared.TERMINAL_TASK_STATUSES);
  assert.equal(DELIVERY_TASK_STATUSES, shared.DELIVERY_TASK_STATUSES);

  for (const list of [TASK_STATUSES, TERMINAL_TASK_STATUSES, DELIVERY_TASK_STATUSES]) {
    assert.equal(Object.isFrozen(list), true);
    assert.throws(() => list.push('bogus'), TypeError);
  }
});

test('unknown 属于送达结果，但不是终态', () => {
  assert.equal(DELIVERY_TASK_STATUSES.includes('unknown'), true);
  assert.equal(TERMINAL_TASK_STATUSES.includes('unknown'), false);
  assert.equal(TASK_STATUSES.includes('unknown'), true);
  // 送达结果与终态只共享已确认的三种，unknown 只能待查。
  assert.deepEqual(
    DELIVERY_TASK_STATUSES.filter((status) => status !== 'unknown' && TERMINAL_TASK_STATUSES.includes(status)),
    ['sent', 'partial', 'failed'],
  );
});

test('终态优先于已触发标志；非终态已触发一律 pending', () => {
  const NOW = 1_800_000_000_000;
  for (const status of TERMINAL_TASK_STATUSES) {
    assert.equal(
      classifyReminderRecovery({ status, dueAt: NOW - 1000, attempt: 3, firedAt: NOW - 500 }, NOW).kind,
      'terminal',
      status,
    );
  }
  // unknown 不是终态：已经触发过就停在 pending，不自动重发。
  assert.equal(
    classifyReminderRecovery({ status: 'unknown', dueAt: NOW, attempt: 1, firedAt: NOW }, NOW).kind,
    'pending',
  );
});

test('陌生状态无效，不猜成任何可重发分类', () => {
  const NOW = 1_800_000_000_000;
  for (const status of ['paused', 'SENT', '', undefined]) {
    assert.deepEqual(
      classifyReminderRecovery({ status, dueAt: NOW }, NOW),
      { kind: 'invalid', dueAt: null, lateByMs: null, reason: 'invalid-record' },
    );
  }
});

test('派发复用送达结果：unknown 落盘保留，后轮不重发', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-status-'));
  const file = path.join(dir, 'reminders.json');
  const now = 1_700_000_000_000;
  const record = {
    taskId: 'task-1',
    conversationKey: 'private:1',
    text: '喝水',
    dueAt: now - 1000,
    status: 'due',
    attempt: 0,
    firedAt: null,
    proactive: false,
  };

  try {
    assert.deepEqual(createReminderStore(file).save([record]), { ok: true });

    const deliveries = [];
    const dispatcher = createReminderDispatcher(file, {
      now: () => now,
      send: (delivery) => { deliveries.push(delivery); return 'unknown'; },
    });
    assert.deepEqual(await dispatcher.dispatchNext(), {
      ok: true,
      result: { taskId: 'task-1', status: 'unknown' },
    });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].taskId, 'task-1');

    // 快照上留下 unknown；重启后的下一轮看不到可派发候选，send 不再被调用。
    const saved = createReminderStore(file).load();
    assert.equal(saved.ok, true);
    assert.equal(saved.records[0].status, 'unknown');

    const laterDeliveries = [];
    const restarted = createReminderDispatcher(file, {
      now: () => now + 60 * 60 * 1000,
      send: (delivery) => { laterDeliveries.push(delivery); return 'sent'; },
    });
    assert.deepEqual(await restarted.dispatchNext(), { ok: true, result: null });
    assert.deepEqual(laterDeliveries, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});