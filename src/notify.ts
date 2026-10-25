/**
 * 通知：Telegram + Bark。
 *
 * 告警文案与 src/fc/index.py 保持一致（机器名 / 当前流量 / 动作三段式），
 * 这样两套实现发出来的消息长得一样，切换时不用重新适应。
 */

import { redact, sanitizeMd, splitMessage } from './util.ts';
import type { Logger } from './util.ts';
import type { TelegramConfig, BarkConfig } from './config.ts';

export const TG_LIMIT = 4000;

/** 通知冷却（毫秒） */
export const NOTIFY_COOLDOWN = 3600_000; // 通用事件：1 小时不重复
export const OVERLIMIT_COOLDOWN = 86400_000; // 流量超标：24 小时只提醒一次

export interface HttpResponse {
  status: number;
  text: string;
}

/** 发一个 HTTP 请求，HTTP 错误不抛异常（交给调用方读错误体） */
export async function httpRequest(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<HttpResponse> {
  const { timeoutMs = 15000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** 从 Telegram 的错误响应里取出人话 */
function tgError(text: string): string {
  try {
    const data = JSON.parse(text) as { error_code?: number; description?: string };
    return `${data.error_code ?? ''} ${data.description ?? text.slice(0, 200)}`;
  } catch {
    return text.slice(0, 200);
  }
}

export interface SendResult {
  ok: boolean;
  reason?: string;
}

/**
 * 发一条 Telegram 消息。
 *
 * 先试 Markdown；解析失败就退回纯文本，别把告警丢了。
 * 必须自己看状态码 —— httpRequest 把 HTTP 错误当返回值，
 * 否则 400/401/403 都会被当成「发送成功」，告警无声无息地没了。
 */
export async function sendTelegram(
  tg: TelegramConfig | undefined,
  title: string,
  message: string,
  options: { markdown?: boolean; log?: Logger } = {},
): Promise<SendResult> {
  const log = options.log ?? console;
  const token = (tg?.bot_token ?? '').trim();
  const chatId = (tg?.chat_id ?? '').trim();
  if (!token || !chatId) {
    log.warn('Telegram 未配置，跳过通知:', title);
    return { ok: false, reason: 'telegram 未配置' };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const header = title ? `*${sanitizeMd(title)}*\n` : '';
  const text = header + redact(message);

  const attempts = options.markdown === false ? [false] : [true, false];
  let lastReason = '';
  for (const useMarkdown of attempts) {
    const body = new URLSearchParams({ chat_id: chatId, text });
    if (useMarkdown) body.set('parse_mode', 'Markdown');
    let response: HttpResponse;
    try {
      response = await httpRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      log.warn('Telegram 网络不通:', redact(error));
      return { ok: false, reason: `网络不通: ${redact(error)}` };
    }
    if (response.status === 200) return { ok: true };
    lastReason = `HTTP ${response.status}: ${redact(tgError(response.text))}`;
    log.warn(`Telegram 拒绝(Markdown=${useMarkdown}) ${lastReason}`);
  }
  return { ok: false, reason: lastReason };
}

/** 日报分段发送（正文里没有 Markdown 标记，实例名带下划线也不会炸） */
export async function sendTelegramChunks(
  tg: TelegramConfig | undefined,
  message: string,
  log?: Logger,
): Promise<boolean> {
  let ok = true;
  for (const chunk of splitMessage(message, TG_LIMIT)) {
    const result = await sendTelegram(tg, '', chunk, { markdown: false, log });
    if (!result.ok) ok = false;
  }
  return ok;
}

export async function sendBark(
  bark: BarkConfig | undefined,
  message: string,
  log: Logger = console,
): Promise<boolean> {
  const url = (bark?.bark_url ?? '').trim();
  if (!url) return false;
  const target = url.replace(/\/+$/, '') + '/' + encodeURIComponent(String(message).slice(0, 1200));
  try {
    const response = await httpRequest(target, { method: 'GET' });
    if (response.status !== 200) {
      log.warn(`Bark 推送失败 HTTP ${response.status}: ${response.text.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (error) {
    log.warn('Bark 推送失败:', redact(error));
    return false;
  }
}

/**
 * 把「发不出去」拆成两种原因，一次问清楚。
 *
 *   getMe 就连不上        → 网络到不了 api.telegram.org，或 bot_token 错
 *   getMe 成功但发送失败  → chat_id 填错，或者你从没给这个 bot 发过 /start
 */
export async function telegramDiagnose(
  tg: TelegramConfig | undefined,
  log?: Logger,
): Promise<{ sent: boolean; bot?: string; reason?: string }> {
  const token = (tg?.bot_token ?? '').trim();
  const chatId = (tg?.chat_id ?? '').trim();
  if (!token || !chatId) return { sent: false, reason: 'bot_token 或 chat_id 未配置' };

  let response: HttpResponse;
  try {
    response = await httpRequest(`https://api.telegram.org/bot${token}/getMe`, { method: 'GET' });
  } catch (error) {
    return {
      sent: false,
      reason: `连不上 api.telegram.org —— 检查网络与 bot_token（${redact(error)}）`,
    };
  }
  if (response.status !== 200) {
    return { sent: false, reason: `bot_token 无效: HTTP ${response.status} ${redact(tgError(response.text))}` };
  }

  let bot = '';
  try {
    bot = (JSON.parse(response.text) as { result?: { username?: string } }).result?.username ?? '';
  } catch {
    /* 忽略解析失败，下面照样尝试发送 */
  }

  const sent = await sendTelegram(tg, '测试', '这是一条测试消息，收到即代表 Telegram 通道正常。', { log });
  if (sent.ok) return { sent: true, bot };
  return {
    sent: false,
    bot,
    reason:
      `bot @${bot} 的 token 有效，但消息发不出去 —— ` +
      '多半是 chat_id 填错，或者你从没在这个 bot 里发过 /start',
  };
}
