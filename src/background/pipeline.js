/**
 * 流水线编排：数据采集 → 去重 → AI 摘要 → 排版 → 传输
 * 与 chrome.* 事件解耦，方便单元测试与复用。
 */
import { buildMessage } from '../lib/markdown.js';
import { stripMarkdown } from '../lib/text.js';
import { summarizePage } from './ai-bridge.js';
import { sendSummary } from './telegram.js';
import { findSent, recordSent } from './history.js';

const RESTRICTED_PREFIX = /^(chrome|edge|about|chrome-extension|devtools|view-source|data|blob):/i;

/**
 * 命中本地历史时抛出，让编排层区分「重复跳过」和「真的失败」——
 * 前者不该弹错误通知，也不该把徽标打成 ERR。
 */
export class DuplicateError extends Error {
  constructor(record) {
    super(`这个地址已经发过（${formatWhen(record?.lastSentAt)}，累计 ${record?.count || 1} 次），已跳过`);
    this.name = 'DuplicateError';
    this.duplicate = true;
    this.record = record || null;
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatWhen(ts) {
  if (!ts) return '此前';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '此前';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function assertSendable(tab) {
  const url = tab?.url || '';
  if (!tab?.id) throw new Error('没有可用的标签页');
  if (!url) throw new Error('无法读取当前页地址');
  if (RESTRICTED_PREFIX.test(url)) {
    throw new Error('浏览器内部页面（chrome:// 等）不允许注入脚本，请在普通网页上使用');
  }
  if (!/^https?:/i.test(url)) {
    throw new Error('仅支持 http / https 网页');
  }
}

/**
 * 采集层 —— 注入提取器，取回正文
 */
export async function extractPage(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/content/extractor.js'],
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => (globalThis.__LINK2TELE_EXTRACTOR__
      ? globalThis.__LINK2TELE_EXTRACTOR__()
      : null),
  });

  const page = results?.[0]?.result;
  if (!page || page.ok === false) {
    throw new Error(page?.reason || '正文提取失败（页面可能尚未加载完成，或内容在跨域 iframe 中）');
  }
  if (!page.text) {
    throw new Error('正文提取失败（页面可能尚未加载完成，或内容在跨域 iframe 中）');
  }

  // 视频页只有标题+简介，天然比文章短，用更低的门槛
  const minLen = page.videoPage ? 30 : 120;
  if (page.text.length < minLen) {
    throw new Error(
      page.videoPage
        ? `视频简介过短（仅 ${page.text.length} 字），没什么可摘要的`
        : `正文过短（仅 ${page.text.length} 字），可能不是文章页`
    );
  }
  return page;
}

/**
 * 去重检查：只读本地数据库，不发任何网络请求。
 * 用 tab.url（用户眼前的地址）而不是提取后的 page.url —— 位置在提取之前，
 * 重复页可以直接省掉整条「提取 + AI 推理 + 上传」。
 * @returns {Promise<object|null>} 命中返回历史记录
 */
export async function checkDuplicate(url, settings) {
  if (!settings?.skipDuplicates) return null;
  const keepDays = Number(settings.dedupeKeepDays) || 0;
  return findSent(url, { keepDays });
}

/**
 * 完整流水线
 * @param {{tab:object, settings:object, onProgress?:(p:object)=>void}} args
 */
export async function runPipeline({ tab, settings, onProgress }) {
  const t0 = Date.now();
  assertSendable(tab);

  // ① 去重：命中就直接中止，省掉后面所有开销
  const hit = await checkDuplicate(tab.url, settings);
  if (hit) throw new DuplicateError(hit);

  onProgress?.({ stage: 'extract', message: '正在提取网页正文…' });
  const page = await extractPage(tab.id);

  onProgress?.({ stage: 'summarize', message: '本地 AI 正在生成摘要…' });
  const result = await summarizePage({ page, settings, onProgress });

  onProgress?.({ stage: 'format', message: '正在排版消息…' });
  const markdown = buildMessage({
    title: page.title,
    url: page.url,
    siteName: page.siteName,
    author: page.author,
    charCount: page.charCount,
    summary: result.summary,
    engine: result.engine,
    degraded: result.degraded,
    settings,
  });

  onProgress?.({ stage: 'send', message: '正在推送到 Telegram…' });
  const sent = await sendSummary({
    token: settings.botToken,
    chatId: settings.channelId,
    markdown,
    parseMode: settings.parseMode || 'MarkdownV2',
    linkPreview: settings.linkPreview !== false,
  });

  // ② 只有真的发出去了才写历史。开关关着也照记 —— 以后打开去重立刻有底数。
  const recorded = await recordSent({
    url: page.url || tab.url,
    title: page.title,
    chatId: settings.channelId,
    messageId: sent.messageIds?.[0] ?? null,
  });

  return {
    ok: true,
    title: page.title,
    url: page.url,
    parts: sent.parts,
    engine: result.engine,
    degraded: Boolean(result.degraded),
    reason: result.reason || '',
    charCount: page.charCount,
    summaryLen: stripMarkdown(result.summary).length,
    extractedFrom: page.extractedFrom,
    recorded,
    ms: Date.now() - t0,
  };
}
