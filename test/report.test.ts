/**
 * 日报评估与格式测试。
 *
 * `evaluate` 决定日报里那句「评估: ✅ 正常 / ⚠️ 流量接近上限 /
 * ❌ 流量已超标」—— 它是你扫日报时唯一会看的一行，优先级搞反
 * （比如扣费预警盖住流量超标）就会误导判断。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluate } from '../src/report.ts';
import type { UserConfig } from '../src/config.ts';

const USER: UserConfig = {
  name: 'web_01',
  instance_id: 'i-abc',
  region: 'cn-hangzhou',
  traffic_limit: 180,
  bill_threshold: 1.0,
};

const RATE = 7.0;

test('流量超标优先级最高，压过扣费预警', () => {
  assert.equal(
    evaluate(200, 180, 999, 'USD', USER, RATE),
    '评估: ❌ 流量已超标，保持关机',
  );
});

test('流量到 90% 提醒接近上限', () => {
  assert.equal(evaluate(162, 180, null, '', USER, RATE), '评估: ⚠️ 流量接近上限');
  assert.equal(evaluate(161.9, 180, null, '', USER, RATE), '评估: ✅ 正常', '89.9% 还算正常');
});

test('流量接近上限压过扣费预警', () => {
  assert.equal(evaluate(170, 180, 999, 'USD', USER, RATE), '评估: ⚠️ 流量接近上限');
});

test('扣费超过阈值（USD）', () => {
  assert.equal(
    evaluate(10, 180, 2.5, 'USD', USER, RATE),
    '评估: ⚠️ 扣费超过 1.00 USD',
  );
});

test('扣费在阈值内是正常', () => {
  assert.equal(evaluate(10, 180, 0.5, 'USD', USER, RATE), '评估: ✅ 正常');
  assert.equal(evaluate(10, 180, 1.0, 'USD', USER, RATE), '评估: ✅ 正常', '等于阈值不算超');
});

test('CNY 账单会按汇率换算阈值', () => {
  // 阈值 1.0 USD × 7.0 = 7.0 CNY
  assert.equal(evaluate(10, 180, 8, 'CNY', USER, RATE), '评估: ⚠️ 扣费超过 7.00 CNY');
  assert.equal(evaluate(10, 180, 6.9, 'CNY', USER, RATE), '评估: ✅ 正常');
});

test('流量查询失败（null）时仍然能评估扣费', () => {
  assert.equal(evaluate(null, 180, 5, 'USD', USER, RATE), '评估: ⚠️ 扣费超过 1.00 USD');
  assert.equal(evaluate(null, 180, null, '', USER, RATE), '评估: ✅ 正常');
});

test('自定义 bill_threshold 生效', () => {
  const user: UserConfig = { ...USER, bill_threshold: 50 };
  assert.equal(evaluate(10, 180, 40, 'USD', user, RATE), '评估: ✅ 正常');
  assert.equal(evaluate(10, 180, 60, 'USD', user, RATE), '评估: ⚠️ 扣费超过 50.00 USD');
});

test('bill_threshold 缺失时回落 1.0', () => {
  const user: UserConfig = { name: 'x', instance_id: 'i-x', region: 'cn-hangzhou' };
  assert.equal(evaluate(10, 180, 1.5, 'USD', user, RATE), '评估: ⚠️ 扣费超过 1.00 USD');
});

test('limit 为 0 时不除零、不产出 NaN', () => {
  // 实际运行中 trafficLimit() 会把非正数回落到 180，这里只是保证
  // 万一有 0 传进来，也不会算出 NaN 这种没法读的东西。
  const text = evaluate(10, 0, null, '', USER, RATE);
  assert.ok(!text.includes('NaN'), text);
  assert.equal(text, '评估: ❌ 流量已超标，保持关机', '0 上限下任何流量都算超标');
});
