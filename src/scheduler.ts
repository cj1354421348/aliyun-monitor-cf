/**
 * 调度：一个 cron 触发器干三件事。
 *
 * ================================================================
 * 为什么只用一个 cron
 * ================================================================
 * Workers 免费版每个账号只允许 5 个 cron trigger，而我们要跑的是
 * 「5 分钟止损 + 30 分钟开机 + 每天 09:00 日报」。与其占掉 3 个配额，
 * 不如只挂一个 `*\/5 * * * *`，进来以后按北京时间自己分发：
 *
 *   每 5 分钟   → monitor（止损）
 *   :00 / :30   → 再跑一次 start（开机）
 *   09:00       → 再跑一次 report（日报）
 *
 * 好处不只是省配额：三件事共用一次 KV 读取和一次状态写回，
 * 免费版 KV 每天只有 1000 次写，这一点很实在。
 *
 * 注意 cron 表达式本身永远是 **UTC**，北京时间要减 8 小时。
 * 所以这里不写死表达式，而是进来以后用北京时间判断 —— 表达式写成
 * `*\/5 * * * *` 在任何时区都对。
 */

import { beijingHhMm, beijingWeekday } from './util.ts';

export interface ScheduleConfig {
  /** 止损间隔（分钟），只用于文档与校验，实际由 cron 表达式决定 */
  monitor_every_minutes?: number;
  /** 是否启用自动开机（关掉它就只止损、不自动开机） */
  auto_start?: boolean;
  /** 开机检查的分钟点，默认 [0, 30] */
  start_at_minutes?: number[];
  /** 日报时间 HH:MM（北京时间），默认 09:00 */
  report_at?: string;
  /** 日报只在周几发，0=周日…6=周六，默认每天 */
  report_weekdays?: number[];
}

export interface DispatchPlan {
  monitor: boolean;
  start: boolean;
  report: boolean;
  /** 给日志用的一句话说明 */
  reason: string;
}

export const DEFAULT_SCHEDULE: Required<ScheduleConfig> = {
  monitor_every_minutes: 5,
  auto_start: true,
  start_at_minutes: [0, 30],
  report_at: '09:00',
  report_weekdays: [0, 1, 2, 3, 4, 5, 6],
};

export function resolveSchedule(raw?: ScheduleConfig): Required<ScheduleConfig> {
  const startMinutes = (raw?.start_at_minutes ?? DEFAULT_SCHEDULE.start_at_minutes)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value < 60);
  const weekdays = (raw?.report_weekdays ?? DEFAULT_SCHEDULE.report_weekdays)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
  return {
    monitor_every_minutes: Number(raw?.monitor_every_minutes) || DEFAULT_SCHEDULE.monitor_every_minutes,
    auto_start: raw?.auto_start ?? DEFAULT_SCHEDULE.auto_start,
    start_at_minutes: startMinutes.length ? startMinutes : DEFAULT_SCHEDULE.start_at_minutes,
    report_at: /^\d{2}:\d{2}$/.test(raw?.report_at ?? '') ? raw!.report_at! : DEFAULT_SCHEDULE.report_at,
    report_weekdays: weekdays.length ? weekdays : DEFAULT_SCHEDULE.report_weekdays,
  };
}

/**
 * 决定这一分钟该跑什么。
 *
 * 抽成纯函数是为了能测：给定一个时间戳，返回确定的计划，
 * 不依赖 Date.now()，也不碰网络。
 */
export function planFor(
  now: number,
  schedule: ScheduleConfig = {},
): DispatchPlan {
  const resolved = resolveSchedule(schedule);
  const hhmm = beijingHhMm(now);
  const minute = Number(hhmm.slice(3, 5));
  const weekday = beijingWeekday(now);

  const start = resolved.auto_start && resolved.start_at_minutes.includes(minute);
  const report =
    hhmm === resolved.report_at && resolved.report_weekdays.includes(weekday);

  const parts: string[] = ['monitor'];
  if (start) parts.push('start');
  if (report) parts.push('report');
  return {
    monitor: true,
    start,
    report,
    reason: `${hhmm} 北京时间 → ${parts.join(' + ')}`,
  };
}

/** wrangler.toml 里挂的那个 cron，改这里要同步改 toml */
export const CRON = '*/5 * * * *';

/** 校验 cron 表达式和 SCHEDULE 是否自洽（部署前自检用） */
export function validateSchedule(schedule: ScheduleConfig, cron: string): string[] {
  const issues: string[] = [];
  const resolved = resolveSchedule(schedule);
  const cronMinutes = cron.split(/\s+/)[0] ?? '';
  const stepMatch = /^\*\/(\d+)$/.exec(cronMinutes);

  if (stepMatch) {
    const step = Number(stepMatch[1]);
    if (step > resolved.monitor_every_minutes) {
      issues.push(
        `cron 每 ${step} 分钟触发一次，比 monitor_every_minutes=${resolved.monitor_every_minutes} 慢，` +
          '止损会不及时',
      );
    }
    for (const target of resolved.start_at_minutes) {
      if (target % step !== 0) {
        issues.push(`start_at_minutes 含 ${target}，但 cron 每 ${step} 分钟才触发，这个分钟点永远碰不到`);
      }
    }
    const reportMinute = Number(resolved.report_at.slice(3, 5));
    if (reportMinute % step !== 0) {
      issues.push(
        `report_at=${resolved.report_at} 的分钟数 ${reportMinute} 不是 ${step} 的整数倍，日报永远不会触发`,
      );
    }
  } else {
    issues.push(`无法解析 cron 的分钟字段「${cronMinutes}」，请确认是 */N 形式`);
  }
  return issues;
}
