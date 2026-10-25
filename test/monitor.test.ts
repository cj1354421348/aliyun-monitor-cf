/**
 * 巡检决策测试 —— 用假的 fetch 跑完整链路。
 *
 * 这里不打桩内部函数，而是把 globalThis.fetch 换掉：aliyunCall 和
 * sendTelegram 都走 fetch，所以这一层拦截之后，从「查流量 → 判阈值 →
 * 下发 ECS 命令 → 发告警 → 写状态」整条路都是真代码在跑。
 *
 * 为什么值得这么测：止损逻辑写错的代价是「该关机时没关」或「不该关机
 * 时关了」，两者都不会报错，只会在账单上体现。这几个用例把
 * 流量超标/Running、流量超标/Stopped、流量安全/Stopped、冷却期、
 * 预算耗尽五种情形钉死。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { Budget, handleTrafficOverlimit, handleTrafficSafe, inspect, runMonitor, runStart, type TickContext } from '../src/monitor.ts';
import { MemoryBackend, State } from '../src/state.ts';
import type { AppConfig, UserConfig } from '../src/config.ts';
import { createLogger } from '../src/util.ts';

const CONFIG: AppConfig = {
  ak: 'LTAI5tTESTACCESSKEYID',
  sk: 'TESTSECRETKEY0123456789abcdef',
  telegram: { bot_token: '123:TESTTOKEN', chat_id: '999' },
  users: [
    {
      name: 'web_01',
      instance_id: 'i-abc123',
      region: 'cn-hangzhou',
      traffic_limit: 180,
    },
  ],
};

interface FakeWorld {
  trafficGb: number;
  status: string;
  /** 记录下发的 ECS 动作 */
  ecsCalls: string[];
  /** 记录发出的 Telegram 文本 */
  messages: string[];
  /** 让某次调用失败，用来测失败计数 */
  failTraffic?: boolean;
}

let world: FakeWorld;

function gbToBytes(gb: number): number {
  return Math.round(gb * 1024 ** 3);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 从 form body 里取 Action */
function actionOf(init: RequestInit | undefined): string {
  const body = typeof init?.body === 'string' ? init.body : '';
  const match = /(?:^|&)Action=([^&]*)/.exec(body);
  return match ? decodeURIComponent(match[1]!) : '';
}

beforeEach(() => {
  world = { trafficGb: 10, status: 'Running', ecsCalls: [], messages: [] };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

    if (url.includes('api.telegram.org')) {
      // 请求体是 application/x-www-form-urlencoded，解回明文再断言
      const raw = String(init?.body ?? '');
      world.messages.push(new URLSearchParams(raw).get('text') ?? raw);
      return jsonResponse({ ok: true, result: {} });
    }

    const action = actionOf(init);
    if (action === 'ListCdtInternetTraffic') {
      if (world.failTraffic) return jsonResponse({ Code: 'InternalError', Message: 'boom' }, 500);
      return jsonResponse({
        TrafficDetails: [{ Traffic: gbToBytes(world.trafficGb) }],
      });
    }
    if (action === 'DescribeInstances') {
      return jsonResponse({
        Instances: {
          Instance: [
            {
              Status: world.status,
              InstanceType: 'ecs.t6-c1m1.large',
              Cpu: 2,
              Memory: 2048,
              PublicIpAddress: { IpAddress: ['1.2.3.4'] },
            },
          ],
        },
      });
    }
    if (action === 'StartInstance' || action === 'StopInstance') {
      world.ecsCalls.push(action);
      return jsonResponse({ RequestId: 'req-1' });
    }
    if (action === 'QueryAccountBalance') {
      return jsonResponse({ Success: true, Data: { AvailableAmount: '12.34', Currency: 'CNY' } });
    }
    return jsonResponse({ Code: 'UnexpectedAction', Message: action }, 400);
  }) as typeof fetch;
});

afterEach(() => {
  // 不还原也没关系（每个用例都会重装），但保持干净
  world = { trafficGb: 0, status: '', ecsCalls: [], messages: [] };
});

async function makeContext(options: { budgetLimit?: number; now?: number } = {}): Promise<{
  ctx: TickContext;
  state: State;
  backend: MemoryBackend;
}> {
  const backend = new MemoryBackend();
  const state = new State(backend, 'state/test.json', createLogger('test'));
  await state.load();
  const now = options.now ?? Date.UTC(2026, 9, 25, 4, 39, 17);
  const ctx: TickContext = {
    config: CONFIG,
    state: state.data,
    log: createLogger('test'),
    budget: new Budget(options.budgetLimit ?? 40),
    now: () => now,
  };
  return { ctx, state, backend };
}

function user(): UserConfig {
  return CONFIG.users![0]!;
}

test('流量超标 + Running：下发 StopInstance 并发预警', async () => {
  world.trafficGb = 200;
  world.status = 'Running';
  const { ctx } = await makeContext();

  const outcome = await runMonitor(ctx);

  assert.equal(outcome.stopped, 1);
  assert.deepEqual(world.ecsCalls, ['StopInstance']);
  assert.equal(world.messages.length, 1);
  assert.match(world.messages[0]!, /流量预警/);
  assert.ok(ctx.state['i-abc123']?.overlimit, '应记录 overlimit 冷却时间戳');
});

test('流量超标 + Stopped：不重复下发关机，只提醒', async () => {
  world.trafficGb = 200;
  world.status = 'Stopped';
  const { ctx } = await makeContext();

  const outcome = await runMonitor(ctx);

  assert.equal(outcome.stopped, 0);
  assert.deepEqual(world.ecsCalls, []);
  assert.equal(world.messages.length, 1);
  assert.match(world.messages[0]!, /已保持关机/);
});

test('流量超标通知有 24 小时冷却', async () => {
  world.trafficGb = 200;
  world.status = 'Running';
  const now = Date.UTC(2026, 9, 25, 4, 39, 17);
  const { ctx, state, backend } = await makeContext({ now });

  await runMonitor(ctx);
  await state.save();
  const firstCount = world.messages.length;

  // 一小时后重跑：仍在冷却期内，不该再发
  const later: TickContext = { ...ctx, now: () => now + 3600_000 };
  await runMonitor(later);

  assert.equal(world.messages.length, firstCount, '冷却期内不应重复推送');
  assert.ok(backend.writes >= 1, '状态应至少写过一次');
});

test('流量安全 + Stopped：下发 StartInstance 并记 pending_start_ts', async () => {
  world.trafficGb = 10;
  world.status = 'Stopped';
  const { ctx } = await makeContext();

  const outcome = await runStart(ctx);

  assert.equal(outcome.started, 1);
  assert.deepEqual(world.ecsCalls, ['StartInstance']);
  assert.ok(ctx.state['i-abc123']?.pending_start_ts, '应记下等待验证的启动时间');
});

test('流量安全 + Running：什么都不做', async () => {
  world.trafficGb = 10;
  world.status = 'Running';
  const { ctx } = await makeContext();

  const outcome = await runStart(ctx);

  assert.equal(outcome.started, 0);
  assert.deepEqual(world.ecsCalls, []);
  assert.equal(world.messages.length, 0);
});

test('start 阶段遇到超标：只记日志，不开机', async () => {
  world.trafficGb = 200;
  world.status = 'Stopped';
  const { ctx } = await makeContext();

  const outcome = await runStart(ctx);

  assert.equal(outcome.started, 0);
  assert.deepEqual(world.ecsCalls, []);
});

test('启动命令没生效：下次检查累加 start_failures', async () => {
  world.trafficGb = 10;
  world.status = 'Stopped';
  const { ctx } = await makeContext();

  await runStart(ctx);
  assert.equal(ctx.state['i-abc123']?.start_failures ?? 0, 0);

  // 下一轮它还是 Stopped → 上一轮的命令没生效
  const second: TickContext = { ...ctx, now: () => ctx.now() + 1800_000 };
  await runStart(second);

  assert.equal(ctx.state['i-abc123']?.start_failures, 1);
});

test('预算耗尽时不下发关机（最坏情况，但绝不超限）', async () => {
  world.trafficGb = 200;
  world.status = 'Running';
  // 2 个子请求给 inspect，剩 0 个给 StopInstance
  const { ctx } = await makeContext({ budgetLimit: 2 });

  await runMonitor(ctx);

  assert.deepEqual(world.ecsCalls, [], '预算不足时不应发请求');
  assert.equal(ctx.budget.used, 2);
});

test('流量查询失败：累加 check_failures，不误关机', async () => {
  world.trafficGb = 200;
  world.status = 'Running';
  world.failTraffic = true;
  const { ctx } = await makeContext();

  const found = await inspect(ctx, user());

  assert.equal(found, null);
  assert.equal(ctx.state['i-abc123']?.check_failures, 1);
  assert.deepEqual(world.ecsCalls, []);
});

test('连续 3 次查询失败：发监控失明告警', async () => {
  world.failTraffic = true;
  const { ctx } = await makeContext();

  await inspect(ctx, user());
  await inspect(ctx, user());
  await inspect(ctx, user());

  assert.equal(ctx.state['i-abc123']?.check_failures, 3);
  assert.equal(world.messages.length, 1);
  assert.match(world.messages[0]!, /监控异常告警/);
});

test('paused / disabled 的实例直接跳过', async () => {
  const { ctx } = await makeContext();
  assert.equal(await inspect(ctx, { ...user(), paused: true }), null);
  assert.equal(await inspect(ctx, { ...user(), disabled: true }), null);
  assert.equal(ctx.budget.used, 0, '跳过时不该花子请求');
});

test('handleTrafficOverlimit 会作废 pending_start_ts', async () => {
  world.trafficGb = 200;
  world.status = 'Running';
  const { ctx } = await makeContext();
  ctx.state['i-abc123'] = { pending_start_ts: 1 };

  const found = await inspect(ctx, user());
  assert.ok(found);
  await handleTrafficOverlimit(ctx, user(), found);

  assert.equal(ctx.state['i-abc123']?.pending_start_ts, undefined);
});

test('handleTrafficSafe 对中间态不干预', async () => {
  world.trafficGb = 10;
  world.status = 'Starting';
  const { ctx } = await makeContext();

  const found = await inspect(ctx, user());
  assert.ok(found);
  const acted = await handleTrafficSafe(ctx, user(), found);

  assert.equal(acted, false);
  assert.deepEqual(world.ecsCalls, []);
});
