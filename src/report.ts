/**
 * 每日财报。
 *
 * 版式对齐用户旧版 FC 脚本的观感：一条实例一段，字段左对齐缩进三格，
 * 每个字段前面一个 emoji，扫一眼就能找到想看的那行。
 *
 * 关键设计：所有数据先查完再渲染。因为实例名后面要跟规格 (2C0.5G)，
 * 而规格来自 describeInstance —— 边查边拼的话，标题得写在规格之前，
 * 就只能把标题塞到后面再回填，反而更绕。
 */

import {
  describeInstance,
  ecsAction,
  fetchAccountBill,
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
 *
 * 返回的是「评价」行的值，所以正常时只有一个 ✅，异常时才补一句原因 ——
 * 天天都看「评估: ✅ 正常」会让人习惯性忽略这一行，真出事时反而漏掉。
 */
export function evaluate(
  trafficGb: number | null,
  limit: number,
  billAmount: number | null,
  billCurrency: string,
  user: UserConfig,
  rate: number,
): string {
  if (trafficGb !== null && trafficGb >= limit) return '❌ 流量已超标，保持关机';
  if (trafficGb !== null && limit && trafficGb / limit >= 0.9) return '⚠️ 流量接近上限';

  let billLimit = num(user.bill_threshold, 1.0);
  if (billCurrency === 'CNY') billLimit *= rate;
  if (billAmount !== null && billAmount > billLimit) {
    return `⚠️ 扣费超过 ${billLimit.toFixed(2)} ${billCurrency || ''}`.trim();
  }
  return '✅';
}

/** 内存按 GB 展示：整 GB 不显示小数，避免出现 "4.0 GB" 这种别扭写法 */
function formatMemoryGb(memory: unknown): string {
  const value = num(memory);
  if (!value) return '-';
  return value % 1 === 0 ? String(value) : value.toFixed(1);
}

/** 货币符号：认识的用符号，不认识的退回 "0.44 USD" */
function money(amount: number | null, currency: string, digits = 2): string {
  if (amount === null) return 'Fail';
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : '';
  if (!symbol) return `${amount.toFixed(digits)}${currency ? ' ' + currency : ''}`;
  return `${symbol}${amount.toFixed(digits)}`;
}

/** 实例规格，拼成 2C0.5G；拿不到就返回空串，标题里不显示括号 */
function specText(instance: { Cpu?: unknown; Memory?: unknown } | null): string {
  if (!instance) return '';
  const cpu = num(instance.Cpu);
  const mem = formatMemoryGb(instance.Memory);
  if (!cpu || mem === '-') return '';
  return `${cpu}C${mem}G`;
}

function statusIcon(status: string | null): string {
  if (status === null) return '⚪';
  if (status === 'Running') return '🟢';
  if (status === 'Stopped') return '🔴';
  return '🟡';
}

async function buildUserReport(
  ctx: TickContext,
  user: UserConfig,
  caches: {
    balance: Map<string, { amount: number | null; currency: string }>;
    accountBill: Map<string, { amount: number | null; currency: string }>;
  },
  rate: number,
): Promise<string[]> {
  const targetId = (user.instance_id ?? '').trim();
  const name = (user.name ?? '').trim() || targetId || 'Unknown_Device';

  if (user.paused || user.disabled) {
    return [`👤 ${sanitizeMd(name)}`, '   ⏸️ 监控已暂停', ''];
  }

  const limit = trafficLimit(user);
  const creds = credsFor(ctx.config, user);

  // ── 查数据 ────────────────────────────────────────────────
  let trafficGb: number | null = null;
  let trafficNote = '';
  if (!ctx.budget.take(1)) {
    trafficNote = '跳过（子请求预算不足）';
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
    } catch (error) {
      trafficNote = `查询失败 (${sanitizeMd(redact(error)).slice(0, 60)})`;
    }
  }

  let instance: Awaited<ReturnType<typeof describeInstance>> = null;
  let statusNote = '';
  if (!ctx.budget.take(1)) {
    statusNote = '跳过（子请求预算不足）';
  } else {
    try {
      instance = await describeInstance(creds, user, { log: ctx.log });
      if (instance === null) statusNote = '未找到实例';
    } catch (error) {
      statusNote = `查询失败 (${sanitizeMd(redact(error)).slice(0, 60)})`;
    }
  }

  let billAmount: number | null = null;
  let billCurrency = '';
  let billNote = '';
  if (ctx.budget.take(1)) {
    const bill = await fetchBill(creds, user, targetId, beijingMonth(), { log: ctx.log });
    billAmount = bill.amount;
    billCurrency = bill.currency;
  } else {
    billNote = '跳过（子请求预算不足）';
  }

  // 账号总账、余额都是账号级数据，同一份 AK 只查一次
  const cacheKey = creds.ak;
  if (!caches.accountBill.has(cacheKey)) {
    if (ctx.budget.take(1)) {
      caches.accountBill.set(
        cacheKey,
        await fetchAccountBill(creds, user, beijingMonth(), { log: ctx.log }),
      );
    } else {
      caches.accountBill.set(cacheKey, { amount: null, currency: '' });
    }
  }
  if (!caches.balance.has(cacheKey)) {
    if (ctx.budget.take(1)) {
      caches.balance.set(cacheKey, await queryBalance(creds, user, { log: ctx.log }));
    } else {
      caches.balance.set(cacheKey, { amount: null, currency: '' });
    }
  }
  const accountBill = caches.accountBill.get(cacheKey)!;
  const balance = caches.balance.get(cacheKey)!;

  // ── 渲染 ──────────────────────────────────────────────────
  const spec = specText(instance);
  const lines: string[] = [`👤 ${sanitizeMd(name)}${spec ? ` (${spec})` : ''}`];

  lines.push(
    `   🖥️ 状态: ${statusNote ? sanitizeMd(statusNote) : `${statusIcon(instance?.Status ?? null)} ${instance?.Status ?? 'Unknown'}`}`,
  );

  if (instance) {
    const addresses = instance.PublicIpAddress?.IpAddress ?? instance.InnerIpAddress?.IpAddress ?? [];
    lines.push(`   🌐 IP: ${addresses[0] ?? '-'}`);
  }

  if (trafficNote) {
    lines.push(`   📉 流量: ${sanitizeMd(trafficNote)}`);
  } else if (trafficGb !== null) {
    const percent = limit ? (trafficGb / limit) * 100 : 0;
    lines.push(`   📉 流量: ${trafficGb.toFixed(2)} GB (${percent.toFixed(1)}%)`);
  }

  lines.push(
    billNote
      ? `   💰 实例账单: ${sanitizeMd(billNote)}`
      : `   💰 实例账单: ${money(billAmount, billCurrency, 2)}`,
  );
  lines.push(`   📊 账户总账: ${money(accountBill.amount, accountBill.currency, 2)}`);
  lines.push(`   💳 余额: ${money(balance.amount, balance.currency, 2)}`);
  lines.push(
    `   📝 评价: ${sanitizeMd(evaluate(trafficGb, limit, billAmount, billCurrency, user, rate))}`,
  );
  lines.push('');
  return lines;
}

export async function runReport(ctx: TickContext): Promise<ReportOutcome> {
  const users = ctx.config.users ?? [];
  const rate = usdCnyRate(ctx.config);
  const caches = {
    balance: new Map<string, { amount: number | null; currency: string }>(),
    accountBill: new Map<string, { amount: number | null; currency: string }>(),
  };

  const lines: string[] = [
    '📊 [阿里云多账号 - 每日财报]',
    `📅 日期: ${beijingDate(ctx.now())}`,
    '',
  ];
  for (const user of users) {
    try {
      lines.push(...(await buildUserReport(ctx, user, caches, rate)));
    } catch (error) {
      lines.push(
        `👤 ${sanitizeMd(user.name || 'Unknown')} 生成失败: ` +
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
