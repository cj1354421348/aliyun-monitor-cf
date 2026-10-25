/**
 * 状态持久化。
 *
 * ================================================================
 * 为什么从 OSS 换成 KV
 * ================================================================
 * FC 版把 state 存在 OSS 里，是因为 FC 实例之间不共享磁盘。Workers
 * 这边 KV 是原生的，而且免费额度足够（1 GB 存储 / 10 万次读 / 1 千次写每天）。
 *
 * ================================================================
 * 一个关键的语义：读失败不许写回
 * ================================================================
 * 读失败时 data 是空的，要是还允许写回，就会用一份空状态盖掉 KV 上
 * 真实的状态 —— 所有冷却时间戳和失败计数一次丢掉，接下来一小时会
 * 疯狂重复推送同一批告警。所以 readable=false 时 save() 直接拒写。
 *
 * 另外「内容没变就不写」也很重要：KV 免费额度每天只有 1000 次写，
 * 每 5 分钟一次 tick 就是 288 次/天，多实例还得乘。没变化就不写，
 * 能把写入量压到接近 0。
 */

export interface InstanceState {
  /** 各事件最后一次成功通知的时间戳（毫秒） */
  [event: string]: number | undefined;
  check_failures?: number;
  start_failures?: number;
  pending_start_ts?: number;
  last_retry_ts?: number;
}

export interface MonitorState {
  [instanceId: string]: InstanceState;
}

/** 抽象出来，方便测试时塞一个内存实现 */
export interface StateBackend {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export const STATE_KEY = 'state/monitor_state.json';

/** 递归按 key 排序后序列化 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + stableStringify((value as Record<string, unknown>)[key]));
  return '{' + entries.join(',') + '}';
}

export class State {
  private backend: StateBackend;
  private key: string;
  data: MonitorState = {};
  private snapshot = '';
  private readable = false;
  private log: { error(...a: unknown[]): void; warn(...a: unknown[]): void };

  constructor(
    backend: StateBackend,
    key = STATE_KEY,
    log: { error(...a: unknown[]): void; warn(...a: unknown[]): void } = console,
  ) {
    this.backend = backend;
    this.key = key;
    this.log = log;
  }

  private dump(): string {
    // 递归按 key 排序，让「内容相同」唯一对应「字符串相同」，
    // 下面的快照对比才成立（JSON.stringify 的 replacer 数组只管一层，
    // 而这里的 data 是两层：instance_id → 事件名 → 时间戳）。
    return stableStringify(this.data);
  }

  /** 读失败时 readable=false，后面 save() 会拒绝写 */
  async load(): Promise<MonitorState> {
    let raw: string | null = null;
    try {
      raw = await this.backend.get(this.key);
      this.readable = true;
    } catch (error) {
      this.log.error('读取状态失败，本轮按空状态运行（且不会写回）:', error);
      this.readable = false;
    }

    this.data = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        this.data = (parsed && typeof parsed === 'object' ? parsed : {}) as MonitorState;
      } catch {
        this.log.error('状态文件不是合法 JSON，本轮按空状态运行');
        this.data = {};
      }
    }

    this.snapshot = this.dump();
    return this.data;
  }

  /** 状态没变就不写；读失败过也不写。返回是否真的落盘成功。 */
  async save(): Promise<boolean> {
    if (!this.readable) {
      this.log.warn('状态未成功读取，跳过写入以免覆盖 KV 上的真实状态');
      return false;
    }
    const body = this.dump();
    if (body === this.snapshot) return true;
    try {
      await this.backend.put(this.key, body);
    } catch (error) {
      this.log.error('保存状态失败（会重复发通知）:', error);
      return false;
    }
    this.snapshot = body;
    return true;
  }

  info(instanceId: string): InstanceState {
    if (!this.data[instanceId]) this.data[instanceId] = {};
    return this.data[instanceId];
  }
}

/** 测试用：内存后端 */
export class MemoryBackend implements StateBackend {
  private store = new Map<string, string>();
  writes = 0;
  failReads = false;
  failWrites = false;

  async get(key: string): Promise<string | null> {
    if (this.failReads) throw new Error('read failed');
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    if (this.failWrites) throw new Error('write failed');
    this.writes += 1;
    this.store.set(key, value);
  }
}
