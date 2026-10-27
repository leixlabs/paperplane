/**
 * offscreen document 的消息泵：把 AI 能力暴露给 Service Worker。
 */
import { getAvailability, summarizeWithNano, warmUp, disposeSessions } from './ai.js';

function report(payload) {
  // 单向进度通知，不等待回应
  chrome.runtime.sendMessage({ type: 'L2T_PROGRESS', payload }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'L2T_AI_AVAILABILITY') {
    getAvailability()
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  // 预热：把模型冷启动的等待挪到点击之前
  if (msg.type === 'L2T_AI_WARMUP') {
    warmUp(msg.settings || {}, report)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  // 配置变更（如换了摘要类型/输出语言）后丢弃旧 session，下次按新参数重建
  if (msg.type === 'L2T_AI_DISPOSE') {
    disposeSessions();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'L2T_AI_SUMMARIZE') {
    const { text, settings, page } = msg;
    summarizeWithNano(text, settings || {}, page || {}, report)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  return false;
});

report({ stage: 'ready', message: 'AI worker 已就绪' });
