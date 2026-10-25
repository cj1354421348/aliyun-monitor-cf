/**
 * 网页看板的纯逻辑测试。
 *
 * 只测不碰网络、不碰 KV 的部分：会话签名、Cookie 解析、cron 时刻推算、
 * KV 摘要拼装。这些错了要么是安全问题（会话伪造得过），要么是显示错乱
 * （"下次日报"永远显示同一个时刻），都是静默的，所以每个都要钉住。
 *
 * collectStatus 依赖阿里云 API，不在单测范围 —— 那是 mode=selftest 的活。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SESSION_COOKIE,
  alignUpToStep,
  buildSummary,
  clearCookie,
  cronStep,
  nextRuns,
  readCookie,
  sessionCookie,
  signSession,
  timingSafeEqual,
  verifySession,
} from '../src/dashboard.ts';
import type { AppConfig } from '../src/config.ts';

/** 北京时间 → UTC 毫秒时间戳（北京 = UTC+8） */
function beijing(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h - 8, mi, 0);
}

const PASS = 'test-pass-0123456789';

test('timingSafeEqual：相同为真，长度不同或内容不同为假', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'ab'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

test('会话签名可验证，篡改任意一位都不行', async () => {
  const now = beijing(2026, 10, 25, 12, 0);
  const expires = now + 60_000;
  const value = await signSession(PASS, expires);
  assert.equal(await verifySession(PASS, value, now), true);

  // 改签名
  const dot = value.indexOf('.');
  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const flipped = signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');
  assert.equal(await verifySession(PASS, `${payload}.${flipped}`, now), false);

  // 改过期时间（签名对不上）
  assert.equal(await verifySession(PASS, `${expires + 1}.${signature}`, now), false);

  // 换密码（签名密钥变了）
  assert.equal(await verifySession('another-pass', value, now), false);
});

test('会话过期后失效', async () => {
  const now = beijing(2026, 10, 25, 12, 0);
  const value = await signSession(PASS, now - 1);
  assert.equal(await verifySession(PASS, value, now), false);
});

test('畸形会话值一律拒绝，不抛异常', async () => {
  const now = Date.now();
  for (const bad of ['', 'no-dot', '.onlysig', 'abc.def', '123.', '.', '1.2.3']) {
    assert.equal(await verifySession(PASS, bad, now), false, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('密码为空时：签发直接抛错，验证一律为假', async () => {
  const now = Date.now();
  await assert.rejects(() => signSession('', now + 60_000), /DASHBOARD_PASS 为空/);
  assert.equal(await verifySession('', '1.2', now), false);
});

test('Cookie 解析：取指定名字，忽略同名前缀', () => {
  assert.equal(readCookie('a=1; dash=xyz; b=2', SESSION_COOKIE), 'xyz');
  assert.equal(readCookie('dash2=nope; dash=yes', SESSION_COOKIE), 'yes');
  assert.equal(readCookie('dash=has=equals', SESSION_COOKIE), 'has=equals');
  assert.equal(readCookie('other=1', SESSION_COOKIE), '');
  assert.equal(readCookie(null, SESSION_COOKIE), '');
});

test('Cookie 属性：HttpOnly / Secure / SameSite=Strict', () => {
  const set = sessionCookie('abc.def', 3600);
  assert.match(set, /^dash=abc\.def;/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /Path=\//);
  assert.match(set, /Max-Age=3600/);
  assert.match(clearCookie(), /Max-Age=0/);
});

test('cronStep：解析 */N，异常输入回落 5', () => {
  assert.equal(cronStep('*/5 * * * *'), 5);
  assert.equal(cronStep('*/10 * * * *'), 10);
  assert.equal(cronStep('0 * * * *'), 5);
  assert.equal(cronStep('*/0 * * * *'), 5);
  assert.equal(cronStep('*/90 * * * *'), 5);
  assert.equal(cronStep(''), 5);
});

test('alignUpToStep：向上取整到 step 的整数倍', () => {
  const t = beijing(2026, 10, 25, 12, 3);
  assert.equal(alignUpToStep(t, 5) % (5 * 60_000), 0);
  assert.ok(alignUpToStep(t, 5) > t);
  // 已经在整点上就原样返回
  const aligned = alignUpToStep(t, 5);
  assert.equal(alignUpToStep(aligned, 5), aligned);
});

test('nextRuns：默认配置下巡检 5 分钟内、开机与日报都能算出来', () => {
  const now = beijing(2026, 10, 25, 12, 3);
  const next = nextRuns(now);
  assert.ok(next.monitor !== null && next.monitor > now);
  assert.ok(next.monitor - now <= 5 * 60_000);
  // 12:03 → 下次 :30 开机
  assert.equal(next.start, beijing(2026, 10, 25, 12, 30));
  // 次日 09:00 日报
  assert.equal(next.report, beijing(2026, 10, 26, 9, 0));
});

test('nextRuns：auto_start=false 时没有开机时刻', () => {
  const now = beijing(2026, 10, 25, 12, 3);
  const next = nextRuns(now, { auto_start: false });
  assert.equal(next.start, null);
  assert.ok(next.report !== null);
});

test('nextRuns：report_weekdays 限定后日报只在指定星期', () => {
  // 2026-10-25 是周日；只允许周一（1）→ 下次日报是 10-26 09:00
  const now = beijing(2026, 10, 25, 12, 3);
  const next = nextRuns(now, { report_weekdays: [1] });
  assert.equal(next.report, beijing(2026, 10, 26, 9, 0));
});

test('nextRuns：cron 步长 10 分钟时巡检落在 10 的倍数上', () => {
  const now = beijing(2026, 10, 25, 12, 3);
  const next = nextRuns(now, {}, '*/10 * * * *');
  assert.equal(next.monitor, beijing(2026, 10, 25, 12, 10));
});

const CONFIG: AppConfig = {
  usd_cny_rate: 7.2,
  schedule: { auto_start: true, start_at_minutes: [0, 30], report_at: '09:00' },
  users: [
    { name: 'JP-Server', instance_id: 'i-aaa', region: 'ap-northeast-1', traffic_limit: 180 },
    { instance_id: 'i-bbb', region: 'cn-hongkong', paused: true },
  ],
};

test('buildSummary：实例顺序、名称回落、暂停标记都对', () => {
  const now = beijing(2026, 10, 25, 12, 3);
  const summary = buildSummary(CONFIG, {}, now);
  assert.equal(summary.instances.length, 2);
  assert.equal(summary.instances[0]!.name, 'JP-Server');
  assert.equal(summary.instances[0]!.paused, false);
  // 没给 name 就用 instance_id
  assert.equal(summary.instances[1]!.name, 'i-bbb');
  assert.equal(summary.instances[1]!.paused, true);
  assert.equal(summary.now_text, '2026-10-25 12:03');
});

test('buildSummary：只把事件时间戳列进 last_notified，内部字段不混进来', () => {
  const now = beijing(2026, 10, 25, 12, 3);
  const summary = buildSummary(
    CONFIG,
    {
      'i-aaa': {
        overlimit: beijing(2026, 10, 25, 6, 0),
        check_failures: 2,
        start_failures: 1,
        pending_start_ts: beijing(2026, 10, 25, 12, 30),
        last_retry_ts: beijing(2026, 10, 25, 11, 0),
      },
    },
    now,
  );
  const first = summary.instances[0]!;
  assert.deepEqual(
    first.last_notified.map((item) => item.event),
    ['流量超标'],
  );
  assert.equal(first.check_failures, 2);
  assert.equal(first.start_failures, 1);
  assert.equal(first.pending_start, '2026-10-25 12:30');
});

test('buildSummary：配置里没有实例时不炸', () => {
  const summary = buildSummary({}, {}, Date.now());
  assert.deepEqual(summary.instances, []);
  assert.ok(summary.next.monitor);
});
