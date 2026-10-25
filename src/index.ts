/**
 * Cloudflare Workers 入口。
 *
 * 三个入口面：
 *   1. `scheduled()`   cron 触发器 → 按北京时间分发 monitor / start / report
 *   2. `fetch()`       HTTP 手动触发（带 Bearer 鉴权）+ Telegram webhook
 *   3. 无入口         —— 没有 CLI，本地调试走 `npm run dev`
 *
 * ================================================================
 * 配置放哪
 * ================================================================
 * FC 版把整份配置塞进环境变量 MONITOR_CONFIG_JSON，这在 Workers 上不行：
 * 单个环境变量上限 5KB，多账号配置轻松就超。所以：
 *
 *   主配置  → KV key `config`（JSON 字符串）
 *   密钥    → Worker Secret（MONITOR_SECRET / CONFIG_JSON 兜底）
 *
 * 这样改配置不用重新 deploy，`wrangler kv key put` 一条命令搞定。
 */

import type { AppConfig } from './config.ts';
import { validateConfig } from './config.ts';
import { Budget, runMonitor, runStart, type TickContext } from './monitor.ts';
import { runReport, runSelftest, probeEcsPermission } from './report.ts';
import { CRON, planFor, validateSchedule } from './scheduler.ts';
import { sendTelegram } from './notify.ts';
import { MemoryBackend, State, STATE_KEY, type StateBackend } from './state.ts';
import { createLogger, redact, sanitizeMd, type Logger } from './util.ts';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  buildSummary,
  clearCookie,
  collectStatus,
  dashboardHtml,
  readCookie,
  sessionCookie,
  signSession,
  timingSafeEqual,
  verifySession,
} from './dashboard.ts';

export interface Env {
  /**
   * KV 命名空间绑定，名字必须叫 MONITOR_KV。
   *
   * 类型上标成可选，是因为它可能真的不在 —— 比如在 Dashboard 上还没绑、
   * 或者绑错了名字。那种情况下 loadConfig 回落 CONFIG_JSON、状态退回内存，
   * Worker 不会崩，只是冷却机制失效（见 makeContext 里的注释）。
   */
  MONITOR_KV?: KVNamespace;
  /** HTTP 触发的 Bearer token；不设则 HTTP 触发一律拒绝 */
  MONITOR_SECRET?: string;
  /** 配置 JSON 兜底（不推荐，超过 5KB 会截断） */
  CONFIG_JSON?: string;
  /** 状态 key 覆盖，默认 state/monitor_state.json */
  STATE_KEY?: string;
  /** 子请求预算覆盖，免费版别超过 45 */
  SUBREQUEST_BUDGET?: string;
  /** 网页看板的登录用户名；不设则看板整体不可用（/health 与 /run 不受影响） */
  DASHBOARD_USER?: string;
  /** 网页看板的登录密码，同时充当 Cookie 的签名密钥 */
  DASHBOARD_PASS?: string;
}

const CONFIG_KEY = 'config';

/** KV 后端适配器：把 KVNamespace 收成 State 需要的两个方法 */
class KvBackend implements StateBackend {
  constructor(private kv: KVNamespace) {}
  async get(key: string): Promise<string | null> {
    return this.kv.get(key, 'text');
  }
  async put(key: string, value: string): Promise<void> {
    await this.kv.put(key, value);
  }
}

/**
 * 没有 KV binding 时的降级后端。
 *
 * 内存后端每次调用都是空的，State.save() 会以为状态读失败（readable=false）
 * 从而拒绝写入 —— 结果就是冷却时间戳存不下来，同一条告警每 5 分钟重复一次。
 * 巡检 / 止损 / 日报本身照常工作，因为那些不需要跨调用状态。
 * 这是个降级路径，不是正常路径：日志里会明确警告。
 */
function backendFor(env: Env, log: Logger): StateBackend {
  if (env.MONITOR_KV) return new KvBackend(env.MONITOR_KV);
  log.warn(
    '没有 MONITOR_KV 绑定 —— 状态改用内存后端，冷却机制会失效（告警会重复推送）。' +
      '去 Dashboard → Settings → Variables and Secrets 加一个 KV Namespace Binding，变量名必须叫 MONITOR_KV',
  );
  return new MemoryBackend();
}

export async function loadConfig(env: Env): Promise<AppConfig> {
  const fromKv = env.MONITOR_KV ? await env.MONITOR_KV.get(CONFIG_KEY, 'text') : null;
  const raw = fromKv ?? env.CONFIG_JSON ?? '';
  if (!raw.trim()) {
    throw new Error(
      env.MONITOR_KV
        ? `KV 里没有 \`${CONFIG_KEY}\`，也没设 CONFIG_JSON —— ` +
            '先在 Dashboard 的 KV Pairs 里写入配置，或用 wrangler kv key put'
        : `没有 MONITOR_KV 绑定，也没设 CONFIG_JSON —— ` +
            '去 Dashboard → Settings → Variables and Secrets 加一个 KV Namespace Binding，' +
            '变量名必须叫 MONITOR_KV',
    );
  }
  try {
    return JSON.parse(raw) as AppConfig;
  } catch (error) {
    throw new Error(`配置不是合法 JSON: ${redact(error)}`);
  }
}

interface RunOptions {
  env: Env;
  log: Logger;
  budgetLimit?: number;
  backend?: StateBackend;
  now?: () => number;
}

/** 组装一次 tick 的上下文（配置 + 状态 + 预算） */
async function makeContext(options: RunOptions): Promise<{
  ctx: TickContext;
  state: State;
}> {
  const config = await loadConfig(options.env);
  const backend = options.backend ?? backendFor(options.env, options.log);
  const state = new State(
    backend,
    options.env.STATE_KEY?.trim() || STATE_KEY,
    options.log,
  );
  await state.load();

  const parsedBudget = Number(options.env.SUBREQUEST_BUDGET);
  const budgetLimit =
    options.budgetLimit ??
    (Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : 40);
  const ctx: TickContext = {
    config,
    state: state.data,
    log: options.log,
    budget: new Budget(budgetLimit),
    now: options.now ?? (() => Date.now()),
  };
  return { ctx, state };
}

/** cron 入口 */
export async function handleScheduled(
  event: ScheduledController,
  env: Env,
  options: { backend?: StateBackend; now?: number } = {},
): Promise<Record<string, unknown>> {
  const log = createLogger('cron');
  const now = options.now ?? Date.now();
  const { ctx, state } = await makeContext({ env, log, backend: options.backend, now: () => now });
  const schedule = ctx.config.schedule;
  const plan = planFor(now, schedule);
  log.info(`cron 触发 ${event.cron} → ${plan.reason}`);

  const outcome: Record<string, unknown> = { plan: plan.reason };

  try {
    outcome.monitor = await runMonitor(ctx);
  } catch (error) {
    log.error('monitor 阶段异常:', redact(error));
    outcome.monitor_error = redact(error);
  }

  if (plan.start) {
    try {
      outcome.start = await runStart(ctx);
    } catch (error) {
      log.error('start 阶段异常:', redact(error));
      outcome.start_error = redact(error);
    }
  }

  if (plan.report) {
    try {
      outcome.report = await runReport(ctx);
    } catch (error) {
      log.error('report 阶段异常:', redact(error));
      outcome.report_error = redact(error);
    }
  }

  const saved = await state.save();
  outcome.state_saved = saved;
  outcome.subrequests = ctx.budget.used;
  return outcome;
}

/** 手动模式：由 HTTP 触发 */
export async function handleMode(
  mode: string,
  env: Env,
  options: { backend?: StateBackend; now?: number } = {},
): Promise<Record<string, unknown>> {
  const log = createLogger(`manual:${mode}`);
  const { ctx, state } = await makeContext({ env, log, backend: options.backend, now: options.now ? () => options.now! : undefined });

  let outcome: Record<string, unknown>;
  switch (mode) {
    case 'monitor':
      outcome = { ...(await runMonitor(ctx)) };
      break;
    case 'start':
      outcome = { ...(await runStart(ctx)) };
      break;
    case 'report':
      outcome = { ...(await runReport(ctx)) };
      break;
    case 'selftest':
      outcome = { ...(await runSelftest(ctx)) };
      break;
    case 'ecs':
      outcome = { ...(await probeEcsPermission(ctx)) };
      break;
    case 'config':
      outcome = {
        issues: validateConfig(ctx.config),
        schedule_issues: validateSchedule(ctx.config.schedule ?? {}, CRON),
        schedule: planFor(ctx.now(), ctx.config.schedule),
      };
      break;
    default:
      throw new Error(`未知模式 ${mode}，可用: monitor / start / report / selftest / ecs / config`);
  }

  // selftest / ecs / config 不改状态，写回也是空操作（State.save 会自己判断）
  if (mode === 'monitor' || mode === 'start' || mode === 'report') {
    outcome.state_saved = await state.save();
  }
  outcome.subrequests = ctx.budget.used;
  return outcome;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

function authorized(request: Request, env: Env): boolean {
  const secret = (env.MONITOR_SECRET ?? '').trim();
  if (!secret) return false;
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  // 定长比较，避免用长度泄漏 secret
  if (token.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i += 1) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

// ---------- 看板：鉴权与响应包装 ----------

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  // 页面里没有外部资源，也没用 eval，直接全禁
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...HTML_HEADERS, ...extra } });
}

/** 看板的账号密码，两个都要有才算配置好 */
function dashCreds(env: Env): { user: string; pass: string } {
  return {
    user: (env.DASHBOARD_USER ?? '').trim(),
    pass: (env.DASHBOARD_PASS ?? '').trim(),
  };
}

/**
 * /api/* 的鉴权：签名 Cookie 或 Bearer MONITOR_SECRET 都行。
 *
 * 接受 Bearer 是为了让脚本也能调这些接口 —— 比如定时用 curl 拉一份
 * /api/status 存起来，不必去模拟登录拿 Cookie。
 */
async function dashboardAuthorized(request: Request, env: Env): Promise<boolean> {
  const { pass } = dashCreds(env);
  if (pass) {
    const value = readCookie(request.headers.get('Cookie'), SESSION_COOKIE);
    if (value && (await verifySession(pass, value, Date.now()))) return true;
  }
  return authorized(request, env);
}

/** 写操作要求带自定义头，跨站表单发不出这个头，配合 SameSite 挡 CSRF */
function csrfOk(request: Request): boolean {
  return (request.headers.get('X-Requested-With') ?? '').toLowerCase() === 'dashboard';
}

async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

const PUBLIC_MODES = ['monitor', 'report', 'selftest', 'ecs', 'config'] as const;
type PublicMode = (typeof PUBLIC_MODES)[number];

function isPublicMode(value: string): value is PublicMode {
  return (PUBLIC_MODES as readonly string[]).includes(value);
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const outcome = await handleScheduled(event, env);
    console.log('cron 完成:', JSON.stringify(outcome));
    ctx.waitUntil(Promise.resolve());
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const log = createLogger('http');
    const path = url.pathname;

    // 健康检查（纯文本，给脚本和 uptime 探针用，不需要鉴权）
    if (path === '/health' && request.method === 'GET') {
      return new Response(
        'aliyun-monitor on Cloudflare Workers\n\n' +
          'POST /run?mode=monitor|start|report|selftest|ecs|config\n' +
          '需要 Authorization: Bearer <MONITOR_SECRET>\n' +
          '网页看板: /\n',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      );
    }

    // 网页看板
    if (path === '/' && request.method === 'GET') {
      const { user, pass } = dashCreds(env);
      if (!user || !pass) {
        return html(
          '<!doctype html><meta charset="utf-8"><title>看板未配置</title>' +
            '<body style="font:15px/1.7 system-ui;padding:32px;max-width:560px;margin:0 auto">' +
            '<h1 style="font-size:18px">看板还没配置账号</h1>' +
            '<p>去 Cloudflare Dashboard → 这个 Worker → Settings → Variables and Secrets，' +
            '加两个 <b>Secret</b>：</p>' +
            '<pre style="background:#f4f4f5;padding:12px;border-radius:8px">DASHBOARD_USER = 你的用户名\n' +
            'DASHBOARD_PASS = 你的密码</pre>' +
            '<p>加完立刻生效，不用重新部署。<br>' +
            '不想用看板也没关系：cron 巡检、止损、日报、Telegram 告警都不受影响，' +
            '<code>/health</code> 和 <code>/run</code> 照常工作。</p>',
          503,
        );
      }
      return html(dashboardHtml());
    }

    if (path === '/api/login') {
      if (request.method !== 'POST') return json({ error: '只接受 POST' }, 405);
      const { user, pass } = dashCreds(env);
      if (!user || !pass) return json({ error: '看板未配置 DASHBOARD_USER / DASHBOARD_PASS' }, 503);
      const body = await readJsonBody<{ user?: string; pass?: string }>(request);
      const givenUser = (body?.user ?? '').trim();
      const givenPass = body?.pass ?? '';
      // 两项都比较，且都用定长比较 —— 避免用耗时区分「用户名错」和「密码错」
      const userOk = timingSafeEqual(givenUser, user);
      const passOk = timingSafeEqual(givenPass, pass);
      if (!userOk || !passOk) {
        log.warn('看板登录失败');
        return json({ error: '用户名或密码不对' }, 401);
      }
      const expiresAt = Date.now() + SESSION_TTL_MS;
      const value = await signSession(pass, expiresAt);
      log.info('看板登录成功');
      return new Response(
        JSON.stringify({ ok: true, expires_at: expiresAt }, null, 2),
        {
          status: 200,
          headers: {
            ...JSON_HEADERS,
            'Set-Cookie': sessionCookie(value, SESSION_TTL_MS / 1000),
            'Cache-Control': 'no-store',
          },
        },
      );
    }

    if (path === '/api/logout') {
      if (request.method !== 'POST') return json({ error: '只接受 POST' }, 405);
      return new Response(JSON.stringify({ ok: true }, null, 2), {
        status: 200,
        headers: { ...JSON_HEADERS, 'Set-Cookie': clearCookie() },
      });
    }

    if (path === '/api/summary') {
      if (request.method !== 'GET') return json({ error: '只接受 GET' }, 405);
      if (!(await dashboardAuthorized(request, env))) return json({ error: '未登录' }, 401);
      try {
        const { ctx } = await makeContext({ env, log });
        return json(buildSummary(ctx.config, ctx.state, ctx.now()));
      } catch (error) {
        log.error('摘要读取失败:', redact(error));
        return json({ error: redact(error) }, 500);
      }
    }

    if (path === '/api/status') {
      if (request.method !== 'POST') return json({ error: '只接受 POST' }, 405);
      if (!(await dashboardAuthorized(request, env))) return json({ error: '未登录' }, 401);
      if (!csrfOk(request)) return json({ error: '缺少 X-Requested-With' }, 403);
      try {
        const { ctx } = await makeContext({ env, log });
        return json(await collectStatus(ctx));
      } catch (error) {
        log.error('状态采集失败:', redact(error));
        return json({ error: redact(error) }, 500);
      }
    }

    if (path === '/api/run') {
      if (request.method !== 'POST') return json({ error: '只接受 POST' }, 405);
      if (!(await dashboardAuthorized(request, env))) return json({ error: '未登录' }, 401);
      if (!csrfOk(request)) return json({ error: '缺少 X-Requested-With' }, 403);
      const mode = (url.searchParams.get('mode') ?? '').trim();
      // 看板刻意不开放 mode=start：开机是唯一会改变计费状态的操作，
      // 保留给 curl + Bearer，逼人多想一秒。
      if (!isPublicMode(mode)) {
        return json({ error: `看板不支持 mode=${mode || '(空)'}` }, 400);
      }
      try {
        return json(await handleMode(mode, env));
      } catch (error) {
        log.error(`看板 ${mode} 失败:`, redact(error));
        return json({ error: redact(error) }, 500);
      }
    }

    if (path === '/run') {
      if (request.method !== 'POST') return json({ error: '只接受 POST' }, 405);
      if (!authorized(request, env)) return json({ error: '鉴权失败' }, 401);
      const mode = (url.searchParams.get('mode') ?? 'monitor').trim();
      try {
        const outcome = await handleMode(mode, env);
        return json(outcome);
      } catch (error) {
        log.error(`手动 ${mode} 失败:`, redact(error));
        return json({ error: redact(error) }, 500);
      }
    }

    // Telegram webhook：路径里带 token 前缀当共享密钥
    if (path.startsWith('/tg/')) {
      const secret = (env.MONITOR_SECRET ?? '').trim();
      if (!secret || path !== `/tg/${secret}`) return json({ error: 'not found' }, 404);
      if (request.method !== 'POST') return json({ error: '只接受 POST' }, 405);
      try {
        return json(await handleTelegramUpdate(request, env, log));
      } catch (error) {
        log.error('webhook 处理失败:', redact(error));
        return json({ ok: false, error: redact(error) }, 500);
      }
    }

    return json({ error: 'not found' }, 404);
  },
};

/**
 * Telegram webhook：只支持几个只读命令。
 *
 * 刻意不做开关机按钮 —— 那需要 ConversationHandler 那样的多步状态机，
 * 放 Workers 上要么上 Durable Objects（付费），要么自己造状态；
 * 而开关机这种高危操作，一次 HTTP + confirm 参数反而更安全。
 */
async function handleTelegramUpdate(
  request: Request,
  env: Env,
  log: Logger,
): Promise<Record<string, unknown>> {
  const update = (await request.json()) as {
    message?: { text?: string; chat?: { id?: number }; from?: { id?: number } };
  };
  const text = (update.message?.text ?? '').trim();
  const chatId = update.message?.chat?.id;
  const fromId = update.message?.from?.id;
  if (!text || !chatId) return { ok: true, ignored: true };

  const config = await loadConfig(env);
  const admins = config.telegram?.admin_user_ids ?? [];
  const isAdmin = fromId !== undefined && admins.includes(fromId);
  const command = (text.split(/\s+/)[0] ?? '').replace(/@.*$/, '').toLowerCase();

  const reply = async (body: string) => {
    await sendTelegram(config.telegram, '', body, { markdown: false, log });
  };

  if (command === '/help' || command === '/start') {
    await reply(
      'aliyun-monitor (Cloudflare Workers)\n\n' +
        '/status  — 各实例流量与状态\n' +
        '/list    — 列出配置里的实例\n' +
        '/report  — 立即生成并发送日报\n' +
        '/selftest — 全链路自检\n' +
        '/help    — 本帮助',
    );
    return { ok: true, command };
  }

  if (!isAdmin) {
    await reply(`未授权：你的 Telegram user id 是 ${fromId ?? '未知'}，请把它加进 telegram.admin_user_ids`);
    return { ok: true, command, unauthorized: true };
  }

  if (command === '/list') {
    const users = config.users ?? [];
    const body = users.length
      ? users
          .map((user, index) => `${index + 1}. ${sanitizeMd(user.name || user.instance_id)} (${user.region})`)
          .join('\n')
      : '配置里没有实例';
    await reply(`实例列表:\n${body}`);
    return { ok: true, command };
  }

  if (command === '/status') {
    const outcome = await handleMode('monitor', env);
    await reply(`巡检已执行:\n${JSON.stringify(outcome, null, 2)}`);
    return { ok: true, command, outcome };
  }

  if (command === '/report') {
    const outcome = await handleMode('report', env);
    return { ok: true, command, outcome };
  }

  if (command === '/selftest') {
    const outcome = await handleMode('selftest', env);
    await reply(`自检结果:\n${JSON.stringify(outcome, null, 2).slice(0, 3800)}`);
    return { ok: true, command, outcome };
  }

  await reply(`未知命令 ${command}，发 /help 看可用命令`);
  return { ok: true, command, unknown: true };
}

export { MemoryBackend, planFor, validateSchedule, validateConfig };
