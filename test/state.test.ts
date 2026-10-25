/**
 * 状态持久化测试。
 *
 * 这里守的是两条会在生产上直接造成事故的不变量：
 *
 *   1. 读失败绝不写回。读失败时 data 是空的，写回去就等于用空状态
 *      覆盖 KV 上真实的冷却时间戳 —— 接下来一小时会疯狂重复推送。
 *   2. 内容没变就不写。KV 免费额度每天只有 1000 次写，而每 5 分钟
 *      一次 tick 就是 288 次/天，多实例还得乘。没有这条，写额度
 *      三天就烧完，然后所有状态静默丢失。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemoryBackend, State, stableStringify } from '../src/state.ts';

const KEY = 'state/test.json';
const silent = { error() {}, warn() {} };

test('stableStringify 递归按 key 排序', () => {
  const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
  const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":3,"d":2},"b":1}');
});

test('stableStringify 处理数组、null 与标量', () => {
  assert.equal(stableStringify([3, 1, 2]), '[3,1,2]');
  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify('x'), '"x"');
  assert.equal(stableStringify(0), '0');
});

test('load 读不到 key 时返回空对象且仍可写', async () => {
  const backend = new MemoryBackend();
  const state = new State(backend, KEY, silent);
  assert.deepEqual(await state.load(), {});

  state.data['i-1'] = { overlimit: 123 };
  assert.equal(await state.save(), true);
  assert.equal(backend.writes, 1);
});

test('读失败后 save 拒写，KV 上的真实状态不会被清空', async () => {
  const backend = new MemoryBackend();
  // 先正常写入一份真实状态
  const seed = new State(backend, KEY, silent);
  await seed.load();
  seed.data['i-1'] = { overlimit: 1700000000000, start_failures: 2 };
  assert.equal(await seed.save(), true);

  // 再模拟一次读失败的 tick
  const failing = new MemoryBackend();
  failing.failReads = true;
  // 让这个 backend 上本来就有内容，只是读会抛
  await new MemoryBackend().put(KEY, 'unused');
  const state = new State(failing, KEY, silent);
  await state.load();

  state.data['i-1'] = { overlimit: 1 };
  assert.equal(await state.save(), false, '读失败过就不许写');
  assert.equal(failing.writes, 0);
});

test('内容没变时 save 不产生写入', async () => {
  const backend = new MemoryBackend();
  const state = new State(backend, KEY, silent);
  await state.load();

  assert.equal(await state.save(), true);
  assert.equal(backend.writes, 0, '空状态且未改动，不该写');

  state.data['i-1'] = { overlimit: 1 };
  assert.equal(await state.save(), true);
  assert.equal(backend.writes, 1);

  // 再存一次同样的内容
  assert.equal(await state.save(), true);
  assert.equal(backend.writes, 1, '重复保存不应再写');
});

test('key 顺序不同但内容相同，也算没变', async () => {
  const backend = new MemoryBackend();
  const state = new State(backend, KEY, silent);
  await state.load();

  state.data['i-1'] = { overlimit: 1, check_failures: 2 };
  await state.save();
  assert.equal(backend.writes, 1);

  // 重建一个同内容但 key 插入顺序不同的对象
  const reordered: Record<string, number> = {};
  reordered['check_failures'] = 2;
  reordered['overlimit'] = 1;
  state.data['i-1'] = reordered;
  await state.save();
  assert.equal(backend.writes, 1, 'key 顺序不该影响内容比对');
});

test('写失败返回 false，不会谎报成功', async () => {
  const backend = new MemoryBackend();
  const state = new State(backend, KEY, silent);
  await state.load();
  state.data['i-1'] = { overlimit: 1 };
  backend.failWrites = true;

  assert.equal(await state.save(), false);
});

test('非法 JSON 按空状态处理，但仍是可写的', async () => {
  const backend = new MemoryBackend();
  await backend.put(KEY, '{ not json');

  const state = new State(backend, KEY, silent);
  assert.deepEqual(await state.load(), {});

  state.data['i-1'] = { overlimit: 1 };
  assert.equal(await state.save(), true, '读到脏数据也要能修好它');
});

test('info() 按需建桶', async () => {
  const backend = new MemoryBackend();
  const state = new State(backend, KEY, silent);
  await state.load();

  const info = state.info('i-9');
  info.overlimit = 42;
  assert.equal(state.data['i-9']?.overlimit, 42);
  assert.equal(state.info('i-9'), info, '同一实例要返回同一个对象');
});

test('往返：写进去的状态能原样读回来', async () => {
  const backend = new MemoryBackend();
  const writer = new State(backend, KEY, silent);
  await writer.load();
  writer.data['i-1'] = { overlimit: 1, pending_start_ts: 2, start_failures: 0 };
  await writer.save();

  const reader = new State(backend, KEY, silent);
  const loaded = await reader.load();
  assert.deepEqual(loaded['i-1'], { overlimit: 1, pending_start_ts: 2, start_failures: 0 });
});
