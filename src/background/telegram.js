/**
 * 传输层：Telegram Bot API 客户端（浏览器 fetch 直连，无中间服务器）
 */
import { TELEGRAM_API_BASE } from './config.js';
import { chunkMessage } from '../lib/markdown.js';

export function isValidToken(token) {
  return /^\d{6,}:[A-Za-z0-9_-]{28,}$/.test(String(token || '').trim());
}

/** 归一化频道标识：支持 @name / -100... 数字 ID / t.me 链接 */
export function normalizeChatId(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  const m = s.match(/t\.me\/(?:s\/)?(@?[\w\d_]+)/i);
  if (m) {
    s = m[1];
  }
  if (/^-?\d+$/.test(s)) return s;
  if (!s.startsWith('@')) s = '@' + s;
  return s;
}

function friendlyError(err) {
  const d = String(err?.description || err?.message || '');
  const code = err?.code || err?.status;

  if (code === 401) return new Error('BOT_TOKEN 无效或已失效（401 Unauthorized）。请到 @BotFather 重新获取。');
  if (code === 403) return new Error('Bot 无权向该频道发消息（403）：请把 Bot 加入频道并设为管理员，勾选「发布消息」。');
  if (/chat not found/i.test(d)) return new Error('频道不存在或 Bot 无权限（chat not found）。请检查 CHANNEL_ID，并确认 Bot 已加入该频道。');
  if (/not enough rights|have no rights/i.test(d)) return new Error('Bot 在频道内没有发言权限，请将其设为管理员并勾选「发布消息」。');
  if (/bots? can't? (initiate|send)/i.test(d)) return new Error('Bot 无法主动向该会话发消息，请改用频道（Channel）而非私聊。');
  if (/message is too long/i.test(d)) return new Error('消息超出 4096 字符上限（分片失败）。');
  if (/can't parse entities|unsupported start tag|unmatched end tag/i.test(d)) return new Error('MarkdownV2 转义失败：' + d);
  if (code === 429) return new Error(`请求过于频繁，Telegram 要求等待 ${err.retryAfter || 30}s。`);
  if (/Failed to fetch|NetworkError|Load failed/i.test(d)) return new Error('无法连接 api.telegram.org，请检查网络或代理。');
  return new Error(d || 'Telegram API 调用失败');
}

async function callApi(token, method, payload, { timeout = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('连接 Telegram 超时，请检查网络');
    throw friendlyError(e);
  } finally {
    clearTimeout(timer);
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok || !data.ok) {
    const err = new Error(data.description || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data.error_code;
    err.description = data.description || '';
    err.retryAfter = data.parameters?.retry_after;
    throw friendlyError(err);
  }
  return data.result;
}

/** 校验 Bot 身份，用于配置页「测试连接」 */
export async function getMe(token) {
  if (!isValidToken(token)) throw new Error('BOT_TOKEN 格式不正确（应形如 123456789:AA...）');
  return callApi(token, 'getMe', {}, { timeout: 15000 });
}

/** 单条发送，parseMode 失败时自动降级为纯文本；429 自动重试一次 */
export async function sendMessage({ token, chatId, text, parseMode = 'MarkdownV2', disablePreview = false }) {
  const base = {
    chat_id: normalizeChatId(chatId),
    text,
    disable_web_page_preview: Boolean(disablePreview),
    disable_notification: false,
  };

  const attempt = async (withParseMode) => {
    const payload = { ...base };
    if (withParseMode) {
      payload.parse_mode = parseMode;
      payload.link_preview_options = { is_disabled: Boolean(disablePreview) };
    }
    return callApi(token, 'sendMessage', payload);
  };

  try {
    return await attempt(true);
  } catch (err) {
    if (err.retryAfter) {
      await new Promise((r) => setTimeout(r, Math.min(err.retryAfter, 30) * 1000));
      return attempt(true);
    }
    if (/MarkdownV2|转义失败|parse entities/i.test(err.message)) {
      // 容灾：去掉 parse_mode 重发，宁可丢格式也不能丢内容
      return attempt(false);
    }
    throw err;
  }
}

/**
 * 分片发送：首片保留网页预览卡片，续片关闭预览。
 * @returns {{messageIds:number[], parts:number}}
 */
export async function sendSummary({ token, chatId, markdown, parseMode, linkPreview }) {
  const chunks = chunkMessage(markdown, 3900);
  const messageIds = [];

  for (let i = 0; i < chunks.length; i++) {
    const res = await sendMessage({
      token,
      chatId,
      text: chunks[i],
      parseMode,
      disablePreview: !linkPreview || i > 0,
    });
    messageIds.push(res?.message_id);
  }

  return { messageIds, parts: chunks.length };
}
