/**
 * 纯函数测试：时区、数值、脱敏、分段、签名编码。
 *
 * 这些是「错了会静默出错」的部分 —— 比如 percentEncode 少了 * 的转义，
 * 签名只在特定参数值上才会失败，线上表现为偶发 400，极难查。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  base64FromString,
  beijingDate,
  beijingHhMm,
  beijingMonth,
  beijingWeekday,
  num,
  percentEncode,
  redact,
  sanitizeMd,
  splitMessage,
} from '../src/util.ts';

// 2026-10-25T04:39:17Z === 北京时间 2026-10-25 12:39:17（周日）
const SAMPLE = Date.UTC(2026, 9, 25, 4, 39, 17);

test('北京时间换算：UTC+8', () => {
  assert.equal(beijingDate(SAMPLE), '2026-10-25');
  assert.equal(beijingMonth(SAMPLE), '2026-10');
  assert.equal(beijingHhMm(SAMPLE), '12:39');
  assert.equal(beijingWeekday(SAMPLE), 0); // 周日
});

test('北京时间跨日：UTC 20:00 已经是北京次日 04:00', () => {
  const utc2000 = Date.UTC(2026, 9, 25, 20, 0, 0);
  assert.equal(beijingDate(utc2000), '2026-10-26');
  assert.equal(beijingHhMm(utc2000), '04:00');
});

test('num 兼容千分位与空值', () => {
  assert.equal(num('1,234.56'), 1234.56);
  assert.equal(num(' 12.5 '), 12.5);
  assert.equal(num(7), 7);
  assert.equal(num(null), 0);
  assert.equal(num(undefined), 0);
  assert.equal(num(''), 0);
  assert.equal(num('abc', 1.5), 1.5);
  assert.equal(num(Number.NaN, 2), 2);
});

test('redact 抹掉签名类参数值，保留主机名', () => {
  const raw =
    'POST https://ecs.aliyuncs.com/?Action=DescribeInstances' +
    '&AccessKeyId=LTAI5tEXAMPLEKEY&Signature=abc%2Bdef%3D&SignatureNonce=xyz';
  const cleaned = redact(raw);
  assert.ok(!cleaned.includes('LTAI5tEXAMPLEKEY'), cleaned);
  assert.ok(!cleaned.includes('abc%2Bdef%3D'), cleaned);
  assert.ok(cleaned.includes('ecs.aliyuncs.com'), cleaned);
  assert.ok(cleaned.includes('DescribeInstances'), cleaned);
});

test('sanitizeMd 抹掉 Telegram Markdown 的四个危险字符', () => {
  // 与 src/fc/index.py 的 sanitize_md 逐字对齐：只处理 _ * ` [ 四个字符，
  // 每个替换成一个空格（不合并连续空格），结尾 ] 保留 —— legacy Markdown
  // 里单独一个 ] 不构成链接，无害。
  assert.equal(sanitizeMd('web_01'), 'web 01');
  assert.equal(sanitizeMd('*bold*'), 'bold');
  assert.equal(sanitizeMd('  plain  '), 'plain');
  assert.equal(sanitizeMd('[x]'), 'x]');
});

test('percentEncode 按阿里云规则转义', () => {
  assert.equal(percentEncode('a b'), 'a%20b');
  assert.equal(percentEncode('a*b'), 'a%2Ab');
  assert.equal(percentEncode("a'b"), 'a%27b');
  assert.equal(percentEncode('a(b)'), 'a%28b%29');
  assert.equal(percentEncode('a-b_c.d~e'), 'a-b_c.d~e');
  assert.equal(percentEncode('100%'), '100%25');
});

test('base64FromString 与 RFC 4648 一致', () => {
  assert.equal(base64FromString(''), '');
  assert.equal(base64FromString('f'), 'Zg==');
  assert.equal(base64FromString('foobar'), 'Zm9vYmFy');
});

test('splitMessage 不丢行、不超长', () => {
  const message = Array.from({ length: 500 }, (_, i) => `第 ${i} 行内容`).join('\n');
  const chunks = splitMessage(message, 400);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 400, `超长: ${chunk.length}`);
  assert.equal(chunks.join('\n'), message);
});

test('splitMessage 处理超长单行', () => {
  const chunks = splitMessage('x'.repeat(1000), 400);
  assert.ok(chunks.every((chunk) => chunk.length <= 400));
  assert.equal(chunks.join('').length, 1000);
});

test('splitMessage 空输入返回一个空段，不会返回空数组', () => {
  assert.deepEqual(splitMessage(''), ['']);
});
