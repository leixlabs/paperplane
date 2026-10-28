/**
 * 去重测试：地址归一化 + 本地发送历史（假 IndexedDB）+ 流水线的跳过行为。
 * 运行：node tests/dedupe.mjs
 */
import assert from 'node:assert/strict';

import { normalizeUrl, isTrackingParam, sameAddress } from '../src/lib/url.js';
import { installFakeIndexedDB } from './fake-idb.mjs';

let pass = 0;
const ok = (name) => { pass++; console.log('  ✓ ' + name); };

/* ── 1. URL 归一化 ─────────────────────────────────────── */
{
  // 跟踪参数 + www + 末尾斜杠都要被抹平
  assert.equal(
    normalizeUrl('https://www.Example.com/a/?utm_source=tg&utm_medium=share&fbclid=xyz'),
    'https://example.com/a'
  );
  assert.equal(normalizeUrl('https://example.com/a#comments'), 'https://example.com/a');
  assert.equal(normalizeUrl('https://example.com:443/a'), 'https://example.com/a');

  // 参数顺序不影响指纹
  assert.equal(normalizeUrl('https://example.com/a?id=7&b=2'), 'https://example.com/a?b=2&id=7');

  // 业务参数必须保留，否则 ?p=2 的分页会被误判成同一页
  assert.equal(normalizeUrl('https://example.com/v?p=2'), 'https://example.com/v?p=2');
  assert.equal(normalizeUrl('http://example.com:8080/a'), 'http://example.com:8080/a');

  // 边界输入原样返回，不抛异常
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl(null), '');
  assert.equal(normalizeUrl('not a url'), 'not a url');

  assert.equal(isTrackingParam('spm_id_from'), true);
  assert.equal(isTrackingParam('UTM_Campaign'), true);
  assert.equal(isTrackingParam('p'), false);

  assert.equal(sameAddress('https://www.a.com/x?fbclid=1', 'https://a.com/x/'), true);
  assert.equal(sameAddress('https://a.com/x', 'https://a.com/y'), false);
  assert.equal(sameAddress('', ''), false);
  ok('normalizeUrl：抹平跟踪参数 / 锚点 / www / 参数顺序，保留业务参数');
}

/* ── 2. 本地历史读写（假 IndexedDB） ───────────────────── */
const fake = installFakeIndexedDB();
const history = await import('../src/background/history.js');
const pipeline = await import('../src/background/pipeline.js');

{
  // 空库
  assert.equal(await history.findSent('https://a.com/x'), null);

  // 写入 → 用「另一种写法的同一个地址」也能命中
  const wrote = await history.recordSent({
    url: 'https://www.a.com/x?utm_source=tg',
    title: '一篇文章',
    chatId: '@chan',
    messageId: 42,
  });
  assert.equal(wrote, true, '应写入成功');

  const hit = await history.findSent('https://a.com/x/');
  assert.ok(hit, '跟踪参数/斜杠不同也应命中');
  assert.equal(hit.count, 1);
  assert.equal(hit.messageId, 42);
  assert.ok(hit.key.startsWith('https://a.com/x'), '主键应是归一化地址：' + hit.key);

  // 同地址再发 → count 累加、firstSentAt 保留
  await history.recordSent({ url: 'https://a.com/x', title: '一篇文章' });
  const again = await history.findSent('https://a.com/x');
  assert.equal(again.count, 2);
  assert.equal(again.firstSentAt, hit.firstSentAt, 'firstSentAt 不应被覆盖');
  assert.ok(again.lastSentAt >= hit.lastSentAt);

  // 不同地址不该误伤
  assert.equal(await history.findSent('https://a.com/y'), null);
  assert.equal(await history.findSent('https://a.com/x?p=2'), null, '分页参数不同应视为不同页面');

  // 统计
  const s = await history.stats();
  assert.equal(s.supported, true);
  assert.equal(s.count, 1, `库里应只有 1 条，实得 ${s.count}`);
  assert.ok(s.lastSentAt > 0);
  assert.equal(fake.dump().sent.length, 1, '底层只应有一条记录');
  ok('recordSent / findSent / stats：写入、命中、累加、隔离');
}

/* ── 3. 去重有效期 ─────────────────────────────────────── */
{
  const realNow = Date.now;
  const DAY = 24 * 60 * 60 * 1000;

  try {
    Date.now = () => realNow() + 3 * DAY; // 假装过了 3 天
    assert.ok(await history.findSent('https://a.com/x', { keepDays: 7 }), '7 天内应仍然拦截');
    assert.equal(await history.findSent('https://a.com/x', { keepDays: 1 }), null, '超过 1 天应放行');
    assert.ok(await history.findSent('https://a.com/x', { keepDays: 0 }), '0 = 永久有效');

    Date.now = () => realNow() + 400 * DAY;
    assert.ok(await history.findSent('https://a.com/x', { keepDays: 0 }), '400 天后永久档仍应拦截');
  } finally {
    Date.now = realNow;
  }
  ok('dedupeKeepDays：0 = 永久，N = 只拦截最近 N 天');
}

/* ── 4. 流水线：命中重复 → 在提取之前就中止 ────────────── */
{
  let extracted = 0;
  globalThis.chrome = {
    scripting: {
      executeScript: async () => {
        extracted += 1;
        throw new Error('__EXTRACT_CALLED__');
      },
    },
  };

  const settings = {
    botToken: '1:' + 'A'.repeat(35),
    channelId: '@chan',
    skipDuplicates: true,
    dedupeKeepDays: 0,
  };

  await history.recordSent({ url: 'https://dup.example.com/post-1', title: '旧文' });

  await assert.rejects(
    () => pipeline.runPipeline({
      tab: { id: 1, url: 'https://www.dup.example.com/post-1/?utm_source=tw' },
      settings,
    }),
    (err) => {
      assert.equal(err.duplicate, true, '应抛出带 duplicate 标记的错误');
      assert.match(err.message, /已经发过/);
      assert.match(err.message, /累计 1 次/);
      return true;
    }
  );
  assert.equal(extracted, 0, '命中重复时不应注入提取器（省掉整条 AI 链路）');

  // 没发过的地址照常往下走
  await assert.rejects(
    () => pipeline.runPipeline({ tab: { id: 1, url: 'https://dup.example.com/post-2' }, settings }),
    /__EXTRACT_CALLED__/,
    '新地址应继续提取正文'
  );

  // 关掉开关 → 即便发过也继续
  extracted = 0;
  await assert.rejects(
    () => pipeline.runPipeline({
      tab: { id: 1, url: 'https://dup.example.com/post-1' },
      settings: { ...settings, skipDuplicates: false },
    }),
    /__EXTRACT_CALLED__/,
    '关闭开关后不应再拦截'
  );
  assert.equal(extracted, 1);
  ok('runPipeline：命中重复提前中止，开关关闭 / 新地址照常发送');
}

/* ── 5. 清空历史 ───────────────────────────────────────── */
{
  assert.equal(await history.clearAll(), true);
  assert.equal((await history.stats()).count, 0);
  assert.equal(await history.findSent('https://a.com/x'), null, '清空后应视为未发送');

  await assert.rejects(
    () => pipeline.runPipeline({
      tab: { id: 1, url: 'https://a.com/x' },
      settings: { skipDuplicates: true },
    }),
    /__EXTRACT_CALLED__/,
    '清空后应允许重新发送'
  );
  ok('clearAll：清空后地址重新可发');
}

/* ── 6. 没有 IndexedDB 时优雅降级 ──────────────────────── */
{
  fake.reset(); // 删掉假 indexedDB，模拟不支持的环境
  history._resetConnection();

  assert.equal(await history.findSent('https://a.com/x'), null, '查不到历史 → 按未发送处理');
  assert.equal(await history.recordSent({ url: 'https://a.com/x' }), false, '写入应返回 false 而不是抛错');
  assert.equal(await history.clearAll(), false);
  const s = await history.stats();
  assert.equal(s.supported, false);

  await assert.rejects(
    () => pipeline.runPipeline({
      tab: { id: 1, url: 'https://a.com/x' },
      settings: { skipDuplicates: true },
    }),
    /__EXTRACT_CALLED__/,
    '数据库不可用时不能拦住发送'
  );
  ok('IndexedDB 不可用时降级为「不去重」，绝不影响发送');
}

console.log(`\n去重测试全部通过：${pass} 组断言\n`);
