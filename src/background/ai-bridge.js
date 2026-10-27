/**
 * AI 桥接层：Service Worker ↔ offscreen document
 *
 * 职责：
 *  1. 按需创建/复用 offscreen document（只有它有 window，能访问 Summarizer）
 *  2. 带超时地调用 AI，避免 SW 被挂死
 *  3. AI 不可用时按配置自动降级到纯 JS 启发式引擎
 */
import { heuristicSummary } from '../lib/heuristic.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const AI_TIMEOUT_MS = 300000;       // 5 分钟：首次调用可能触发 2GB 模型下载
const PROBE_TIMEOUT_MS = 20000;

let creatingPromise = null;

async function hasOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

export async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingPromise) {
    await creatingPromise;
    return;
  }
  creatingPromise = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification:
          '在本地调用 Chrome 内置 AI（Gemini Nano）为网页生成摘要，需要 window 环境，数据不出本机。',
      });
    } catch (err) {
      // 并发点击可能重复创建，Chrome 只允许一个 offscreen document
      if (!/single offscreen document/i.test(String(err?.message || ''))) {
        throw new Error('无法创建 AI 运行环境：' + (err?.message || err));
      }
    }
  })();
  try {
    await creatingPromise;
  } finally {
    creatingPromise = null;
  }
}

function sendToOffscreen(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('本地 AI 响应超时')), timeoutMs);
    chrome.runtime.sendMessage(message)
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/** 供配置页调用：探测模型可用性 */
export async function probeAI() {
  try {
    await ensureOffscreen();
  } catch (err) {
    return {
      ok: false,
      supported: false,
      availability: 'error',
      message: String(err?.message || err),
    };
  }
  try {
    const res = await sendToOffscreen({ type: 'L2T_AI_AVAILABILITY' }, PROBE_TIMEOUT_MS);
    return res || { ok: false, message: '未收到 AI 引擎响应' };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

/**
 * 生成摘要：优先本地 Gemini Nano，失败按配置降级。
 * @returns {Promise<{summary:string, engine:string, degraded:boolean, reason?:string}>}
 */
export async function summarizePage({ page, settings, onProgress }) {
  const useAI = settings.enableAI !== false;

  if (!useAI) {
    const h = heuristicSummary(page, settings);
    return { ...h, degraded: true, reason: '已在设置中关闭内置 AI' };
  }

  try {
    await ensureOffscreen();
    const res = await sendToOffscreen(
      { type: 'L2T_AI_SUMMARIZE', text: page.text, settings, page },
      AI_TIMEOUT_MS
    );

    if (!res) throw new Error('AI 引擎无响应（offscreen document 可能已关闭）');
    if (!res.ok) throw new Error(res.error || '本地 AI 生成失败');
    if (!res.summary || !String(res.summary).trim()) throw new Error('本地 AI 返回了空摘要');

    return {
      summary: String(res.summary),
      engine: res.engine || 'gemini-nano',
      degraded: false,
      chunks: res.chunks || 1,
    };
  } catch (err) {
    const reason = String(err?.message || err);
    if (settings.autoFallback === false) {
      throw new Error('本地 AI 不可用：' + reason);
    }
    onProgress?.({ stage: 'fallback', message: 'AI 不可用，切换到本地启发式摘要…' });
    const h = heuristicSummary(page, settings);
    return { ...h, degraded: true, reason };
  }
}
