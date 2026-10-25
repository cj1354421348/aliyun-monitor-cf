/**
 * 网页看板。
 *
 * ================================================================
 * 为什么内联在 Worker 里，不用 public/ 静态资源
 * ================================================================
 * 用 [assets] 拆成独立文件当然更清爽，但那样要改 wrangler.toml。
 * 这套部署的 KV 绑定是靠 [unsafe.metadata] 的 keep_bindings 保住的
 * （见 wrangler.toml 里的注释），配置一动就得重新验证整条构建链。
 * 为了 HTML 好看一点去冒这个风险不值得 —— 所以整页作为一个模板
 * 字符串放在这里，wrangler.toml 一个字不动。
 *
 * ================================================================
 * 认证：账号密码 + 签名 Cookie
 * ================================================================
 * 用户名/密码放在 Worker Secret（DASHBOARD_USER / DASHBOARD_PASS），
 * 登录成功后下发一个 HMAC 签名的 Cookie：
 *
 *     dash = <过期毫秒>.<hmac_sha256(DASHBOARD_PASS, "dash-v1:" + 过期毫秒)>
 *
 * 签名密钥直接用密码本身，不额外引入 SESSION_KEY —— 少一个要记的变量，
 * 换密码时旧会话自动全部失效，正好是想要的行为。
 *
 * Cookie 属性 HttpOnly + Secure + SameSite=Strict：
 *   - HttpOnly   页面里的 JS 读不到，XSS 也偷不走
 *   - SameSite   跨站请求根本不带这个 Cookie，CSRF 的第一道墙
 *   - 第二道墙   所有写操作要求 X-Requested-With: dashboard，
 *                跨站表单发不出自定义头
 *
 * ================================================================
 * 数据接口的取舍
 * ================================================================
 * /api/summary 只读 KV，不花阿里云子请求，可以随便刷。
 * /api/status 每台实例要 5 个子请求（流量 + 实例 + 实例账单 + 总账 + 余额，
 * 后两个按 AK 缓存），所以：
 *   - 不做自动轮询，打开拉一次 + 手动刷新
 *   - 用 POST 而不是 GET，避免浏览器预取和爬虫误触发
 */

import {
  describeInstance,
  fetchAccountBill,
  fetchBill,
  fetchTrafficGb,
  publicIpOf,
  queryBalance,
  type Credentials,
} from './aliyun.ts';
import { credsFor, trafficLimit, usdCnyRate, type AppConfig, type UserConfig } from './config.ts';
import { evaluate } from './report.ts';
import { CRON, planFor, resolveSchedule, type ScheduleConfig } from './scheduler.ts';
import type { TickContext } from './monitor.ts';
import { beijingDate, beijingHhMm, beijingMonth, num, redact, withRetry } from './util.ts';

// ---------- 会话 ----------

export const SESSION_COOKIE = 'dash';

/** 默认 180 天。签名里带过期时间，改这个值不影响已签发的会话 */
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const SESSION_VERSION = 'dash-v1:';

async function hmacHex(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  let hex = '';
  for (const byte of new Uint8Array(signature)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** 定长比较，避免用长度或前缀泄漏信息 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 签一个会话值：`<过期毫秒>.<签名>`
 *
 * 密码为空时直接抛 —— WebCrypto 不接受零长度 HMAC 密钥（DataError），
 * 而且"用空密钥签出的会话"本身就没有意义。调用方（/api/login）在这之前
 * 已经检查过 DASHBOARD_PASS 是否配置。
 */
export async function signSession(
  pass: string,
  expiresAt: number,
): Promise<string> {
  if (!pass) throw new Error('DASHBOARD_PASS 为空，无法签发会话');
  const payload = String(expiresAt);
  const signature = await hmacHex(pass, SESSION_VERSION + payload);
  return `${payload}.${signature}`;
}

/** 验会话：先看有没有过期，再定长比较签名 */
export async function verifySession(
  pass: string,
  value: string,
  now: number,
): Promise<boolean> {
  if (!pass) return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!/^\d+$/.test(payload) || !signature) return false;
  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  const expected = await hmacHex(pass, SESSION_VERSION + payload);
  return timingSafeEqual(signature, expected);
}

/** 从 Cookie 头里取一个值 */
export function readCookie(header: string | null, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return '';
}

export function sessionCookie(value: string, maxAgeSeconds: number): string {
  return (
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; ` +
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  );
}

export function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// ---------- 下一次各任务时刻 ----------

/** 从 cron 的分钟字段里取步长，解析不了就按 5 分钟 */
export function cronStep(cron: string): number {
  const minuteField = cron.trim().split(/\s+/)[0] ?? '';
  const match = /^\*\/(\d+)$/.exec(minuteField);
  const step = match ? Number(match[1]) : 5;
  return Number.isInteger(step) && step > 0 && step < 60 ? step : 5;
}

/** 向上取整到「UTC 分钟数是 step 整数倍」的整分时刻（cron 按 UTC 触发） */
export function alignUpToStep(ts: number, step: number): number {
  const minuteMs = 60_000;
  const aligned = Math.ceil(ts / minuteMs) * minuteMs;
  const utcMinute = Math.round(aligned / minuteMs);
  const remainder = utcMinute % step;
  return remainder === 0 ? aligned : aligned + (step - remainder) * minuteMs;
}

export interface NextRuns {
  monitor: number | null;
  start: number | null;
  report: number | null;
}

/**
 * 往后扫 8 天，找出下一次巡检 / 开机 / 日报的时刻。
 *
 * 逐分钟扫而不是解析日历：cron 表达式的步长、start_at_minutes、
 * report_weekdays 三者耦合（分钟数必须能被步长整除、星期要匹配），
 * 用现成的 planFor 扫一遍是最不容易写错的写法，代价可以忽略
 * （最多 11520 次纯函数调用）。
 */
export function nextRuns(
  now: number,
  schedule: ScheduleConfig = {},
  cron = CRON,
): NextRuns {
  const step = cronStep(cron);
  const first = alignUpToStep(now + 60_000, step);
  let start: number | null = null;
  let report: number | null = null;
  const maxSteps = (8 * 24 * 60) / step;

  for (let i = 0; i < maxSteps; i += 1) {
    const at = first + i * step * 60_000;
    const plan = planFor(at, schedule);
    if (start === null && plan.start) start = at;
    if (report === null && plan.report) report = at;
    if (start !== null && report !== null) break;
  }
  return { monitor: first, start, report };
}

// ---------- 状态采集 ----------

export interface MoneyView {
  amount: number | null;
  currency: string;
}

export interface InstanceView {
  name: string;
  instance_id: string;
  paused: boolean;
  cpu: number | null;
  memory_mib: number | null;
  status: string | null;
  ip: string | null;
  traffic: { gb: number | null; limit: number; percent: number | null; note?: string };
  bill: { instance: MoneyView; account: MoneyView };
  balance: MoneyView;
  verdict: string;
  notes: string[];
}

export interface StatusPayload {
  fetched_at: number;
  fetched_at_text: string;
  subrequests: number;
  budget: number;
  instances: InstanceView[];
}

const EMPTY_MONEY: MoneyView = { amount: null, currency: '' };

/**
 * 采集各实例的完整状态。
 *
 * 和 report.ts 的 buildUserReport() 有一部分重复（都要查流量/实例/账单/余额），
 * 这是故意的：那条链路刚验收过，改它等于把 Telegram 日报的版式一起拖下水。
 * 这里返回的是给前端用的结构体，和给人读的文本本来就是两种东西。
 */
export async function collectStatus(ctx: TickContext): Promise<StatusPayload> {
  const rate = usdCnyRate(ctx.config);
  const accountBills = new Map<string, MoneyView>();
  const balances = new Map<string, MoneyView>();
  const instances: InstanceView[] = [];

  for (const user of ctx.config.users ?? []) {
    instances.push(await collectOne(ctx, user, accountBills, balances, rate));
  }

  return {
    fetched_at: ctx.now(),
    fetched_at_text: `${beijingDate(ctx.now())} ${beijingHhMm(ctx.now())}`,
    subrequests: ctx.budget.used,
    budget: ctx.budget.limit,
    instances,
  };
}

async function collectOne(
  ctx: TickContext,
  user: UserConfig,
  accountBills: Map<string, MoneyView>,
  balances: Map<string, MoneyView>,
  rate: number,
): Promise<InstanceView> {
  const instanceId = (user.instance_id ?? '').trim();
  const name = (user.name ?? '').trim() || instanceId || 'Unknown_Device';
  const limit = trafficLimit(user);
  const notes: string[] = [];
  const view: InstanceView = {
    name,
    instance_id: instanceId,
    paused: Boolean(user.paused || user.disabled),
    cpu: null,
    memory_mib: null,
    status: null,
    ip: null,
    traffic: { gb: null, limit, percent: null },
    bill: { instance: { ...EMPTY_MONEY }, account: { ...EMPTY_MONEY } },
    balance: { ...EMPTY_MONEY },
    verdict: '—',
    notes,
  };

  if (view.paused) {
    view.verdict = '⏸️ 已暂停';
    return view;
  }

  let creds: Credentials;
  try {
    creds = credsFor(ctx.config, user);
  } catch (error) {
    notes.push(`凭证缺失: ${redact(error)}`);
    view.verdict = '❌ 无可用 AccessKey';
    return view;
  }

  // 流量
  if (!ctx.budget.take(1)) {
    notes.push('流量: 跳过（子请求预算不足）');
  } else {
    try {
      const traffic = await withRetry(
        () => fetchTrafficGb(creds, { log: ctx.log }),
        'CDT 流量查询',
        3,
        1000,
        ctx.log,
      );
      view.traffic.gb = traffic.gb;
      view.traffic.percent = limit ? (traffic.gb / limit) * 100 : null;
    } catch (error) {
      notes.push(`流量查询失败: ${redact(error).slice(0, 120)}`);
    }
  }

  // 实例
  if (!ctx.budget.take(1)) {
    notes.push('实例状态: 跳过（子请求预算不足）');
  } else {
    try {
      const instance = await describeInstance(creds, user, { log: ctx.log });
      if (instance === null) {
        notes.push('未找到实例');
      } else {
        view.status = instance.Status ?? null;
        view.ip = publicIpOf(instance);
        view.cpu = num(instance.Cpu) || null;
        view.memory_mib = num(instance.Memory) || null;
      }
    } catch (error) {
      notes.push(`实例查询失败: ${redact(error).slice(0, 120)}`);
    }
  }

  // 实例账单
  const cycle = beijingMonth(ctx.now());
  if (!ctx.budget.take(1)) {
    notes.push('实例账单: 跳过（子请求预算不足）');
  } else {
    try {
      const bill = await fetchBill(creds, user, instanceId, cycle, { log: ctx.log });
      view.bill.instance = { amount: bill.amount, currency: bill.currency };
    } catch (error) {
      notes.push(`实例账单查询失败: ${redact(error).slice(0, 120)}`);
    }
  }

  // 账号级数据：同一份 AK 只查一次
  const cacheKey = creds.ak;
  if (!accountBills.has(cacheKey)) {
    if (ctx.budget.take(1)) {
      try {
        const account = await fetchAccountBill(creds, user, cycle, { log: ctx.log });
        accountBills.set(cacheKey, { amount: account.amount, currency: account.currency });
      } catch (error) {
        accountBills.set(cacheKey, { ...EMPTY_MONEY });
        notes.push(`账户总账查询失败: ${redact(error).slice(0, 120)}`);
      }
    } else {
      accountBills.set(cacheKey, { ...EMPTY_MONEY });
      notes.push('账户总账: 跳过（子请求预算不足）');
    }
  }
  if (!balances.has(cacheKey)) {
    if (ctx.budget.take(1)) {
      try {
        const balance = await queryBalance(creds, user, { log: ctx.log });
        balances.set(cacheKey, { amount: balance.amount, currency: balance.currency });
      } catch (error) {
        balances.set(cacheKey, { ...EMPTY_MONEY });
        notes.push(`余额查询失败: ${redact(error).slice(0, 120)}`);
      }
    } else {
      balances.set(cacheKey, { ...EMPTY_MONEY });
      notes.push('余额: 跳过（子请求预算不足）');
    }
  }
  view.bill.account = accountBills.get(cacheKey)!;
  view.balance = balances.get(cacheKey)!;

  view.verdict = evaluate(
    view.traffic.gb,
    limit,
    view.bill.instance.amount,
    view.bill.instance.currency,
    user,
    rate,
  );
  return view;
}

// ---------- KV 摘要（不花阿里云子请求） ----------

export interface SummaryPayload {
  now: number;
  now_text: string;
  schedule: ReturnType<typeof resolveSchedule>;
  next: {
    monitor: string;
    start: string | null;
    report: string | null;
    start_ts: number | null;
    report_ts: number | null;
  };
  instances: Array<{
    instance_id: string;
    name: string;
    paused: boolean;
    check_failures: number;
    start_failures: number;
    pending_start: string | null;
    last_notified: Array<{ event: string; at: string }>;
  }>;
}

/**
 * 状态里哪些 key 是「事件时间戳」，哪些是内部计数/时间。
 *
 * InstanceState 的形状是 `[event: string]: number | undefined` —— 事件名和
 * 内部字段混在同一个扁平对象里，只能靠白名单区分，否则 last_retry_ts
 * 会被当成一条「已通知事件」列出来。
 */
const EVENT_KEYS = ['overlimit', 'resumed', 'start_failed', 'check_failed'];

const EVENT_LABELS: Record<string, string> = {
  overlimit: '流量超标',
  resumed: '恢复监控',
  start_failed: '启动失败',
  check_failed: '巡检失败',
};

export function buildSummary(
  config: AppConfig,
  stateData: Record<string, Record<string, number | undefined>>,
  now: number,
): SummaryPayload {
  const schedule = resolveSchedule(config.schedule);
  const next = nextRuns(now, config.schedule);
  const fmt = (ts: number | null) => (ts === null ? null : `${beijingDate(ts)} ${beijingHhMm(ts)}`);

  return {
    now,
    now_text: `${beijingDate(now)} ${beijingHhMm(now)}`,
    schedule,
    next: {
      monitor: fmt(next.monitor) ?? '',
      start: fmt(next.start),
      report: fmt(next.report),
      start_ts: next.start,
      report_ts: next.report,
    },
    instances: (config.users ?? []).map((user) => {
      const id = (user.instance_id ?? '').trim();
      const info = stateData[id] ?? {};
      const lastNotified = EVENT_KEYS.map((key) => {
        const at = num(info[key], 0);
        return at ? { event: EVENT_LABELS[key] ?? key, at: fmt(at) ?? '' } : null;
      })
        .filter((item): item is { event: string; at: string } => item !== null)
        .sort((a, b) => (a.at < b.at ? 1 : -1));
      const pending = num(info.pending_start_ts, 0);
      return {
        instance_id: id,
        name: (user.name ?? '').trim() || id,
        paused: Boolean(user.paused || user.disabled),
        check_failures: num(info.check_failures, 0),
        start_failures: num(info.start_failures, 0),
        pending_start: pending ? (fmt(pending) ?? null) : null,
        last_notified: lastNotified,
      };
    }),
  };
}

// ---------- 页面 ----------

/**
 * 整页 HTML。
 *
 * 注意：这个模板字符串里**没有** ${} 和反引号 —— 前端 JS 全部用字符串
 * 拼接，就是为了让这一大段能安全地塞进 TS 模板字符串，不用满地转义。
 * 改样式时请保持这个约定。
 */
export function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>阿里云 CDT 监控</title>
<style>
  :root {
    --bg: #0f1218;
    --card: #171c25;
    --line: #252c39;
    --text: #e6ebf2;
    --dim: #8b95a7;
    --green: #35c07a;
    --orange: #e8a33d;
    --red: #e5574f;
    --blue: #4a90e2;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    max-width: 720px;
    margin: 0 auto;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 4px;
  }
  h1 { font-size: 17px; margin: 0; font-weight: 600; letter-spacing: .3px; }
  .toolbar { display: flex; gap: 8px; }
  .sub { color: var(--dim); font-size: 12px; margin-bottom: 16px; }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 12px;
  }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .name { font-weight: 600; font-size: 15px; }
  .spec { color: var(--dim); font-size: 12px; font-weight: 400; margin-left: 6px; }
  .ip { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
  .status { font-size: 13px; white-space: nowrap; }
  .bar-wrap { margin: 12px 0 6px; }
  .bar {
    height: 7px;
    background: #222a36;
    border-radius: 4px;
    overflow: hidden;
  }
  .bar > i { display: block; height: 100%; width: 0; background: var(--green); transition: width .3s; }
  .bar-num {
    display: flex; justify-content: space-between;
    font-size: 12px; color: var(--dim);
    font-variant-numeric: tabular-nums;
    margin-top: 5px;
  }
  .money { display: flex; flex-wrap: wrap; gap: 14px; font-size: 13px; margin-top: 10px; }
  .money b { font-weight: 600; font-variant-numeric: tabular-nums; }
  .money span { color: var(--dim); }
  .verdict { margin-top: 10px; font-size: 13px; }
  .notes { margin-top: 8px; font-size: 12px; color: var(--orange); }
  .notes div { margin-top: 2px; }
  .meta { font-size: 12px; color: var(--dim); display: flex; flex-wrap: wrap; gap: 14px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  button {
    font: inherit;
    font-size: 13px;
    padding: 7px 13px;
    border-radius: 7px;
    border: 1px solid var(--line);
    background: #1f2632;
    color: var(--text);
    cursor: pointer;
  }
  button:hover:not(:disabled) { border-color: var(--blue); }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: #1d3a5c; border-color: #2c5b8c; }
  pre {
    background: #10141b;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 12px;
    font-size: 12px;
    overflow: auto;
    max-height: 340px;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 10px 0 0;
  }
  .err { color: var(--red); }
  .ok { color: var(--green); }
  #login { max-width: 320px; margin: 12vh auto 0; }
  #login input {
    width: 100%;
    font: inherit;
    padding: 9px 11px;
    margin-bottom: 10px;
    border-radius: 7px;
    border: 1px solid var(--line);
    background: #10141b;
    color: var(--text);
  }
  #login button { width: 100%; }
  .hint { color: var(--dim); font-size: 12px; margin-top: 10px; text-align: center; }
  [hidden] { display: none !important; }
</style>
</head>
<body>

<div id="login" hidden>
  <h1 style="margin-bottom:14px">阿里云 CDT 监控</h1>
  <input id="u" placeholder="用户名" autocomplete="username" autocapitalize="off">
  <input id="p" type="password" placeholder="密码" autocomplete="current-password">
  <button id="login-btn">登录</button>
  <div class="hint" id="login-msg"></div>
</div>

<div id="app" hidden>
  <header>
    <h1>阿里云 CDT 监控</h1>
    <div class="toolbar">
      <button id="refresh">刷新</button>
      <button id="logout">退出</button>
    </div>
  </header>
  <div class="sub" id="clock">—</div>

  <div id="cards"></div>

  <div class="card">
    <div class="meta" id="meta">—</div>
  </div>

  <div class="card">
    <div class="actions">
      <button data-mode="monitor">立即巡检</button>
      <button data-mode="report">发日报</button>
      <button data-mode="selftest">链路自检</button>
      <button data-mode="ecs">权限探测</button>
      <button data-mode="config">配置校验</button>
    </div>
    <pre id="out" hidden></pre>
  </div>
</div>

<script>
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = { summary: null };

  // 任何未捕获的脚本错误都摊到结果区，省得「点了没反应」查不出原因
  window.addEventListener('error', function (event) {
    var out = $('out');
    if (!out) return;
    out.hidden = false;
    out.className = 'err';
    out.textContent = '页面脚本出错: ' + ((event && event.message) || '未知错误');
  });

  function api(path, options) {
    options = options || {};
    options.credentials = 'same-origin';
    options.headers = options.headers || {};
    if (options.method && options.method !== 'GET') {
      options.headers['X-Requested-With'] = 'dashboard';
    }
    if (options.body) options.headers['Content-Type'] = 'application/json';
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        return { status: response.status, body: body };
      });
    });
  }

  function fmtMoney(amount, currency) {
    if (amount === null || amount === undefined) return 'Fail';
    var symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '\\u00a5' : '';
    if (!symbol) return amount.toFixed(2) + (currency ? ' ' + currency : '');
    return symbol + amount.toFixed(2);
  }

  function fmtSpec(cpu, mib) {
    if (!cpu || !mib) return '';
    var gb = mib / 1024;
    var text = gb % 1 === 0 ? String(gb) : gb.toFixed(1);
    return cpu + 'C' + text + 'G';
  }

  function statusIcon(status) {
    if (!status) return '\\u26aa';
    if (status === 'Running') return '\\ud83d\\udfe2';
    if (status === 'Stopped') return '\\ud83d\\udd34';
    return '\\ud83d\\udfe1';
  }

  function barColor(percent) {
    if (percent === null || percent === undefined) return 'var(--dim)';
    if (percent >= 100) return 'var(--red)';
    if (percent >= 90) return 'var(--orange)';
    return 'var(--green)';
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function renderStatus(payload) {
    var cards = $('cards');
    cards.textContent = '';
    if (!payload.instances || !payload.instances.length) {
      var empty = el('div', 'card', '配置里没有实例');
      empty.style.color = 'var(--dim)';
      cards.appendChild(empty);
      return;
    }

    payload.instances.forEach(function (item) {
      var card = el('div', 'card');

      var head = el('div', 'row');
      var left = el('div');
      var nameNode = el('span', 'name', item.name);
      left.appendChild(nameNode);
      var spec = fmtSpec(item.cpu, item.memory_mib);
      if (spec) left.appendChild(el('span', 'spec', spec));
      head.appendChild(left);
      head.appendChild(el('span', 'status', statusIcon(item.status) + ' ' + (item.status || 'Unknown')));
      card.appendChild(head);

      if (item.ip) card.appendChild(el('div', 'ip', item.ip));

      if (item.traffic && item.traffic.gb !== null) {
        var wrap = el('div', 'bar-wrap');
        var bar = el('div', 'bar');
        var fill = el('i');
        var percent = item.traffic.percent;
        fill.style.width = Math.min(100, percent === null ? 0 : percent) + '%';
        fill.style.background = barColor(percent);
        bar.appendChild(fill);
        wrap.appendChild(bar);

        var nums = el('div', 'bar-num');
        nums.appendChild(el('span', null, item.traffic.gb.toFixed(2) + ' / ' + item.traffic.limit + ' GB'));
        nums.appendChild(el('span', null, percent === null ? '—' : percent.toFixed(1) + '%'));
        wrap.appendChild(nums);
        card.appendChild(wrap);
      }

      var money = el('div', 'money');
      [
        ['实例账单', item.bill.instance],
        ['账户总账', item.bill.account],
        ['余额', item.balance]
      ].forEach(function (pair) {
        var box = el('div');
        box.appendChild(el('span', null, pair[0] + ' '));
        box.appendChild(el('b', null, fmtMoney(pair[1].amount, pair[1].currency)));
        money.appendChild(box);
      });
      card.appendChild(money);

      card.appendChild(el('div', 'verdict', item.verdict));

      if (item.notes && item.notes.length) {
        var notes = el('div', 'notes');
        item.notes.forEach(function (note) { notes.appendChild(el('div', null, note)); });
        card.appendChild(notes);
      }
      cards.appendChild(card);
    });

    $('meta').textContent = '';
    $('meta').appendChild(el('span', null, '子请求 ' + payload.subrequests + '/' + payload.budget));
    $('meta').appendChild(el('span', null, '采集于 ' + payload.fetched_at_text));
  }

  function renderSummary(summary) {
    var parts = ['现在 ' + summary.now_text];
    if (summary.next.monitor) parts.push('下次巡检 ' + summary.next.monitor);
    if (summary.next.start) parts.push('下次开机 ' + summary.next.start);
    if (summary.next.report) parts.push('下次日报 ' + summary.next.report);
    else parts.push('自动日报已关闭');
    $('clock').textContent = parts.join(' · ');
  }

  function showLogin(message) {
    $('app').hidden = true;
    $('login').hidden = false;
    $('login-msg').textContent = message || '';
    $('login-msg').className = 'hint' + (message ? ' err' : '');
  }

  function showApp() {
    $('login').hidden = true;
    $('app').hidden = false;
  }

  function loadAll() {
    return api('/api/summary').then(function (result) {
      if (result.status === 401) { showLogin(''); return; }
      showApp();
      if (result.status !== 200) { showLogin('配置读取失败'); return; }
      state.summary = result.body;
      renderSummary(result.body);
      return api('/api/status', { method: 'POST' }).then(function (status) {
        if (status.status === 200) renderStatus(status.body);
        else if (status.status === 401) showLogin('');
        else $('meta').textContent = '采集失败: ' + (status.body.error || status.status);
      });
    });
  }

  // 发日报会真的往 Telegram 推一条消息，需要二次确认。
  // 刻意不用 window.confirm：浏览器把模态框拦掉时它直接返回 false，
  // 表现就是「点了没反应」，连提示都不给。改成页内两次点击，可控可撤销。
  var pending = { mode: null, button: null, label: '', timer: null };

  function clearPending() {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.button) {
      pending.button.textContent = pending.label;
      pending.button.classList.remove('primary');
    }
    pending = { mode: null, button: null, label: '', timer: null };
  }

  function runMode(mode, button) {
    if (mode === 'report' && pending.mode !== 'report') {
      pending.mode = 'report';
      pending.button = button;
      pending.label = button.textContent;
      button.textContent = '再点一次确认';
      button.classList.add('primary');
      pending.timer = setTimeout(clearPending, 6000);
      return;
    }
    clearPending();

    var out = $('out');
    var buttons = document.querySelectorAll('[data-mode]');
    Array.prototype.forEach.call(buttons, function (node) { node.disabled = true; });
    out.hidden = false;
    out.className = '';
    out.textContent = '执行中…';
    if (out.scrollIntoView) out.scrollIntoView({ block: 'nearest' });
    api('/api/run?mode=' + encodeURIComponent(mode), { method: 'POST' })
      .then(function (result) {
        out.className = result.status === 200 ? 'ok' : 'err';
        out.textContent = JSON.stringify(result.body, null, 2);
      })
      .catch(function (error) {
        out.className = 'err';
        out.textContent = String(error);
      })
      .then(function () {
        Array.prototype.forEach.call(buttons, function (node) { node.disabled = false; });
        if (button) button.disabled = false;
      });
  }

  $('login-btn').addEventListener('click', function () {
    var user = $('u').value.trim();
    var pass = $('p').value;
    if (!user || !pass) { $('login-msg').textContent = '账号密码都要填'; return; }
    $('login-btn').disabled = true;
    api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ user: user, pass: pass })
    }).then(function (result) {
      $('login-btn').disabled = false;
      if (result.status === 200) {
        $('p').value = '';
        loadAll();
      } else {
        $('login-msg').textContent = result.body.error || '登录失败';
        $('login-msg').className = 'hint err';
      }
    });
  });

  $('p').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') $('login-btn').click();
  });

  $('logout').addEventListener('click', function () {
    api('/api/logout', { method: 'POST' }).then(function () { showLogin('已退出'); });
  });

  $('refresh').addEventListener('click', function () {
    $('refresh').disabled = true;
    loadAll().then(function () { $('refresh').disabled = false; });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-mode]'), function (node) {
    node.addEventListener('click', function () { runMode(node.getAttribute('data-mode'), node); });
  });

  loadAll();
})();
</script>
</body>
</html>`;
}
