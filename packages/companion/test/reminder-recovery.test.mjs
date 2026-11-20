/**
 * 提醒恢复分类 · 行为测试
 * ────────────────────────────────────────────────────────────
 * 覆盖：未来 / 7 天边界、到点与 24h 窗口、主动回访、终态与待查状态、
 * attempt / firedAt，以及畸形记录和非法时间。全部使用固定 now，保证确定性。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyReminderRecovery,
  EXPIRE_AFTER_MS,
  MAX_SCHEDULE_DELAY_MS,
} from '../src/reminder-recovery.js';

const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const INVALID_RESULT = { kind: 'invalid', dueAt: null, lateByMs: null, reason: 'invalid-record' };

test('未触发记录：未来排程、7 天边界与逾期窗口', () => {
  const rows = [
    {
      name: '未来 1ms -> queued，lateByMs 不为负',
      record: { status: 'queued', dueAt: NOW + 1 },
      expected: { kind: 'queued', dueAt: NOW + 1, lateByMs: 0, reason: null },
    },
    {
      name: '恰好 7 天仍可排程 -> queued',
      record: { status: 'created', dueAt: NOW + MAX_SCHEDULE_DELAY_MS },
      expected: { kind: 'queued', dueAt: NOW + MAX_SCHEDULE_DELAY_MS, lateByMs: 0, reason: null },
    },
    {
      name: '超过 7 天 1ms -> expired',
      record: { status: 'queued', dueAt: NOW + MAX_SCHEDULE_DELAY_MS + 1 },
      expected: {
        kind: 'expired',
        dueAt: NOW + MAX_SCHEDULE_DELAY_MS + 1,
        lateByMs: 0,
        reason: 'due-beyond-max-delay',
      },
    },
    {
      name: 'dueAt === now -> due，lateByMs 为 0',
      record: { status: 'due', dueAt: NOW },
      expected: { kind: 'due', dueAt: NOW, lateByMs: 0, reason: null },
    },
    {
      name: '普通逾期 1 小时 -> due',
      record: { status: 'due', dueAt: NOW - HOUR },
      expected: { kind: 'due', dueAt: NOW - HOUR, lateByMs: HOUR, reason: null },
    },
    {
      name: '普通逾期恰好 24h -> due（窗口含边界）',
      record: { status: 'due', dueAt: NOW - EXPIRE_AFTER_MS },
      expected: { kind: 'due', dueAt: NOW - EXPIRE_AFTER_MS, lateByMs: EXPIRE_AFTER_MS, reason: null },
    },
    {
      name: '普通逾期 24h + 1ms -> expired',
      record: { status: 'due', dueAt: NOW - EXPIRE_AFTER_MS - 1 },
      expected: {
        kind: 'expired',
        dueAt: NOW - EXPIRE_AFTER_MS - 1,
        lateByMs: EXPIRE_AFTER_MS + 1,
        reason: 'overdue-beyond-window',
      },
    },
    {
      name: '主动回访未来 -> queued',
      record: { status: 'queued', dueAt: NOW + MINUTE, input: { proactive: true } },
      expected: { kind: 'queued', dueAt: NOW + MINUTE, lateByMs: 0, reason: null },
    },
    {
      name: '主动回访 dueAt === now -> due（不算逾期）',
      record: { status: 'due', dueAt: NOW, input: { proactive: true } },
      expected: { kind: 'due', dueAt: NOW, lateByMs: 0, reason: null },
    },
    {
      name: '主动回访晚于 dueAt 1ms -> canceled',
      record: { status: 'due', dueAt: NOW - 1, input: { proactive: true } },
      expected: { kind: 'canceled', dueAt: NOW - 1, lateByMs: 1, reason: 'proactive-overdue' },
    },
    {
      name: '主动回访逾期超过 24h 仍优先 canceled',
      record: { status: 'due', dueAt: NOW - EXPIRE_AFTER_MS - 1, input: { proactive: true } },
      expected: {
        kind: 'canceled',
        dueAt: NOW - EXPIRE_AFTER_MS - 1,
        lateByMs: EXPIRE_AFTER_MS + 1,
        reason: 'proactive-overdue',
      },
    },
    {
      name: 'input.proactive 非 true 不触发主动规则',
      record: { status: 'due', dueAt: NOW - HOUR, input: { proactive: 'true' } },
      expected: { kind: 'due', dueAt: NOW - HOUR, lateByMs: HOUR, reason: null },
    },
  ];

  for (const row of rows) {
    test(row.name, () => {
      assert.deepEqual(classifyReminderRecovery(row.record, NOW), row.expected, row.name);
    });
  }
});

test('终态：全部保留为 terminal，即使记录上已有触发痕迹', () => {
  for (const status of ['sent', 'partial', 'failed', 'canceled', 'expired']) {
    test(status, () => {
      assert.deepEqual(
        classifyReminderRecovery(
          { status, dueAt: NOW - HOUR, attempt: 1, firedAt: NOW - HOUR },
          NOW,
        ),
        { kind: 'terminal', dueAt: NOW - HOUR, lateByMs: HOUR, reason: null },
        status,
      );
    });
  }
});

test('待查状态与已触发记录：一律 pending，不自动重发', () => {
  const pendingRows = [
    { name: 'processing', record: { status: 'processing', dueAt: NOW + MINUTE } },
    { name: 'delivery_pending', record: { status: 'delivery_pending', dueAt: NOW + MINUTE } },
    { name: 'unknown', record: { status: 'unknown', dueAt: NOW - MINUTE } },
    { name: 'pending', record: { status: 'pending', dueAt: NOW - MINUTE } },
    { name: 'attempt > 0', record: { status: 'queued', dueAt: NOW, attempt: 1 } },
    { name: 'firedAt 非 null', record: { status: 'due', dueAt: NOW, firedAt: NOW - 1 } },
    { name: 'firedAt === 0 也算已触发', record: { status: 'created', dueAt: NOW, firedAt: 0 } },
  ];

  for (const row of pendingRows) {
    test(row.name, () => {
      assert.deepEqual(
        classifyReminderRecovery(row.record, NOW),
        {
          kind: 'pending',
          dueAt: row.record.dueAt,
          lateByMs: Math.max(0, NOW - row.record.dueAt),
          reason: 'unconfirmed',
        },
        row.name,
      );
    });
  }

  // 省略可选字段（旧归一记录）不改变结论。
  assert.deepEqual(
    classifyReminderRecovery({ status: 'queued', dueAt: NOW + MINUTE }, NOW),
    { kind: 'queued', dueAt: NOW + MINUTE, lateByMs: 0, reason: null },
  );
  assert.deepEqual(
    classifyReminderRecovery({ status: 'queued', dueAt: NOW, attempt: 0, firedAt: null }, NOW),
    { kind: 'due', dueAt: NOW, lateByMs: 0, reason: null },
  );
});

test('畸形记录、未知状态、非法时间与非法可选字段 -> invalid', () => {
  const validRecord = { status: 'queued', dueAt: NOW };
  const invalidRecords = [
    ['null', null],
    ['undefined', undefined],
    ['数组', []],
    ['字符串', 'queued'],
    ['缺少 status', { dueAt: NOW }],
    ['未知 status', { status: 'paused', dueAt: NOW }],
    ['缺少 dueAt', { status: 'queued' }],
    ['dueAt 为负', { status: 'queued', dueAt: -1 }],
    ['dueAt 为小数', { status: 'queued', dueAt: 1.5 }],
    ['dueAt 为数字字符串', { status: 'queued', dueAt: String(NOW) }],
    ['dueAt 超出安全整数', { status: 'queued', dueAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['dueAt 为 NaN', { status: 'queued', dueAt: Number.NaN }],
    ['attempt 为负', { status: 'queued', dueAt: NOW, attempt: -1 }],
    ['attempt 为小数', { status: 'queued', dueAt: NOW, attempt: 1.5 }],
    ['attempt 为 null', { status: 'queued', dueAt: NOW, attempt: null }],
    ['attempt 为字符串', { status: 'queued', dueAt: NOW, attempt: '1' }],
    ['firedAt 为负', { status: 'queued', dueAt: NOW, firedAt: -1 }],
    ['firedAt 为小数', { status: 'queued', dueAt: NOW, firedAt: 1.5 }],
    ['firedAt 为字符串', { status: 'queued', dueAt: NOW, firedAt: String(NOW) }],
    ['firedAt 为 NaN', { status: 'queued', dueAt: NOW, firedAt: Number.NaN }],
  ];

  for (const [name, record] of invalidRecords) {
    test(`记录：${name}`, () => {
      assert.deepEqual(classifyReminderRecovery(record, NOW), INVALID_RESULT, name);
    });
  }

  const invalidNows = [
    ['now 省略', undefined],
    ['now 为负', -1],
    ['now 为小数', 1.5],
    ['now 为 NaN', Number.NaN],
    ['now 为字符串', String(NOW)],
    ['now 为 Infinity', Number.POSITIVE_INFINITY],
  ];

  for (const [name, now] of invalidNows) {
    test(`时间：${name}`, () => {
      assert.deepEqual(classifyReminderRecovery(validRecord, now), INVALID_RESULT, name);
    });
  }
});