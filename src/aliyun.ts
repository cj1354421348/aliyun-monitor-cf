/**
 * 阿里云 RPC API 客户端（V1 签名）。
 *
 * ================================================================
 * 为什么手写签名而不是用 SDK
 * ================================================================
 * 阿里云官方 Node SDK 依赖一堆 Node 专有 API（fs、net、crypto 的
 * createHmac 等），在 Workers 里要开 nodejs_compat 才能跑，而且体积
 * 十几 MB。而 RPC V1 签名本质上只有一个 HMAC-SHA1 ——
 * Web Crypto 的 crypto.subtle 就能做，零依赖。
 *
 *   StringToSign = "POST" & percentEncode("/") & percentEncode(规范化查询串)
 *   Signature    = base64(HMAC-SHA1(AccessKeySecret + "&", StringToSign))
 *   请求          = POST https://<domain>/  body 为查询串 + &Signature=...
 *
 * 这套实现与 src/fc/index.py:298-342 的 aliyun_call 逐行对应，
 * 签名结果用 test/aliyun.test.ts 里的已知向量对齐过。
 */

import { base64FromBytes, num, percentEncode, redact, withRetry } from './util.ts';
import type { Logger } from './util.ts';

export const ECS_VERSION = '2014-05-26';
export const CDT_VERSION = '2021-08-13';
export const BSS_VERSION = '2017-12-14';

/** CDT 固定 cn-hangzhou —— 某些地域的 CDT 接入点会卡死（沿用 monitor.py 的规避） */
export const ECS_DOMAIN = 'ecs.aliyuncs.com';
export const CDT_DOMAIN = 'cdt.aliyuncs.com';
export const CDT_REGION = 'cn-hangzhou';

/**
 * 账单/余额的站点。国内站和国际站是两套独立站点，
 * 域名填错会返回 NotApplicable（caller site does not match the API domain）。
 */
export const BSS_ENDPOINTS = [
  'business.aliyuncs.com',
  'business.ap-southeast-1.aliyuncs.com',
] as const;

export interface Credentials {
  ak: string;
  sk: string;
}

export type Params = Record<string, string | number | undefined | null>;

/** 用 Web Crypto 算 HMAC-SHA1 并 base64 */
async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return base64FromBytes(new Uint8Array(signature));
}

/** 生成一次调用的全部参数（含公共参数），按 key 排序拼成规范化查询串 */
export function buildCanonical(
  creds: Credentials,
  version: string,
  action: string,
  params: Params = {},
  nonce: string,
  timestamp: string,
): string {
  const merged: Record<string, string> = {
    Format: 'JSON',
    Version: version,
    AccessKeyId: creds.ak,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: nonce,
    Timestamp: timestamp,
    Action: action,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    merged[key] = String(value);
  }
  return Object.keys(merged)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(merged[key])}`)
    .join('&');
}

/** 由规范化查询串算出签名 */
export async function signQuery(
  creds: Credentials,
  canonical: string,
  method = 'POST',
): Promise<string> {
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonical)}`;
  return hmacSha1Base64(`${creds.sk}&`, stringToSign);
}

export class AliyunError extends Error {
  code: string;
  status: number;
  constructor(action: string, code: string, message: string, status: number) {
    super(`${action} 失败: ${code} ${message}`);
    this.name = 'AliyunError';
    this.code = code;
    this.status = status;
  }
}

export interface CallOptions {
  method?: 'POST' | 'GET';
  timeoutMs?: number;
  log?: Logger;
  attempts?: number;
}

/** 一次 RPC 调用。成功返回解析后的 JSON；失败抛 AliyunError。 */
export async function aliyunCall<T = Record<string, unknown>>(
  creds: Credentials,
  domain: string,
  version: string,
  action: string,
  params: Params = {},
  options: CallOptions = {},
): Promise<T> {
  const method = options.method ?? 'POST';
  const timeoutMs = options.timeoutMs ?? 15000;
  const nonce = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const canonical = buildCanonical(creds, version, action, params, nonce, timestamp);
  const signature = await signQuery(creds, canonical, method);
  const body = `${canonical}&Signature=${percentEncode(signature)}`;

  const doFetch = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (method === 'GET') {
        const response = await fetch(`https://${domain}/?${body}`, {
          method: 'GET',
          signal: controller.signal,
        });
        return { status: response.status, text: await response.text() };
      }
      const response = await fetch(`https://${domain}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      return { status: response.status, text: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  };

  const { status, text } = await withRetry(
    doFetch,
    `${action} 请求`,
    options.attempts ?? 3,
    1000,
    options.log,
  );

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${action} 响应不是 JSON（HTTP ${status}）: ${redact(text.slice(0, 300))}`);
  }
  if (status !== 200) {
    throw new AliyunError(
      action,
      String(data.Code ?? status),
      redact(String(data.Message ?? text.slice(0, 300))),
      status,
    );
  }
  return data as T;
}

/**
 * 账单域名：配置里填的优先，另一个兜底。
 * 顺序不能反 —— 国际站账号打国内站域名每次都会白打一个 400 NotApplicable。
 */
export function bssEndpoints(user: { bill_endpoint?: string }): string[] {
  const primary = (user.bill_endpoint || BSS_ENDPOINTS[1]).trim();
  return [primary, ...BSS_ENDPOINTS.filter((item) => item !== primary)];
}

/** BSS 调用失败只记日志返回 null，不打断整份日报 */
export async function bssCall<T = Record<string, unknown>>(
  creds: Credentials,
  endpoint: string,
  action: string,
  params: Params = {},
  log?: Logger,
): Promise<T | null> {
  try {
    return await aliyunCall<T>(creds, endpoint, BSS_VERSION, action, params, { log });
  } catch (error) {
    log?.warn(`${action} 失败(${endpoint}): ${redact(error)}`);
    return null;
  }
}

// ============================================================
// 业务查询
// ============================================================

export interface TrafficResult {
  gb: number;
  detailCount: number;
}

/**
 * 当月 CDT 公网流量（GB）。
 *
 * 刻意不带业务参数，与 monitor.py 保持一致（它可以正常工作）。
 * 若某天发现明细条数长期顶在一个固定值（分页上限），需要补
 * PageSize / PageNumber 并累加所有页，否则会少算流量、漏掉止损。
 */
export async function fetchTrafficGb(
  creds: Credentials,
  options: { log?: Logger } = {},
): Promise<TrafficResult> {
  const data = await aliyunCall<{ TrafficDetails?: Array<{ Traffic?: unknown }> }>(
    creds,
    CDT_DOMAIN,
    CDT_VERSION,
    'ListCdtInternetTraffic',
    { RegionId: CDT_REGION },
    { log: options.log },
  );
  const details = data.TrafficDetails ?? [];
  const totalBytes = details.reduce((sum, item) => sum + num(item.Traffic), 0);
  return { gb: totalBytes / 1024 ** 3, detailCount: details.length };
}

export interface InstanceInfo {
  Status?: string;
  InstanceType?: string;
  Cpu?: number;
  Memory?: number;
  PublicIpAddress?: { IpAddress?: string[] };
  InnerIpAddress?: { IpAddress?: string[] };
  [key: string]: unknown;
}

function ecsParams(user: { region: string; resgroup?: string }): Params {
  const params: Params = { RegionId: user.region };
  const resgroup = (user.resgroup || '').trim();
  if (resgroup) params.ResourceGroupId = resgroup;
  return params;
}

/** 返回实例详情；找不到实例返回 null */
export async function describeInstance(
  creds: Credentials,
  user: { region: string; resgroup?: string; instance_id: string },
  options: { log?: Logger } = {},
): Promise<InstanceInfo | null> {
  const params = ecsParams(user);
  params.InstanceIds = JSON.stringify([user.instance_id]);
  const data = await aliyunCall<{ Instances?: { Instance?: InstanceInfo[] } }>(
    creds,
    ECS_DOMAIN,
    ECS_VERSION,
    'DescribeInstances',
    params,
    { log: options.log },
  );
  const instances = data.Instances?.Instance ?? [];
  return instances.length ? instances[0] ?? null : null;
}

export async function fetchInstanceStatus(
  creds: Credentials,
  user: { region: string; resgroup?: string; instance_id: string },
  options: { log?: Logger } = {},
): Promise<string | null> {
  const instance = await describeInstance(creds, user, options);
  return instance?.Status ?? null;
}

export const ECS_ACTIONS = ['StartInstance', 'StopInstance'] as const;
export type EcsAction = (typeof ECS_ACTIONS)[number];

/**
 * 止损关机用优雅关机（等操作系统正常挂载盘后下电，不会丢未落盘数据）。
 * 缺点：负载高时可能关得慢甚至卡住。改成 true 就变成强制关机（ForceStop），
 * 约等于拔电源，少了等待但也可能丢数据。
 */
export const FORCE_STOP = false;

export async function ecsAction(
  creds: Credentials,
  user: { region: string; resgroup?: string; instance_id: string },
  action: EcsAction,
  forceStop = false,
  options: { log?: Logger } = {},
): Promise<void> {
  const params = ecsParams(user);
  params.InstanceId = user.instance_id;
  if (action === 'StopInstance' && forceStop) params.ForceStop = 'true';
  await aliyunCall(creds, ECS_DOMAIN, ECS_VERSION, action, params, { log: options.log });
}

export interface BalanceResult {
  amount: number | null;
  currency: string;
}

export async function queryBalance(
  creds: Credentials,
  user: { bill_endpoint?: string },
  options: { log?: Logger } = {},
): Promise<BalanceResult> {
  for (const endpoint of bssEndpoints(user)) {
    const data = await bssCall<{
      Success?: boolean;
      Data?: { AvailableAmount?: unknown; Currency?: string };
    }>(creds, endpoint, 'QueryAccountBalance', {}, options.log);
    if (!data?.Success) continue;
    const info = data.Data ?? {};
    if (info.AvailableAmount === null || info.AvailableAmount === undefined) continue;
    return { amount: num(info.AvailableAmount), currency: info.Currency ?? '' };
  }
  return { amount: null, currency: '' };
}

/** 余额行，只在国内站账号能查到 */
export async function balanceLine(
  creds: Credentials,
  user: { bill_endpoint?: string },
  options: { log?: Logger } = {},
): Promise<string> {
  const { amount, currency } = await queryBalance(creds, user, options);
  if (amount === null) return '';
  return `\n账户余额: ${amount.toFixed(2)} ${currency}`;
}

export interface BillResult {
  amount: number | null;
  currency: string;
  scope: string | null;
}

interface BillItem {
  PretaxAmount?: unknown;
  Currency?: string;
}

/**
 * 本月账单。先按实例查，查不到再退到账号总览。
 *
 * QueryBillOverview 是账号级的，不是实例级，数字会明显偏大，
 * 所以口径（scope）要标注出来，不能让看的人以为数字对不上是 bug。
 */
export async function fetchBill(
  creds: Credentials,
  user: { bill_endpoint?: string },
  instanceId: string,
  billingCycle: string,
  options: { log?: Logger } = {},
): Promise<BillResult> {
  for (const endpoint of bssEndpoints(user)) {
    const data = await bssCall<{ Success?: boolean; Data?: { Items?: BillItem[] } }>(
      creds,
      endpoint,
      'DescribeInstanceBill',
      { BillingCycle: billingCycle, InstanceID: instanceId },
      options.log,
    );
    if (!data?.Success) continue;
    const items = data.Data?.Items ?? [];
    const first = items[0];
    if (!first) continue;
    const amount = items.reduce((sum, item) => sum + num(item.PretaxAmount), 0);
    return { amount, currency: first.Currency ?? '', scope: '实例账单' };
  }

  for (const endpoint of bssEndpoints(user)) {
    const data = await bssCall<{ Success?: boolean; Data?: { Items?: BillItem[] } }>(
      creds,
      endpoint,
      'QueryBillOverview',
      { BillingCycle: billingCycle },
      options.log,
    );
    if (!data?.Success) continue;
    const items = data.Data?.Items ?? [];
    const first = items[0];
    if (!first) continue;
    return {
      amount: num(first.PretaxAmount),
      currency: first.Currency ?? '',
      scope: '账号总览',
    };
  }
  return { amount: null, currency: '', scope: null };
}

/**
 * 探测这个账号该用哪个账单站点、哪个接口能用。
 * 这就是 400 NotApplicable 的照妖镜。
 */
export async function probeBill(
  creds: Credentials,
  billingCycle: string,
  options: { log?: Logger } = {},
): Promise<string> {
  const working: string[] = [];
  const errors: string[] = [];
  for (const endpoint of BSS_ENDPOINTS) {
    for (const action of ['DescribeInstanceBill', 'QueryAccountBalance'] as const) {
      try {
        const data = await aliyunCall<{ Success?: boolean }>(
          creds,
          endpoint,
          BSS_VERSION,
          action,
          action === 'DescribeInstanceBill' ? { BillingCycle: billingCycle } : {},
          { log: options.log, attempts: 1 },
        );
        if (data.Success) working.push(`${endpoint} + ${action}`);
      } catch (error) {
        errors.push(`${endpoint}+${action}: ${redact(error)}`);
      }
    }
  }
  if (working.length) return '可用: ' + working.join('；');
  return '全部不可用 —— ' + errors.join(' | ');
}
