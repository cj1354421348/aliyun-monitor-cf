/**
 * 配置结构与校验。
 *
 * 沿用 config.json 的字段名（instance_id / traffic_limit / bill_endpoint …），
 * 这样一个已经在用 FC 版的配置，改两行就能搬到 Workers 上。
 *
 * 与 FC 版的区别：这里不做「环境变量塞整个 JSON」那套（Workers 单个
 * 环境变量只有 5KB，多账号会超）。配置放 KV：key = `config`。
 */

import type { ScheduleConfig } from './scheduler.ts';

export type { ScheduleConfig };

export interface UserConfig {
  name?: string;
  instance_id: string;
  region: string;
  /** 资源组 ID，可选。传了会作为 DescribeInstances 的过滤条件 */
  resgroup?: string;
  /** 当月公网流量上限（GB），默认 180 */
  traffic_limit?: number;
  /** 账单阈值，默认 1.0（USD 或换算后的 CNY） */
  bill_threshold?: number;
  /** 国内站/国际站账单域名，留空按 BSS_ENDPOINTS[1] 走 */
  bill_endpoint?: string;
  /** 该账号自己的 AK（多账号时用），留空则用全局 ak/sk */
  ak?: string;
  sk?: string;
  paused?: boolean;
  disabled?: boolean;
}

export interface TelegramConfig {
  bot_token: string;
  chat_id: string;
  /** 允许使用 /menu 等管理命令的 Telegram user id 列表 */
  admin_user_ids?: number[];
}

export interface BarkConfig {
  bark_url?: string;
}

export interface AppConfig {
  ak?: string;
  sk?: string;
  telegram?: TelegramConfig;
  bark?: BarkConfig;
  users?: UserConfig[];
  /** 账单阈值里 USD→CNY 的汇率，默认 7.0 */
  usd_cny_rate?: number;
  /** 兼容旧字段：FC 版曾把它放在 user 里，这里仍读 user 优先 */
  timezone_offset_hours?: number;
  /** 开机点 / 日报时间的调度配置，留空走 DEFAULT_SCHEDULE */
  schedule?: ScheduleConfig;
}

/** 单实例的凭证：账号自己的优先，否则回落到全局 */
export function credsFor(config: AppConfig, user: UserConfig): { ak: string; sk: string } {
  const ak = (user.ak || config.ak || '').trim();
  const sk = (user.sk || config.sk || '').trim();
  if (!ak || !sk) {
    throw new Error(
      `实例 ${user.name || user.instance_id} 没有可用的 AccessKey —— ` +
        '请在配置里补 user.ak/user.sk 或全局 ak/sk',
    );
  }
  return { ak, sk };
}

export function trafficLimit(user: UserConfig): number {
  const limit = Number(user.traffic_limit);
  return Number.isFinite(limit) && limit > 0 ? limit : 180;
}

export function usdCnyRate(config: AppConfig): number {
  const rate = Number(config.usd_cny_rate);
  return Number.isFinite(rate) && rate > 0 ? rate : 7.0;
}

export interface ValidationIssue {
  level: 'error' | 'warn';
  message: string;
}

/** 部署前/自检时用：把配置里一眼能看出来的坑全列出来 */
export function validateConfig(config: AppConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const users = config.users ?? [];

  if (!users.length) {
    issues.push({ level: 'error', message: 'users 为空 —— 没有任何实例会被监控' });
  }
  if (!config.ak && !users.some((u) => u.ak)) {
    issues.push({ level: 'error', message: '缺少全局 ak/sk，且没有任何 user 自带 AK' });
  }
  if (config.ak && !config.sk) {
    issues.push({ level: 'error', message: '全局 ak 有值但 sk 为空' });
  }

  const tg = config.telegram;
  if (!tg?.bot_token || !tg?.chat_id) {
    issues.push({
      level: 'warn',
      message: 'telegram.bot_token 或 chat_id 缺失 —— 所有告警都发不出去',
    });
  }
  if (tg && !(tg.admin_user_ids ?? []).length) {
    issues.push({
      level: 'warn',
      message: 'telegram.admin_user_ids 为空 —— /menu 等管理命令会拒绝所有人',
    });
  }

  const seen = new Set<string>();
  users.forEach((user, index) => {
    const label = user.name || user.instance_id || `users[${index}]`;
    if (!user.instance_id) {
      issues.push({ level: 'error', message: `${label}: 缺少 instance_id` });
    } else if (seen.has(user.instance_id)) {
      issues.push({ level: 'error', message: `${label}: instance_id 重复` });
    } else {
      seen.add(user.instance_id);
    }
    if (!user.region) {
      issues.push({ level: 'error', message: `${label}: 缺少 region` });
    }
    if (user.ak && !user.sk) {
      issues.push({ level: 'error', message: `${label}: ak 有值但 sk 为空` });
    }
    if (user.traffic_limit !== undefined && !(Number(user.traffic_limit) > 0)) {
      issues.push({ level: 'warn', message: `${label}: traffic_limit 非正数，将回落到 180` });
    }
    if (user.bill_endpoint && !/^(business|business\.ap-southeast-1)\.aliyuncs\.com$/.test(user.bill_endpoint)) {
      issues.push({
        level: 'warn',
        message: `${label}: bill_endpoint=${user.bill_endpoint} 不是已知的账单域名，可能返回 NotApplicable`,
      });
    }
  });

  return issues;
}
