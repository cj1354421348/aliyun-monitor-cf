/**
 * 巡检核心：止损（关机）与开机两条路。
 *
 * 逻辑与 src/fc/index.py 的 run_monitor / run_start 一一对应，
 * 只在两处做了 Workers 适配：
 *
 * 1. 子请求预算。Workers 免费版每次调用只有 50 个子请求，一个实例
 *    一轮巡检就要 2 个（CDT 流量 + DescribeInstances），发通知还要
 *    再加 2~3 个。所以这里显式记账，超预算就停手并告警 ——
 *    宁可这一轮少查两台，也不能因为超限让整个 tick 抛异常。
 *
 * 2. 不再「发完启动命令就轮询等 Running」。FC 版有 300 秒超时，
 *    Workers 免费版 CPU 只有 10ms，等不了。改成发命令 → 记
 *    pending_start_ts → 下一次开机检查自然验证（默认 30 分钟后）。
 */

import {
  balanceLine,
  ecsAction,
  fetchInstanceStatus,
  fetchTrafficGb,
  FORCE_STOP,
  type Credentials,
} from './aliyun.ts';
import { credsFor, trafficLimit, type AppConfig, type UserConfig } from './config.ts';
import {
  NOTIFY_COOLDOWN,
  OVERLIMIT_COOLDOWN,
  sendTelegram,
} from './notify.ts';
import type { MonitorState, InstanceState } from './state.ts';
import { num, redact, sanitizeMd, withRetry } from './util.ts';
import type { Logger } from './util.ts';

/** 启动失败策略 */
export const MAX_START_FAILURES = 3;
export const RESOURCE_RETRY_COOLDOWN = 1800_000;

/** 巡检失明告警 */
export const CHECK_FAILURE_ALERT_THRESHOLD = 3;

/**
 * 每次 Worker 调用允许用掉的子请求数。
 * 免费版硬上限 50，留 10 个给通知和兜底探测，取 40。
 * 付费版可以调到 9000 左右。
 */
export const SUBREQUEST_BUDGET = 40;

export class Budget {
  used = 0;
  limit: number;
  constructor(limit = SUBREQUEST_BUDGET) {
    this.limit = limit;
  }
  /** 预估一次操作要花几个子请求，不够就返回 false */
  take(cost = 1): boolean {
    if (this.used + cost > this.limit) return false;
    this.used += cost;
    return true;
  }
  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }
}

export interface TickContext {
  config: AppConfig;
  state: MonitorState;
  log: Logger;
  budget: Budget;
  now: () => number;
}

function canNotify(state: InstanceState, event: string, cooldownMs: number, now: number): boolean {
  const last = num(state[event], 0);
  return now - last >= cooldownMs;
}

function markNotified(state: InstanceState, event: string, now: number): void {
  state[event] = now;
}

/**
 * 冷却判断 → 发送 → 成功后记录时间戳。
 *
 * 只有发送成功才记时间戳，失败下轮还会再试。
 * message 可以是函数 —— 余额查询只在真的要发通知时才该发生，
 * 否则 24 小时冷却期内每 5 分钟都会白打一次 BSS 接口。
 */
async function notify(
  ctx: TickContext,
  instanceId: string,
  event: string,
  cooldownMs: number,
  title: string,
  message: string | (() => Promise<string>),
): Promise<boolean> {
  const info = ctx.state[instanceId] ?? {};
  if (!canNotify(info, event, cooldownMs, ctx.now())) {
    ctx.log.info(`[${instanceId}] ${event} 在冷却期内，跳过通知`);
    return false;
  }
  if (!ctx.budget.take(1)) {
    ctx.log.warn(`[${instanceId}] 子请求预算耗尽，跳过通知 ${event}`);
    return false;
  }
  const text = typeof message === 'function' ? await message() : message;
  const result = await sendTelegram(ctx.config.telegram, title, text, { log: ctx.log });
  if (result.ok) {
    markNotified(info, event, ctx.now());
    return true;
  }
  return false;
}

/**
 * 余额行，带预算记账。
 *
 * 余额是「锦上添花」的信息：预算不够时宁可少这一行，也不能因为
 * 多打一次 BSS 接口把这一轮的子请求额度用穿，导致后面真正该发的
 * 告警发不出去。查询失败同样只吞掉，不影响告警正文。
 */
async function balanceLineSafe(
  ctx: TickContext,
  creds: Credentials,
  user: UserConfig,
): Promise<string> {
  if (!ctx.budget.take(1)) {
    ctx.log.warn(`[${user.name || user.instance_id}] 预算不足，告警里省略余额行`);
    return '';
  }
  try {
    return await balanceLine(creds, user, { log: ctx.log });
  } catch (error) {
    ctx.log.warn('查询余额失败，告警里省略余额行:', redact(error));
    return '';
  }
}

export interface InspectResult {
  info: InstanceState;
  name: string;
  trafficGb: number;
  status: string;
  creds: Credentials;
}

/**
 * 查流量 + 查状态 —— 关机和开机两条路共用的前置。
 *
 * 这一轮没法判断时返回 null（配置不全、已暂停、实例找不到、查询出错）。
 * 连续失败会发「监控失明」告警 —— 两条路都靠这份流量数据做决定，
 * 所以两条路都得有这道警报。
 */
export async function inspect(
  ctx: TickContext,
  user: UserConfig,
): Promise<InspectResult | null> {
  const instanceId = (user.instance_id ?? '').trim();
  const name = user.name || instanceId;
  if (!instanceId) {
    ctx.log.warn('配置项缺少 instance_id，跳过');
    return null;
  }
  if (user.paused || user.disabled) {
    ctx.log.info(`[${name}] 监控已暂停，跳过`);
    return null;
  }
  if (!ctx.budget.take(2)) {
    ctx.log.warn(`[${name}] 子请求预算不足（剩 ${ctx.budget.remaining}），本轮跳过`);
    return null;
  }

  const info = (ctx.state[instanceId] ??= {});
  try {
    const creds = credsFor(ctx.config, user);
    const traffic = await withRetry(
      () => fetchTrafficGb(creds, { log: ctx.log }),
      'CDT 流量查询',
      3,
      1000,
      ctx.log,
    );
    const status = await fetchInstanceStatus(creds, user, { log: ctx.log });
    if (status === null) {
      ctx.log.error(`[${name}] 未找到实例: ${instanceId}`);
      return null;
    }

    ctx.log.info(
      `[${name}] 流量 ${traffic.gb.toFixed(2)}GB/${trafficLimit(user)}GB` +
        `（明细 ${traffic.detailCount} 条），状态 ${status}`,
    );

    // 流量和状态都拿到了，说明监控没失明
    delete info.check_failures;
    return { info, name, trafficGb: traffic.gb, status, creds };
  } catch (error) {
    // 连续失败 = 对这个实例已经失明，期间无法自动止损，必须叫人工
    const errorText = redact(error);
    ctx.log.error(`[${name}] 检查出错: ${errorText}`);
    info.check_failures = num(info.check_failures, 0) + 1;
    if (info.check_failures >= CHECK_FAILURE_ALERT_THRESHOLD) {
      await notify(
        ctx,
        instanceId,
        'check_failed',
        NOTIFY_COOLDOWN,
        '监控异常告警',
        `机器: ${sanitizeMd(name)}\n⚠️ 已连续 ${info.check_failures} 次巡检失败，` +
          `最近错误: ${sanitizeMd(errorText)}\n` +
          '期间流量监控与自动止损不可用，请人工确认实例状态。',
      );
    }
    return null;
  }
}

function resetStartFailures(info: InstanceState): void {
  info.start_failures = 0;
  delete info.pending_start_ts;
  delete info.last_retry_ts;
}

/**
 * 流量安全：该开机就开机。返回 true 表示真的发出了启动命令。
 *
 * 不在这里轮询等 Running —— 发出命令后只记 pending_start_ts，
 * 下一次开机检查自然验证（默认 30 分钟后）。
 */
export async function handleTrafficSafe(
  ctx: TickContext,
  user: UserConfig,
  found: InspectResult,
): Promise<boolean> {
  const { info, name, trafficGb, status, creds } = found;
  const instanceId = user.instance_id;
  const pending = num(info.pending_start_ts, 0);

  if (status === 'Running') {
    resetStartFailures(info);
    if (pending) {
      ctx.log.info(`[${name}] 实例已恢复运行`);
      await notify(ctx, instanceId, 'resumed', NOTIFY_COOLDOWN, '恢复监控', async () => {
        const line = await balanceLineSafe(ctx, creds, user);
        return `机器: ${sanitizeMd(name)}\n当前流量: ${trafficGb.toFixed(2)}GB${line}\n动作: 恢复运行 ✅`;
      });
    } else {
      ctx.log.info(`[${name}] 流量安全，实例运行中`);
    }
    return false;
  }

  if (status === 'Stopped') {
    let failures = num(info.start_failures, 0);

    if (pending) {
      // 上一轮发了启动命令但它没起来（资源不足 / 被拒绝 / 又被人关了）
      delete info.pending_start_ts;
      failures += 1;
      info.start_failures = failures;
      ctx.log.warn(`[${name}] 上一轮启动命令未生效，累计失败 ${failures} 次`);
    }

    if (failures >= MAX_START_FAILURES) {
      const elapsed = ctx.now() - num(info.last_retry_ts, 0);
      if (elapsed < RESOURCE_RETRY_COOLDOWN) {
        ctx.log.info(
          `[${name}] 已连续 ${failures} 次启动失败，` +
            `距下次重试还需 ${Math.round((RESOURCE_RETRY_COOLDOWN - elapsed) / 1000)}s，本轮跳过`,
        );
        return false;
      }
      ctx.log.info(`[${name}] 冷却期已过，再次尝试启动`);
    }

    info.last_retry_ts = ctx.now();
    if (!ctx.budget.take(1)) {
      ctx.log.warn(`[${name}] 子请求预算耗尽，本轮放弃启动`);
      return false;
    }
    try {
      await ecsAction(creds, user, 'StartInstance', false, { log: ctx.log });
    } catch (error) {
      const errorText = redact(error);
      failures += 1;
      info.start_failures = failures;
      ctx.log.warn(`[${name}] StartInstance 失败: ${errorText}，累计失败 ${failures} 次`);
      await notify(ctx, instanceId, 'start_failed', NOTIFY_COOLDOWN, '启动失败告警', async () => {
        const line = await balanceLineSafe(ctx, creds, user);
        return (
          `机器: ${sanitizeMd(name)}\n当前流量: ${trafficGb.toFixed(2)}GB${line}\n` +
          `⚠️ 启动 API 调用失败: ${sanitizeMd(errorText)}\n` +
          `累计失败 ${failures} 次，脚本将每 ${RESOURCE_RETRY_COOLDOWN / 60000} 分钟自动重试。`
        );
      });
      return false;
    }

    info.pending_start_ts = ctx.now();
    ctx.log.info(`[${name}] StartInstance 命令已发送，等下次开机检查验证`);
    return true;
  }

  // Starting / Stopping 等中间态，不干预
  ctx.log.info(`[${name}] 实例处于中间态: ${status}，不干预`);
  return false;
}

/** 流量超标：该关机就关机。返回 true 表示真的发出了关机命令。 */
export async function handleTrafficOverlimit(
  ctx: TickContext,
  user: UserConfig,
  found: InspectResult,
): Promise<boolean> {
  const { info, name, trafficGb, status, creds } = found;
  const instanceId = user.instance_id;
  const limit = trafficLimit(user);
  // 流量已超标，之前排队等验证的启动记录作废
  delete info.pending_start_ts;

  if (status === 'Running') {
    ctx.log.info(`[${name}] 流量超标(${trafficGb.toFixed(2)}GB >= ${limit}GB)，正在停止...`);
    if (!ctx.budget.take(1)) {
      ctx.log.error(`[${name}] 子请求预算耗尽，无法下发关机 —— 这是最坏的情况`);
      return false;
    }
    await ecsAction(creds, user, 'StopInstance', FORCE_STOP, { log: ctx.log });
    await notify(ctx, instanceId, 'overlimit', OVERLIMIT_COOLDOWN, '流量预警', async () => {
      const line = await balanceLineSafe(ctx, creds, user);
      return `机器: ${sanitizeMd(name)}\n当前流量: ${trafficGb.toFixed(2)}GB${line}\n动作: 已触发止损关机 🛑`;
    });
    return true;
  }

  ctx.log.info(`[${name}] 已停止止损 - ${trafficGb.toFixed(2)}GB`);
  await notify(ctx, instanceId, 'overlimit', OVERLIMIT_COOLDOWN, '流量超标提醒', async () => {
    const line = await balanceLineSafe(ctx, creds, user);
    return `机器: ${sanitizeMd(name)}\n当前流量: ${trafficGb.toFixed(2)}GB${line}\n状态: 流量超标，已保持关机 🛑`;
  });
  return false;
}

export interface MonitorOutcome {
  instances: number;
  stopped: number;
  skipped: number;
  subrequests: number;
}

/**
 * 只做止损：流量超标就关机。
 *
 * 刻意不管开机。关机和开机是两件风险不同的事 ——
 * 关机是抢救，要快（5 分钟一趟）；开机是恢复，可以慢，
 * 而且常常需要你单独控制。开机在 runStart 里。
 */
export async function runMonitor(ctx: TickContext): Promise<MonitorOutcome> {
  const users = ctx.config.users ?? [];
  let stopped = 0;
  let skipped = 0;

  for (const user of users) {
    try {
      const found = await inspect(ctx, user);
      if (found === null) {
        skipped += 1;
        continue;
      }
      if (found.trafficGb < trafficLimit(user)) continue;
      if (await handleTrafficOverlimit(ctx, user, found)) stopped += 1;
    } catch (error) {
      // 单台机器的失败不能影响其他机器
      ctx.log.error(
        `[${user.name || user.instance_id}] 止损巡检异常: ${redact(error)}`,
      );
    }
  }

  return { instances: users.length, stopped, skipped, subrequests: ctx.budget.used };
}

export interface StartOutcome {
  instances: number;
  started: number;
  skipped: number;
  subrequests: number;
}

/**
 * 按流量条件开机。
 *
 * 单独一个阶段，为的就是让你能独立控制它：
 *   · 改 SCHEDULE 里的 start 开关 = 禁止自动开机（配置一个字都不用改）
 *   · 手动发 POST /run?mode=start = 现在就检查一遍，该开就开
 */
export async function runStart(ctx: TickContext): Promise<StartOutcome> {
  const users = ctx.config.users ?? [];
  let started = 0;
  let skipped = 0;

  for (const user of users) {
    try {
      const found = await inspect(ctx, user);
      if (found === null) {
        skipped += 1;
        continue;
      }
      if (found.trafficGb >= trafficLimit(user)) {
        // 只记日志，不改状态：pending_start_ts 由 monitor 负责作废。
        // monitor 每 5 分钟跑一趟，start 每 30 分钟，所以最多 5 分钟内
        // 一定会被清掉。这里不动状态是有意的 —— 两个阶段若在「超标」
        // 这个判断上同时写状态，整点那一秒就会互相覆盖。
        ctx.log.info(`[${user.name}] 流量 ${found.trafficGb.toFixed(2)}GB 已超标，不开机`);
        continue;
      }
      if (await handleTrafficSafe(ctx, user, found)) started += 1;
    } catch (error) {
      ctx.log.error(`[${user.name || user.instance_id}] 开机检查异常: ${redact(error)}`);
    }
  }

  return { instances: users.length, started, skipped, subrequests: ctx.budget.used };
}
