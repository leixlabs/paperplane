/**
 * Service Worker · 事件编排层
 *
 * chrome.action.onClicked -> 入队（顺手抓取正文快照）
 *   -> 队列串行消费：本地 AI 摘要 -> 组装 MarkdownV2 -> fetch Telegram
 *   -> 徽标 / 通知反馈
 *
 * 无 Popup，一次点击直达。连点不再丢任务：每次点击都是一个独立任务，
 * 按点击顺序排队执行，上一批没发完也可以继续点下一篇。
 */
import { loadSettings, isConfigured } from './config.js';
import { runPipeline, capturePage, assertSendable } from './pipeline.js';
import { probeAI, warmupAI } from './ai-bridge.js';
import { getMe, sendMessage, normalizeChatId } from './telegram.js';
import { escapeMdV2 } from '../lib/markdown.js';
import { createTaskQueue, QUEUE_REJECT } from './queue.js';
import * as badge from './badge.js';

const TYPE_LABEL = {
  'key-points': '要点罗列',
  'tl;dr': '一句话总结',
  teaser: '导语',
  headline: '标题',
};

/** 队列上限：连点几十次也不至于把内存和 Telegram 频率一起打爆 */
const MAX_PENDING = 20;

let keepAliveTimer = null;

/** 当前任务的阶段文案，只用于徽标悬停 */
let stage = '';

/**
 * 一批任务 = 两次「队列清空」之间的所有点击。
 * 结束时给一次汇总反馈，而不是每篇弹一条通知。
 */
let batch = null;

/* ── 队列 ───────────────────────────────────────────────── */

const queue = createTaskQueue({
  maxPending: MAX_PENDING,
  onStateChange: (s) => { paintQueue(s).catch(() => {}); },
  onIdle: () => { finishBatch().catch(() => {}); },
});

/**
 * SW 有 30s 空闲回收机制，而模型首次下载可能持续数分钟。
 * 队列非空期间每 20s 调一次扩展 API，把空闲计时器按回去。
 */
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function ensureBatch(settings) {
  if (!batch) {
    batch = { total: 0, ok: 0, fail: 0, sent: [], failed: [], skipped: [], settings };
  }
  return batch;
}

/** 徽标最多显示 4 个字符，两位数会把 10/20 截断，退化成只看序号 */
function progressText(idx, total) {
  if (total <= 1) return '···';
  return total > 9 ? String(idx) : `${idx}/${total}`;
}

/** 徽标：单篇显示 ···，多篇显示 1/3 这种进度；悬停看当前阶段 */
async function paintQueue(s) {
  if (!s || s.total === 0) return;
  startKeepAlive();

  const total = Math.max(batch?.total || 0, s.total);
  const done = batch ? batch.ok + batch.fail : 0;
  const idx = Math.min(done + 1, total);

  const hint = total > 1
    ? `第 ${idx}/${total} 篇 · ${stage || '排队中…'}`
    : (stage || '正在处理…');

  await badge.setBusy(hint, progressText(idx, total));
}

function handleProgress(p) {
  if (!p?.message) return;
  stage = p.message;
  paintQueue(queue.state()).catch(() => {});
}

/* ── 任务构造 ───────────────────────────────────────────── */

let seq = 0;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // 抓取失败由 onFail 统一处理，这里只防止"未处理的拒绝"
  return { promise, resolve, reject };
}

function createJob(tab, settings) {
  const content = deferred();

  const job = {
    id: ++seq,
    url: tab.url || '',
    title: (tab.title || '').trim() || tab.url || '未命名页面',
    captured: null,

    /**
     * 入队后立刻抓正文：此刻 activeTab 授权刚由点击授予，页面也确实是用户点的那一页。
     * 抓到的是正文快照，之后翻页、关标签都不影响这一篇的发送。
     */
    capture() {
      capturePage(tab).then(
        (page) => { job.captured = page; content.resolve(page); },
        (err) => content.reject(err)
      );
    },

    async run() {
      const page = job.captured || await content.promise;
      stage = '准备生成摘要…';
      // url 用点击那一刻的地址：排队期间标签页可能已经关掉，去重仍要认得它
      return runPipeline({ page, url: job.url, settings, onProgress: handleProgress });
    },

    onDone(res) {
      const b = ensureBatch(settings);
      b.ok += 1;
      b.sent.push({
        ...res,
        typeLabel: TYPE_LABEL[settings.summaryType] || settings.summaryType,
      });
    },

    onFail(err) {
      const b = ensureBatch(settings);

      // 去重命中属于「按配置正常工作」，不是失败：单独计数，徽标走 SKIP
      if (err?.duplicate) {
        b.skipped.push({ title: job.title, message: String(err?.message || err) });
        return;
      }

      b.fail += 1;
      b.failed.push({ title: job.title, message: String(err?.message || err) });
    },
  };

  return job;
}

/* ── 提交与反馈 ─────────────────────────────────────────── */

function truncate(s, n = 22) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function engineLabelOf(item) {
  return item.degraded
    ? `本地启发式（AI 降级：${item.reason || '不可用'}）`
    : item.engine;
}

/** 入队前的失败（页面不支持 / 未配置等）：队列空闲时才抢徽标，否则只发通知 */
async function reportFailure(err, { settings, title } = {}) {
  const message = String(err?.message || err);
  const busy = queue.state().total > 0;

  if (!busy) {
    await badge.setError(message);
  } else if (settings?.notifyOnError === false) {
    // 队列在跑：不抢进度徽标，至少让悬停文案说清楚这一篇为什么没进来
    await badge.setProgress(`这篇没能入队：${truncate(message, 40)}`);
  }

  if (settings?.notifyOnError !== false) {
    await badge.notify({
      title: busy ? '✕ 这篇没能入队' : '✕ Paperplane 发送失败',
      message: title ? `${title}\n${message}` : message,
    });
  }
}

async function submit(tab) {
  let settings = null;
  try {
    settings = await loadSettings();
  } catch (err) {
    await reportFailure(err, { title: tab?.title });
    return;
  }

  if (!isConfigured(settings)) {
    await badge.setError('未配置 Bot Token / 频道');
    if (settings.notifyOnError !== false) {
      await badge.notify({
        title: 'Paperplane 尚未配置',
        message: '请先填写 BOT_TOKEN 与 CHANNEL_ID（已为你打开设置页）。',
      });
    }
    await chrome.runtime.openOptionsPage();
    return;
  }

  // 同步预检：注定失败的任务不要占队列位置
  try {
    assertSendable(tab);
  } catch (err) {
    await reportFailure(err, { settings, title: tab?.title });
    return;
  }

  const job = createJob(tab, settings);
  const b = ensureBatch(settings);
  b.total += 1;

  const { accepted, reason } = queue.add(job);

  if (!accepted) {
    b.total -= 1;
    if (b.total === 0) batch = null;

    if (reason === QUEUE_REJECT.DUPLICATE) {
      // 连点同一个页面：不重复推送，只提示一句
      await badge.setProgress(`该页面已在队列中：${truncate(job.title)}`);
      return;
    }
    await reportFailure(
      new Error(
        reason === QUEUE_REJECT.FULL
          ? `队列已满（最多 ${MAX_PENDING} 个），等这批发完再点`
          : '任务入队失败'
      ),
      { settings, title: job.title }
    );
    return;
  }

  // 冷启动预热挪到第一位任务入队时，后续任务直接命中已有 session
  if (queue.state().total === 1) warmupAI(settings).catch(() => {});

  job.capture();
}

/** 队列清空：给这一批一个总账，然后回到空闲态 */
async function finishBatch() {
  const b = batch;
  batch = null;
  stage = '';
  stopKeepAlive();

  if (!b || b.total === 0) return;
  const settings = b.settings || {};
  const skipped = b.skipped?.length || 0;

  // 整批都被去重拦下：这不是失败，用灰色 SKIP，且不弹错误通知
  if (b.ok === 0 && b.fail === 0 && skipped > 0) {
    await badge.setSkipped(
      b.total === 1 ? b.skipped[0].message : `${skipped} 篇都是发过的地址，已跳过`
    );
    return;
  }

  if (b.fail === 0) {
    const single = b.sent.length === 1 && skipped === 0 ? b.sent[0] : null;
    const tip = single
      ? `已发送到 ${normalizeChatId(settings.channelId)} · ${single.typeLabel} · ${engineLabelOf(single)} · ${single.parts} 条`
      : `已发送 ${b.ok} 篇到 ${normalizeChatId(settings.channelId)}` + (skipped ? ` · ${skipped} 篇重复跳过` : '');

    await badge.setSuccess(tip);

    if (settings.notifyOnSuccess) {
      await badge.notify({
        title: single ? '✓ 已推送到 Telegram' : `✓ 已推送 ${b.ok} 篇到 Telegram`,
        message: single
          ? `${single.title}\n${single.charCount} 字 → 摘要 ${single.summaryLen} 字 · ${single.engine}`
          : b.sent.map((s, i) => `${i + 1}. ${s.title}`).join('\n'),
      });
    }
    return;
  }

  // 有失败：成功数不为 0 时用「2/3」把部分成功的信息留在徽标上
  const first = b.failed[0];
  const suffix = skipped ? `（另有 ${skipped} 篇重复跳过）` : '';
  const tip = b.ok === 0
    ? (b.total === 1 ? first.message : `${b.fail} 篇全部失败：${first.message}`)
    : `${b.ok} 篇成功 / ${b.fail} 篇失败：${first.message}${suffix}`;

  await badge.setError(tip, b.ok > 0 ? { text: progressText(b.ok, b.total) } : {});

  if (settings.notifyOnError !== false) {
    await badge.notify({
      title: b.fail === 1 ? '✕ 1 篇发送失败' : `✕ ${b.fail} 篇发送失败`,
      message: b.failed.map((f) => `· ${truncate(f.title, 40)}：${f.message}`).join('\n'),
    });
  }
}

/* ── 触发层 ─────────────────────────────────────────────── */

/**
 * 提交串行化：submit 里有 await（读配置），并发点击的完成顺序不保证，
 * 串成一条 promise 链，队列顺序才真正等于点击顺序。
 */
let submitChain = Promise.resolve();

function enqueueClick(tab) {
  submitChain = submitChain
    .then(() => submit(tab))
    .catch((err) => reportFailure(err, {}).catch(() => {}));
}

chrome.action.onClicked.addListener((tab) => {
  enqueueClick(tab);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'send-to-telegram') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) enqueueClick(tab);
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await badge.reset();
  if (details.reason === 'install') {
    const settings = await loadSettings();
    if (!isConfigured(settings)) {
      chrome.runtime.openOptionsPage();
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  // 上次异常退出可能残留 ERR 徽标
  badge.reset();
  // 浏览器刚起来就把模型预热好，第一次点击就不用等冷启动
  loadSettings().then((s) => { if (isConfigured(s)) warmupAI(s); }).catch(() => {});
});

/* ── 与 UI / offscreen 的消息通道 ───────────────────────── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  // offscreen 的进度上报（单向，不回应）。只在有任务运行时改动徽标，
  // 否则会把刚打完的 ✓ 又盖成"处理中"。
  if (msg.type === 'L2T_PROGRESS') {
    if (queue.state().running > 0) handleProgress(msg.payload);
    return false;
  }

  if (msg.type === 'L2T_PROBE_AI') {
    probeAI()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, message: String(err?.message || err) }));
    return true;
  }

  if (msg.type === 'L2T_CONNECTION_TEST') {
    (async () => {
      const settings = await loadSettings();
      const bot = await getMe(settings.botToken);
      sendResponse({
        ok: true,
        bot: { id: bot.id, username: bot.username, name: bot.first_name },
        chatId: normalizeChatId(settings.channelId),
      });
    })().catch((err) => sendResponse({ ok: false, message: String(err?.message || err) }));
    return true;
  }

  if (msg.type === 'L2T_TEST_SEND') {
    (async () => {
      const settings = await loadSettings();
      if (!isConfigured(settings)) throw new Error('请先填写 BOT_TOKEN 与 CHANNEL_ID 并保存');
      const now = new Date().toLocaleString('zh-CN', { hour12: false });
      const md = [
        '*' + escapeMdV2('🔔 Paperplane 连通性测试') + '*',
        escapeMdV2(`时间：${now}`),
        '',
        escapeMdV2('如果你看到这条消息，说明 Bot Token、频道权限、网络链路全部正常。'),
        '',
        '_' + escapeMdV2('由浏览器本地插件直接调用 Telegram Bot API 发送') + '_',
      ].join('\n');
      const res = await sendMessage({
        token: settings.botToken,
        chatId: settings.channelId,
        text: md,
        parseMode: settings.parseMode,
      });
      sendResponse({ ok: true, messageId: res?.message_id });
    })().catch((err) => sendResponse({ ok: false, message: String(err?.message || err) }));
    return true;
  }

  return false;
});
