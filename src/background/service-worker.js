/**
 * Service Worker · 事件编排层
 *
 * chrome.action.onClicked -> 取当前 Tab -> 提取正文 -> 本地 AI 摘要
 *   -> 组装 MarkdownV2 -> fetch Telegram -> Badge 反馈
 *
 * 无 Popup，一次点击直达。
 */
import { loadSettings, isConfigured } from './config.js';
import { runPipeline } from './pipeline.js';
import { probeAI } from './ai-bridge.js';
import { getMe, sendMessage, normalizeChatId } from './telegram.js';
import { buildMessage } from '../lib/markdown.js';
import { escapeMdV2 } from '../lib/markdown.js';
import * as badge from './badge.js';

const TYPE_LABEL = {
  'key-points': '要点罗列',
  'tl;dr': '一句话总结',
  teaser: '导语',
  headline: '标题',
};

/** 并发闸门：避免用户连点造成重复推送 / 重复创建 offscreen */
let busy = false;
let keepAliveTimer = null;

/**
 * SW 有 30s 空闲回收机制，而模型首次下载可能持续数分钟。
 * 每 20s 调一次扩展 API 可重置空闲计时器。
 */
function startKeepAlive() {
  stopKeepAlive();
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

async function handleSend(tab) {
  if (busy) {
    await badge.setProgress('上一个任务还在处理中，请稍候…');
    return;
  }
  busy = true;
  startKeepAlive();

  let settings = null;
  try {
    settings = await loadSettings();

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

    await badge.setBusy('正在提取网页正文…');

    const result = await runPipeline({
      tab,
      settings,
      onProgress: (p) => {
        if (p?.message) badge.setProgress(p.message).catch(() => {});
      },
    });

    // 悬停文案里带上引擎与摘要类型，方便确认配置是否真的生效
    const typeLabel = TYPE_LABEL[settings.summaryType] || settings.summaryType;
    const engineLabel = result.degraded
      ? `本地启发式（AI 降级：${result.reason || '不可用'}）`
      : result.engine;

    const tip = `已发送到 ${normalizeChatId(settings.channelId)} · ${typeLabel} · ${engineLabel} · ${result.parts} 条`;

    await badge.setSuccess(tip);

    if (settings.notifyOnSuccess) {
      await badge.notify({
        title: '✓ 已推送到 Telegram',
        message: `${result.title}\n${result.charCount} 字 → 摘要 ${result.summaryLen} 字 · ${result.engine}`,
      });
    }
  } catch (err) {
    const msg = String(err?.message || err);
    await badge.setError(msg);
    if (settings?.notifyOnError !== false) {
      await badge.notify({ title: '✕ Paperplane 发送失败', message: msg });
    }
  } finally {
    busy = false;
    stopKeepAlive();
  }
}

/* ── 触发层 ─────────────────────────────────────────────── */

chrome.action.onClicked.addListener((tab) => {
  handleSend(tab); // 幂等，异常已在内部兜住
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'send-to-telegram') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) handleSend(tab);
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
});

/* ── 与 UI / offscreen 的消息通道 ───────────────────────── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  // offscreen 的进度上报（单向，不回应）
  if (msg.type === 'L2T_PROGRESS') {
    const p = msg.payload;
    if (p?.message) badge.setProgress(p.message).catch(() => {});
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
