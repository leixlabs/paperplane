/**
 * 队列单元测试：只测纯 JS 的排队行为，不依赖 chrome.*。
 * 运行：node tests/queue.mjs
 */
import assert from 'node:assert/strict';
import { createTaskQueue, QUEUE_REJECT } from '../src/background/queue.js';

let pass = 0;
const ok = (name) => { pass++; console.log('  ✓ ' + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
};

/* ── 1. 串行：一次只跑一个，按入队顺序 ─────────────────── */
{
  const events = [];
  const q = createTaskQueue({ maxPending: 5 });

  const mk = (id, ms) => ({
    url: `https://x.com/${id}`,
    run: async () => {
      events.push(`start:${id}`);
      await sleep(ms);
      events.push(`end:${id}`);
      return id;
    },
  });

  q.add(mk(1, 30));
  q.add(mk(2, 5));
  q.add(mk(3, 5));

  await waitFor(() => events.length >= 6);
  assert.deepEqual(events, [
    'start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3',
  ], '应严格串行且保持 FIFO');
  ok('串行执行：一次只跑一个任务，顺序等于点击顺序');
}

/* ── 2. 空闲回调只在一批结束时触发一次 ─────────────────── */
{
  let idle = 0;
  const q2 = createTaskQueue({
    maxPending: 5,
    onIdle: () => { idle += 1; },
  });

  for (let i = 0; i < 4; i++) {
    q2.add({ url: `u${i}`, run: async () => { await sleep(2); } });
  }
  await waitFor(() => idle === 1);
  assert.equal(idle, 1, `一批任务只应触发一次 onIdle，实际 ${idle} 次`);
  ok('onIdle 在一批任务全部结束后只触发一次');
}

/* ── 3. 重复 URL 不重复入队 ────────────────────────────── */
{
  const q = createTaskQueue({ maxPending: 5 });
  const ran = [];

  const first = q.add({ url: 'https://a.com/x', run: async () => { ran.push('a'); await sleep(20); } });
  const dup = q.add({ url: 'https://a.com/x', run: async () => { ran.push('a2'); } });
  const other = q.add({ url: 'https://a.com/y', run: async () => { ran.push('b'); } });

  assert.equal(first.accepted, true);
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, QUEUE_REJECT.DUPLICATE, '同一个 URL 应判为重复');
  assert.equal(other.accepted, true, '不同 URL 应正常入队');

  await waitFor(() => ran.length >= 2);
  await sleep(20);
  assert.deepEqual(ran, ['a', 'b'], '重复的那次不应执行');
  ok('重复 URL 拦截：连点同一页只推送一次');
}

/* ── 4. 队列上限 ───────────────────────────────────────── */
{
  const q = createTaskQueue({ maxPending: 3 });
  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(q.add({ url: `u${i}`, run: async () => { await sleep(5); } }).accepted);
  }
  assert.deepEqual(results, [true, true, true, false, false], '超过上限应被拒绝');

  const full = q.add({ url: 'u9', run: async () => {} });
  assert.equal(full.reason, QUEUE_REJECT.FULL);
  ok('队列上限：超过 maxPending 后拒绝新任务');
}

/* ── 5. 单个任务失败不影响后续 ─────────────────────────── */
{
  const q = createTaskQueue({ maxPending: 5 });
  const done = [];
  const failed = [];

  q.add({
    url: 'bad',
    run: async () => { throw new Error('抽取失败'); },
    onFail: (err) => failed.push(err.message),
  });
  q.add({
    url: 'good',
    run: async () => 'ok',
    onDone: (res) => done.push(res),
  });

  await waitFor(() => done.length === 1 && failed.length === 1);
  assert.deepEqual(failed, ['抽取失败'], 'onFail 应收到错误');
  assert.deepEqual(done, ['ok'], '坏任务不应堵住队列');
  ok('容错：前一个任务抛错，后一个照常执行');
}

/* ── 6. 同步抛错也不会卡死队列 ─────────────────────────── */
{
  const q = createTaskQueue({ maxPending: 5 });
  const done = [];
  q.add({ url: 'sync', run: () => { throw new Error('同步炸了'); } });
  q.add({ url: 'next', run: async () => { done.push('next'); } });
  const passed = await waitFor(() => done.length === 1);
  assert.ok(passed, '同步抛错后队列应继续往下走');
  ok('同步异常被兜住，队列继续消费');
}

/* ── 7. state() 反映等待与运行中的数量 ─────────────────── */
{
  const q = createTaskQueue({ maxPending: 10 });
  assert.deepEqual(q.state(), { waiting: 0, running: 0, total: 0 }, '空队列');

  q.add({ url: 's1', run: async () => { await sleep(20); } });
  q.add({ url: 's2', run: async () => { await sleep(5); } });
  q.add({ url: 's3', run: async () => { await sleep(5); } });

  const mid = q.state();
  assert.equal(mid.running, 1, '同一时刻只应有一个任务在跑');
  assert.equal(mid.waiting, 2, '另外两个应在排队');
  assert.equal(mid.total, 3);

  await waitFor(() => q.state().total === 0);
  ok('state() 正确反映「1 个在跑 + N 个在等」，结束后归零');
}

console.log(`\n队列测试全部通过：${pass} 组断言\n`);
process.exit(0);
