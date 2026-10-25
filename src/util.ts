/**
 * 通用工具 —— 与 src/monitor.py / src/fc/index.py 的语义逐条对齐。
 *
 * 这些函数是纯逻辑，不碰网络、不碰 KV，所以 test/util.test.ts 能直接用
 * Node 的 `node --test` 跑（Node 24 原生剥离 TypeScript 类型）。
 */

const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 把毫秒时间戳平移到北京时间（仍然用 UTC 的取值方法读，得到北京墙上时间） */
export function beijingNow(now: number = Date.now()): Date {
  return new Date(now + BJ_OFFSET_MS);
}

export function beijingDate(now: number = Date.now()): string {
  return beijingNow(now).toISOString().slice(0, 10);
}

export function beijingMonth(now: number = Date.now()): string {
  return beijingNow(now).toISOString().slice(0, 7);
}

/** 北京时间的 HH:MM，定时器按它比对 */
export function beijingHhMm(now: number = Date.now()): string {
  return beijingNow(now).toISOString().slice(11, 16);
}

/** 0 = 周日 … 6 = 周六（北京时间） */
export function beijingWeekday(now: number = Date.now()): number {
  return beijingNow(now).getUTCDay();
}

/**
 * 宽松数值转换，兼容 "1,234.56" 这类带千分位的字符串。
 * 阿里云账单接口返回的金额就是字符串，还带千分位。
 */
export function num(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'boolean') return value ? 1 : fallback;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

const SENSITIVE_RE = new RegExp(
  String.raw`(?<prefix>(?<![A-Za-z0-9_])['"]?` +
    String.raw`(?:accesskeyid|accesskeysecret|access_key_id|access_key_secret|` +
    String.raw`signature|signature_nonce|signaturenonce|signaturemethod|signature_method|` +
    String.raw`signatureversion|signature_version|securitytoken|security_token|` +
    String.raw`security-token|sessiontoken|session_token|ststoken|sts_token|` +
    String.raw`x-acs-security-token|authorization|credential|token)` +
    String.raw`['"]?\s*[=:]\s*['"]?)` +
    String.raw`(?<value>[^&\s,;"'<>()\[\]{}]+)`,
  'gi',
);

/**
 * 隐藏签名类参数值，保留主机名和错误原因。
 *
 * 不脱敏的话，异常文本里带着签名的请求 URL 会直接进 Worker 日志
 * （`wrangler tail` 谁都能看）。
 */
export function redact(text: unknown): string {
  return String(text ?? '').replace(
    SENSITIVE_RE,
    (_match, prefix: string) => prefix + '[REDACTED]',
  );
}

/** Telegram legacy Markdown：这四个字符会破坏解析 */
export function sanitizeMd(text: unknown): string {
  return String(text ?? '')
    .replace(/[_*`\[]/g, ' ')
    .trim();
}

/**
 * 阿里云 RPC 签名要求的 URL 编码。
 *
 * encodeURIComponent 不转义 ! ' ( ) * ，而阿里云要求除了
 * A-Za-z0-9-_.~ 之外全部转义，空格用 %20、* 用 %2A、~ 保持原样。
 */
export function percentEncode(value: unknown): string {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Uint8Array → base64（HMAC-SHA1 只有 20 字节，不用管分块） */
export function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64FromString(text: string): string {
  return base64FromBytes(new TextEncoder().encode(text));
}

/**
 * 按行切分，保证每段不超过 Telegram 的长度上限。
 *
 * 与 src/fc/index.py 的 split_message 有一处**故意的**差异：
 * Python 版遇到超长单行会 `line[:limit-1]` 直接截断，后面的内容永久丢失
 * ——日报里如果某行特别长（比如一次异常里带了很长的错误文本），
 * 被截掉的部分就再也看不到，而且没有任何提示。
 * 这里改成硬切成多段，内容一个字不丢。
 */
export function splitMessage(message: unknown, limit = 4000): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };

  for (const line of String(message ?? '').split('\n')) {
    // 超长单行：先按 limit 硬切，最后一片继续参与常规拼装
    const pieces: string[] = [];
    let rest = line;
    while (rest.length > limit) {
      pieces.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    pieces.push(rest);

    for (const piece of pieces) {
      if (current.length + piece.length + 1 > limit) flush();
      current = current ? current + '\n' + piece : piece;
    }
  }
  flush();
  return chunks.length ? chunks : [''];
}

// ---------- 瞬态网络错误判定 ----------

const TRANSIENT_NAMES = new Set([
  'TimeoutError',
  'AbortError',
  'TypeError', // fetch 在网络层失败时统一抛 TypeError: fetch failed
  'ConnectionError',
  'NetworkError',
]);

const TRANSIENT_MARKERS = [
  'timed out',
  'timeout',
  'connection reset',
  'connection aborted',
  'connection refused',
  'connection closed',
  'temporary failure',
  'remote end closed',
  'incomplete read',
  'eof occurred',
  'network is unreachable',
  'broken pipe',
  'tls handshake',
  'fetch failed',
  'socket hang up',
  'other side closed',
];

/**
 * 判断是不是网络抖动。
 *
 * Workers 里 fetch 失败只有 TypeError/AbortError 两种外壳，
 * 真正的原因在 message 和 cause 里，所以沿 cause 链往下看。
 */
export function isTransient(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const name = (current as { name?: string }).name ?? '';
    if (TRANSIENT_NAMES.has(name)) return true;
    const text = String((current as { message?: string }).message ?? current).toLowerCase();
    for (const marker of TRANSIENT_MARKERS) {
      if (text.includes(marker)) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 只对网络抖动重试；业务错误（签名错、权限不足）立即抛出 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label = '请求',
  attempts = 3,
  delayMs = 1000,
  log?: Logger,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === attempts) throw error;
      log?.warn(`${label} 第 ${attempt} 次失败（${redact(error)}），${delayMs}ms 后重试`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 极简 logger：Workers 里 console.* 直接进 wrangler tail / Logpush */
export function createLogger(tag = 'aliyun-monitor'): Logger {
  return {
    info: (...args) => console.log(`[${tag}]`, ...args),
    warn: (...args) => console.warn(`[${tag}]`, ...args),
    error: (...args) => console.error(`[${tag}]`, ...args),
  };
}
