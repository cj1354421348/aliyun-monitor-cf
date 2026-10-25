/**
 * 通知通道测试。
 *
 * 这里守的是「告警不许无声消失」这条底线。历史上踩过的两个坑：
 *
 *   1. 把 HTTP 4xx 当成功 —— Telegram 返回 400 也不抛异常，如果不看
 *      状态码就当发出去了，于是告警静默丢失，你只会觉得「最近怎么
 *      没消息」，而实际上是没发出去。
 *   2. 只试一次 Markdown —— 实例名带下划线或者正文里有不成对的
 *      `*`，Telegram 会 400，整条告警丢掉。所以必须退回纯文本重发。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  OVERLIMIT_COOLDOWN,
  NOTIFY_COOLDOWN,
  sendBark,
  sendTelegram,
  sendTelegramChunks,
  telegramDiagnose,
  TG_LIMIT,
} from '../src/notify.ts';
import { splitMessage } from '../src/util.ts';

const TG = { bot_token: '123:TESTTOKEN', chat_id: '999' };
const silent = { info() {}, warn() {}, error() {}, debug() {} };

interface Call {
  url: string;
  method: string;
  body: string;
  parseMode: string | null;
}

let calls: Call[];
/** 按顺序返回的响应；用完后重复最后一个 */
let responses: Array<{ status: number; body: string }>;

function install(responses_: Array<{ status: number; body: string }>): void {
  responses = responses_;
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = String(init?.body ?? '');
    calls.push({
      url,
      method: String(init?.method ?? 'GET'),
      body,
      parseMode: new URLSearchParams(body).get('parse_mode'),
    });
    const index = Math.min(calls.length - 1, responses.length - 1);
    const picked = responses[index]!;
    return new Response(picked.body, { status: picked.status });
  }) as typeof fetch;
}

const OK = { status: 200, body: '{"ok":true}' };

beforeEach(() => install([OK]));
afterEach(() => {
  calls = [];
  responses = [];
});

test('冷却常量：通用 1 小时，超标 24 小时', () => {
  assert.equal(NOTIFY_COOLDOWN, 3_600_000);
  assert.equal(OVERLIMIT_COOLDOWN, 86_400_000);
  assert.equal(TG_LIMIT, 4000);
});

test('正常发送：先 Markdown，成功后不再重试', async () => {
  install([OK]);
  const result = await sendTelegram(TG, '流量预警', '机器: web_01', { log: silent });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.parseMode, 'Markdown');
  assert.match(calls[0]!.url, /api\.telegram\.org\/bot123:TESTTOKEN\/sendMessage$/);
});

test('Markdown 被拒：自动退回纯文本重发', async () => {
  install([
    { status: 400, body: '{"error_code":400,"description":"can\'t parse entities"}' },
    OK,
  ]);
  const result = await sendTelegram(TG, '', '机器: web_01', { log: silent });

  assert.equal(result.ok, true, '第二条纯文本应成功');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.parseMode, 'Markdown');
  assert.equal(calls[1]!.parseMode, null, '重试必须去掉 parse_mode');
});

test('两次都被拒：返回失败，绝不谎报成功', async () => {
  install([{ status: 400, body: '{"error_code":400,"description":"bad request"}' }]);
  const result = await sendTelegram(TG, 't', 'm', { log: silent });

  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /400/);
  assert.equal(calls.length, 2, '两种模式都试过');
});

test('401 也算失败（token 错不该被当成发成功）', async () => {
  install([{ status: 401, body: '{"error_code":401,"description":"Unauthorized"}' }]);
  const result = await sendTelegram(TG, '', 'm', { log: silent });
  assert.equal(result.ok, false);
});

test('网络异常：返回失败原因，不抛出去', async () => {
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;

  const result = await sendTelegram(TG, '', 'm', { log: silent });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /网络不通/);
});

test('未配置 token/chat_id：直接跳过，不发请求', async () => {
  const result = await sendTelegram(undefined, 't', 'm', { log: silent });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test('markdown:false 时只发一次纯文本', async () => {
  install([OK]);
  await sendTelegram(TG, '', 'm', { markdown: false, log: silent });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.parseMode, null);
});

test('标题会被拼成 Markdown 粗体并清洗下划线', async () => {
  install([OK]);
  await sendTelegram(TG, '流量_预警', 'body', { log: silent });
  const text = new URLSearchParams(calls[0]!.body).get('text') ?? '';
  assert.ok(text.startsWith('*流量 预警*'), text);
});

test('正文里的签名参数会被 redact 掉', async () => {
  install([OK]);
  await sendTelegram(TG, '', 'https://ecs.aliyuncs.com/?Signature=abc123&Action=X', { log: silent });
  const text = new URLSearchParams(calls[0]!.body).get('text') ?? '';
  assert.ok(!text.includes('abc123'), text);
  assert.match(text, /REDACTED/);
});

test('长日报按 4000 字切段发送，一段都没丢', async () => {
  install([OK]);
  const message = Array.from({ length: 300 }, (_, i) => `第 ${i} 行：这是一条很长的日报内容，用来把消息撑爆`).join('\n');
  const ok = await sendTelegramChunks(TG, message, silent);

  assert.equal(ok, true);
  assert.ok(calls.length > 1, '应切成多段');
  const rebuilt = calls
    .map((call) => new URLSearchParams(call.body).get('text') ?? '')
    .join('\n');
  // 每段都被 redact/sanitize 处理过，但行数必须一致
  assert.equal(rebuilt.split('\n').filter((line) => line.startsWith('第 ')).length, 300);
});

test('Bark 未配置：返回 false 且不发请求', async () => {
  const ok = await sendBark(undefined, 'hi', silent);
  assert.equal(ok, false);
  assert.equal(calls.length, 0);
});

test('Bark 会把正文 URL 编码进路径', async () => {
  install([{ status: 200, body: '{"code":200}' }]);
  const ok = await sendBark({ bark_url: 'https://bark.example.com/KEY/' }, '流量 超标', silent);

  assert.equal(ok, true);
  assert.equal(calls[0]!.method, 'GET');
  assert.ok(calls[0]!.url.startsWith('https://bark.example.com/KEY/'), calls[0]!.url);
  assert.ok(calls[0]!.url.includes('%E6%B5%81%E9%87%8F'), '中文应被编码');
  assert.ok(!calls[0]!.url.includes('//KEY//'), '末尾斜杠不该重复');
});

test('Bark 非 200 返回 false', async () => {
  install([{ status: 500, body: 'oops' }]);
  assert.equal(await sendBark({ bark_url: 'https://bark.example.com/KEY' }, 'x', silent), false);
});

test('diagnose：getMe 通但发送失败 → 提示 chat_id 问题', async () => {
  install([
    { status: 200, body: '{"ok":true,"result":{"username":"my_bot"}}' },
    { status: 400, body: '{"error_code":400,"description":"chat not found"}' },
    { status: 400, body: '{"error_code":400,"description":"chat not found"}' },
  ]);
  const result = await telegramDiagnose(TG, silent);

  assert.equal(result.sent, false);
  assert.equal(result.bot, 'my_bot');
  assert.match(result.reason ?? '', /chat_id/);
});

test('diagnose：token 无效时明确指出', async () => {
  install([{ status: 401, body: '{"error_code":401,"description":"Unauthorized"}' }]);
  const result = await telegramDiagnose(TG, silent);
  assert.equal(result.sent, false);
  assert.match(result.reason ?? '', /bot_token 无效/);
});

test('diagnose：连不上 api.telegram.org', async () => {
  globalThis.fetch = (async () => {
    throw new Error('ENOTFOUND');
  }) as typeof fetch;

  const result = await telegramDiagnose(TG, silent);
  assert.match(result.reason ?? '', /连不上 api\.telegram\.org/);
});

test('diagnose：一切正常返回 bot 名', async () => {
  install([
    { status: 200, body: '{"ok":true,"result":{"username":"my_bot"}}' },
    OK,
  ]);
  const result = await telegramDiagnose(TG, silent);
  assert.equal(result.sent, true);
  assert.equal(result.bot, 'my_bot');
});

test('splitMessage 与 TG_LIMIT 配合：每段都不超限', () => {
  const message = 'x'.repeat(TG_LIMIT * 2 + 7);
  for (const chunk of splitMessage(message, TG_LIMIT)) {
    assert.ok(chunk.length <= TG_LIMIT, `段长 ${chunk.length}`);
  }
});
