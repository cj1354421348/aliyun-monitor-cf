/**
 * 调度分发测试。
 *
 * planFor 是纯函数，但它决定「这一分钟跑不跑止损/开机/日报」——
 * 算错就是漏止损或漏日报，而且是静默的，所以每一档都要钉住。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SCHEDULE, planFor, resolveSchedule, validateSchedule } from '../src/scheduler.ts';

/** 北京时间 → UTC 毫秒时间戳（北京 = UTC+8） */
function beijing(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h - 8, mi, 0);
}

test('默认计划：每 5 分钟止损，:00/:30 开机，09:00 日报', () => {
  assert.deepEqual(DEFAULT_SCHEDULE.start_at_minutes, [0, 30]);
  assert.equal(DEFAULT_SCHEDULE.report_at, '09:00');
  assert.equal(DEFAULT_SCHEDULE.auto_start, true);
});

test('普通 5 分钟点：只跑 monitor', () => {
  const plan = planFor(beijing(2026, 10, 25, 12, 35));
  assert.equal(plan.monitor, true);
  assert.equal(plan.start, false);
  assert.equal(plan.report, false);
  assert.match(plan.reason, /12:35/);
});

test(':00 与 :30 追加 start', () => {
  for (const minute of [0, 30]) {
    const plan = planFor(beijing(2026, 10, 25, 12, minute));
    assert.equal(plan.start, true, `${minute} 分应跑 start`);
    assert.equal(plan.report, false);
  }
});

test('09:00 追加 report', () => {
  const plan = planFor(beijing(2026, 10, 25, 9, 0));
  assert.equal(plan.report, true);
  assert.equal(plan.start, true, '09:00 同时也是 :00，两个都要跑');
  assert.equal(plan.monitor, true);
});

test('auto_start=false 时永不跑 start', () => {
  const plan = planFor(beijing(2026, 10, 25, 12, 30), { auto_start: false });
  assert.equal(plan.start, false);
});

test('report_weekdays 生效：周一只发周一的日报', () => {
  // 2026-10-25 是周日(0)，10-26 是周一(1)
  const sunday = planFor(beijing(2026, 10, 25, 9, 0), { report_weekdays: [1] });
  assert.equal(sunday.report, false);
  const monday = planFor(beijing(2026, 10, 26, 9, 0), { report_weekdays: [1] });
  assert.equal(monday.report, true);
});

test('自定义 report_at 与 start_at_minutes', () => {
  const schedule = { report_at: '21:15', start_at_minutes: [15, 45] };
  assert.equal(planFor(beijing(2026, 10, 25, 21, 15), schedule).report, true);
  assert.equal(planFor(beijing(2026, 10, 25, 21, 15), schedule).start, true);
  assert.equal(planFor(beijing(2026, 10, 25, 21, 45), schedule).start, true);
  assert.equal(planFor(beijing(2026, 10, 25, 21, 30), schedule).start, false);
});

test('resolveSchedule 过滤非法值并回落默认', () => {
  const resolved = resolveSchedule({
    start_at_minutes: [0, 60, -1, 30.5, 30],
    report_weekdays: [9, 1],
    report_at: '9:00', // 少一位，不合法
    monitor_every_minutes: 0,
  });
  assert.deepEqual(resolved.start_at_minutes, [0, 30]);
  assert.deepEqual(resolved.report_weekdays, [1]);
  assert.equal(resolved.report_at, '09:00');
  assert.equal(resolved.monitor_every_minutes, 5);
});

test('validateSchedule 抓出永远触发不到的时间点', () => {
  const issues = validateSchedule({ start_at_minutes: [0, 7], report_at: '09:03' }, '*/5 * * * *');
  assert.ok(issues.some((line) => line.includes('7')), issues.join('\n'));
  assert.ok(issues.some((line) => line.includes('09:03')), issues.join('\n'));
});

test('validateSchedule 对自洽配置零告警', () => {
  assert.deepEqual(validateSchedule({}, '*/5 * * * *'), []);
});

test('validateSchedule 抓出 cron 太慢', () => {
  const issues = validateSchedule({ monitor_every_minutes: 5 }, '*/15 * * * *');
  assert.ok(issues.some((line) => line.includes('止损会不及时')), issues.join('\n'));
});

test('validateSchedule 对无法解析的分钟字段给提示', () => {
  const issues = validateSchedule({}, '0 * * * *');
  assert.ok(issues.some((line) => line.includes('无法解析')), issues.join('\n'));
});
