/**
 * 每日财报。
 *
 * 格式沿用 src/fc/index.py 的 run_report / build_user_report，
 * 连缩进和 emoji 都保持一致 —— 这样从 FC 切过来时，历史消息能对上。
 */

import {
  describeInstance,
  ecsAction,
  fetchBill,
  fetchTrafficGb,
  probeBill,
  queryBalance,
  type Credentials,
} from './aliyun.ts';
import { credsFor, trafficLimit, usdCnyRate, type UserConfig } from './config.ts';
import { sendBark, sendTelegramChunks } from './notify.ts';
import type { TickContext } from './monitor.ts';
import { beijingDate, beijingMonth, num, redact, sanitizeMd, withRetry } from './util.ts';

export interface ReportOutcome {
  lines: number;
  telegram: boolean;
  bark: boolean;
  subrequests: number;
}

/**
 * 给这一行一句话结论，扫一眼就知道要不要管。
 * 优先级：流量超标 > 流量接近上限 > 扣费超过阈值 > 正常。
 */
export function evaluate(
  trafficGb: number | null,
  limit: number,
  billAmount: number | null,
  billCurrency: string,
  user: UserConfig,
  rate: number,
): string {
  if (trafficGb !== null && trafficGb >= limit) return '评估: ❌ 流量已超标，保持关机';
  if (trafficGb !== null && limit && trafficGb / limit >= 0.9) return '评估: ⚠️ 流量接近上限';

  let billLimit = num(user.bill_threshold, 1.0);
  if (billCurrency === 'CNY') billLimit *= rate;
  if (billAmount !== null && billAmount > billLimit) {
    return `评估: ⚠️ 扣费超过 ${billLimit.toFixed(2)} ${billCurrency || ''}`;
  }
  return '评估: ✅ 正常';
}

/** 内存按 GB 展示：整 GB 不显示小数，避免出现 "4.0 GB" 这种别扭写法 */
function formatMemoryGb(memory: unknown): string {
  const value = num(memory);
  if (!value) return '-';
  return value % 1 === 0 ? String(value) : value.toFixed(1);
}

async function buildUserReport(
  ctx: TickContext,
  user: UserConfig,
  balanceCache: Map<string, { amount: number | null; currency: string }>,
  rate: number,
): Promise<string[]> {
  const targetId = (user.instance_id ?? '').trim();
  const name = (user.name ?? '').trim() || targetId || 'Unknown_Device';

  if (user.paused || user.disabled) {
    return [`【${sanitizeMd(name)}】`, '  状态: ⏸️ 监控已暂停', ''];
  }

  const lines: string[] = [`【${sanitizeMd(name)}】`];
  const limit = trafficLimit(user);
  const creds = credsFor(ctx.config, user);

  let trafficGb: number | null = null;
  if (!ctx.budget.take(1)) {
    lines.push('  流量: 跳过（子请求预算不足）');
  } else {
    try {
      const traffic = await withRetry(
        () => fetchTrafficGb(creds, { log: ctx.log }),
        'CDT 流量查询',
        3,
        1000,
        ctx.log,
      );
      trafficGb = traffic.gb;
      const percent = limit ? (traffic.gb / limit) * 100 : 0;
      lines.push(
        `  流量: ${traffic.gb.toFixed(2)} GB / ${limit} GB (${percent.toFixed(1)}%)  ` +
          `[明细 ${traffic.detailCount} 条]`,
      );
      if (percent >= 90) lines.push('  ⚠️ 流量接近上限，马上要触发止损关机');
    } catch (error) {
      lines.push(`  流量: 查询失败 (${sanitizeMd(redact(error)).slice(0, 80)})`);
    }
  }

  if (!ctx.budget.take(1)) {
    lines.push('  状态: 跳过（子请求预算不足）');
  } else {
    try {
      const instance = await describeInstance(creds, user, { log: ctx.log });
      if (instance === null) {
        lines.push('  状态: 未找到实例');
      } else {
        const status = instance.Status ?? 'Unknown';
        const icon = status === 'Running' ? '🟢' : status === 'Stopped' ? '🔴' : '🟡';
        const addresses =
          instance.PublicIpAddress?.IpAddress ?? instance.InnerIpAddress?.IpAddress ?? ['-'];
        lines.push(`  状态: ${icon} ${status}`);
        lines.push(`  IP: ${addresses[0] ?? '-'}`);
        lines.push(
          `  规格: ${instance.InstanceType ?? '-'} / ${instance.Cpu ?? '-'} 核 ` +
            `${formatMemoryGb(instance.Memory)} GB`,
        );
      }
    } catch (error) {
      lines.push(`  状态: 查询失败 (${sanitizeMd(redact(error)).slice(0, 80)})`);
    }
  }

  let billAmount: number | null = null;
  let billCurrency = '';
  if (ctx.budget.take(1)) {
    const bill = await fetchBill(creds, user, targetId, beijingMonth(), { log: ctx.log });
    billAmount = bill.amount;
    billCurrency = bill.currency;
    if (bill.amount === null) {
      lines.push('  账单: Fail');
    } else {
      const scope = bill.scope === '账号总览' ? ' (账号总览)' : '';
      lines.push(`  账单: ${bill.amount.toFixed(4)} ${bill.currency}${scope}`);
    }
  } else {
    lines.push('  账单: 跳过（子请求预算不足）');
  }

  // 同一份 AK 的余额只查一次，多实例共用一个账号时能省一半子请求
  const cacheKey = creds.ak;
  if (!balanceCache.has(cacheKey)) {
    if (ctx.budget.take(1)) {
      balanceCache.set(cacheKey, await queryBalance(creds, user, { log: ctx.log }));
    } else {
      balanceCache.set(cacheKey, { amount: null, currency: '' });
    }
  }
  const balance = balanceCache.get(cacheKey)!;
  lines.push(
    '  余额: ' +
      (balance.amount === null ? 'Fail' : `${balance.amount.toFixed(2)} ${balance.currency}`),
  );

  lines.push('  ' + evaluate(trafficGb, limit, billAmount, billCurrency, user, rate));
  lines.push('');
  return lines;
}

export async function runReport(ctx: TickContext): Promise<ReportOutcome> {
  const users = ctx.config.users ?? [];
  const rate = usdCnyRate(ctx.config);
  const balanceCache = new Map<string, { amount: number | null; currency: string }>();

  const lines: string[] = ['📊 阿里云多账号 - 每日财报', `日期: ${beijingDate(ctx.now())}`, ''];
  for (const user of users) {
    try {
      lines.push(...(await buildUserReport(ctx, user, balanceCache, rate)));
    } catch (error) {
      lines.push(
        `【${sanitizeMd(user.name || 'Unknown')}】生成失败: ` +
          `${sanitizeMd(redact(error)).slice(0, 120)}`,
      );
      lines.push('');
    }
  }

  const message = lines.join('\n').replace(/\s+$/, '');
  const telegram = await sendTelegramChunks(ctx.config.telegram, message, ctx.log);
  const bark = await sendBark(ctx.config.bark, message, ctx.log);
  ctx.log.info(`日报已生成，${lines.length} 行，Telegram=${telegram} Bark=${bark}`);
  return { lines: lines.length, telegram, bark, subrequests: ctx.budget.used };
}

/**
 * 全链路自检：不碰真实状态、不发停机命令，只验证链路通不通。
 *
 * 这几个字段就是部署时的照妖镜：签名对不对、域名选对没有、
 * AK 权限够不够，一次全暴露。
 */
export async function runSelftest(
  ctx: TickContext,
): Promise<{ mode: string; elapsed: number; result: Record<string, unknown> }> {
  const started = ctx.now();
  const result: Record<string, unknown> = {};

  const instances: Array<Record<string, unknown>> = [];
  for (const user of ctx.config.users ?? []) {
    const item: Record<string, unknown> = { name: user.name || user.instance_id };
    let creds: Credentials;
    try {
      creds = credsFor(ctx.config, user);
    } catch (error) {
      item.error = redact(error);
      instances.push(item);
      continue;
    }
    try {
      const traffic = await withRetry(
        () => fetchTrafficGb(creds, { log: ctx.log }),
        'CDT 流量查询',
        3,
        1000,
        ctx.log,
      );
      item.traffic = `${traffic.gb.toFixed(2)} GB（明细 ${traffic.detailCount} 条）`;
    } catch (error) {
      item.traffic = `失败: ${redact(error)}`;
    }
    try {
      item.status = (await describeInstance(creds, user, { log: ctx.log }))?.Status ?? '未找到实例';
    } catch (error) {
      item.status = `失败: ${redact(error)}`;
    }
    try {
      item.bill = await probeBill(creds, beijingMonth(), { log: ctx.log });
    } catch (error) {
      item.bill = `探测失败: ${redact(error)}`;
    }
    instances.push(item);
  }
  result.instances = instances;

  return {
    mode: 'selftest',
    elapsed: Math.round((ctx.now() - started) / 100) / 10,
    result,
  };
}

/**
 * 用幂等请求探一次开关机权限 —— 不改变任何实例状态。
 *
 * 对已经 Running 的实例再发一次 StartInstance，对已经 Stopped 的再发
 * 一次 StopInstance，阿里云都按成功处理，状态不变。但鉴权、参数校验、
 * 签名这一整条链路都真实走了一遍。
 *
 * 为什么值得单独测：签名和权限是两件事。DescribeInstances 成功只能
 * 证明签名对，证明不了 RAM 里有 ecs:StopInstance —— 而后者一旦缺失，
 * 流量超标时止损会静默失败。
 */
const PERMISSION_MARKERS = ['forbidden', 'nopermission', 'no permission', 'not authorized', 'denied'];

function isPermissionError(text: string): boolean {
  const lowered = text.toLowerCase();
  return PERMISSION_MARKERS.some((marker) => lowered.includes(marker));
}

export async function probeEcsPermission(
  ctx: TickContext,
): Promise<{ mode: string; action: string; result: Array<Record<string, string>> }> {
  const results: Array<Record<string, string>> = [];
  for (const user of ctx.config.users ?? []) {
    if (user.paused || user.disabled) continue;
    const item: Record<string, string> = { name: user.name || user.instance_id };
    let creds: Credentials;
    try {
      creds = credsFor(ctx.config, user);
    } catch (error) {
      item.result = `凭证缺失: ${redact(error)}`;
      results.push(item);
      continue;
    }

    let status: string | null;
    try {
      status = (await describeInstance(creds, user, { log: ctx.log }))?.Status ?? null;
    } catch (error) {
      item.result = `取状态失败: ${redact(error)}`;
      results.push(item);
      continue;
    }
    if (status !== 'Running' && status !== 'Stopped') {
      item.result = `当前状态 ${status ?? '未知'}，中间态不发请求`;
      results.push(item);
      continue;
    }

    const action = status === 'Running' ? 'StartInstance' : 'StopInstance';
    try {
      await ecsAction(creds, user, action, false, { log: ctx.log });
      item.result = `✅ ${action} 权限正常（对 ${status} 状态的实例重复下发，状态不变）`;
    } catch (error) {
      const text = redact(error);
      item.result = isPermissionError(text)
        ? `❌ ${action} 权限不足 —— 止损会失败: ${text}`
        : `✅ ${action} 鉴权已通过（${text}）`;
    }
    results.push(item);
  }
  return { mode: 'ecs', action: 'probe', result: results };
}
