/**
 * AI 计算层 · Gemini Nano 调用封装（运行在 offscreen document，拥有 window）
 *
 * 为什么需要 offscreen：MV3 的 Service Worker 没有 window/DOM，
 * 而 Chrome Built-in AI 的入口挂在 window 上（Summarizer / window.ai）。
 * offscreen document 提供一个隐藏的扩展页面，把 window 借给 AI 用，
 * 数据全程留在本机，不经过任何网络。
 *
 * 兼容两代 API：
 *   新（Chrome 131+）：globalThis.Summarizer.{availability,create}
 *   旧（Chrome 127~130）：window.ai.summarizer.{capabilities,create}
 */
import { chunkByParagraph, truncate, normalizeSpace } from '../lib/text.js';

const MAX_CHUNKS = 6;
const CHUNK_MIN = 2500;

/** Summarizer type 取值映射：内部 tl;dr → API 的 tldr */
function apiType(type) {
  switch (type) {
    case 'tl;dr':
    case 'tldr':
      return 'tldr';
    case 'teaser':
      return 'teaser';
    case 'headline':
      return 'headline';
    case 'key-points':
    default:
      return 'key-points';
  }
}

function newApi() {
  const S = globalThis.Summarizer;
  if (S && typeof S.create === 'function') return { kind: 'new', api: S };
  const legacy = globalThis.window?.ai?.summarizer;
  if (legacy && typeof legacy.create === 'function') return { kind: 'legacy', api: legacy };
  return null;
}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** 查询可用性，返回归一化结果 */
export async function getAvailability() {
  const found = newApi();
  if (!found) {
    return {
      supported: false,
      apiVersion: 'none',
      availability: 'unsupported',
      message: '当前浏览器未暴露 Summarizer API。需要 Chrome 127+ 且已启用 Built-in AI。',
    };
  }

  try {
    if (found.kind === 'new') {
      const raw = await found.api.availability();
      return {
        supported: true,
        apiVersion: 'new',
        availability: raw, // unavailable | downloadable | downloading | available
        message: describeAvailability(raw),
      };
    }
    const caps = await found.api.capabilities();
    const map = { readily: 'available', 'after-download': 'downloadable', no: 'unavailable' };
    const availability = map[caps.available] || 'unavailable';
    return {
      supported: true,
      apiVersion: 'legacy',
      availability,
      message: describeAvailability(availability) + '（旧版 API）',
    };
  } catch (err) {
    return {
      supported: false,
      apiVersion: found.kind,
      availability: 'error',
      message: '查询模型可用性失败：' + (err?.message || err),
    };
  }
}

function describeAvailability(a) {
  switch (a) {
    case 'available':
      return '模型已就绪，可离线摘要。';
    case 'downloadable':
      return '模型尚未下载，首次调用将自动下载（约 1.5~2.5 GB，需保持联网）。';
    case 'downloading':
      return '模型正在下载中，请稍后重试。';
    case 'unavailable':
      return '本机不满足运行条件（硬件或系统限制），将使用本地启发式降级。';
    default:
      return String(a);
  }
}

/**
 * 创建一个 summarizer 实例。
 * @param {{type?:string,length?:string,format?:string,language?:string,context?:string}} opt
 * @param {(p:object)=>void} onProgress
 */
async function createSummarizer(opt, onProgress) {
  const found = newApi();
  if (!found) throw new Error('Summarizer API 不可用');

  const type = apiType(opt.type);
  const length = opt.length || 'medium';
  const format = opt.format || 'markdown';

  const monitor = (m) => {
    try {
      m.addEventListener('downloadprogress', (e) => {
        const pct = Math.round((e.loaded || 0) * 100);
        onProgress?.({ stage: 'download', percent: pct, message: `模型下载中 ${pct}%` });
      });
    } catch { /* 老版本无 monitor */ }
  };

  const rich = {
    type,
    length,
    format,
    sharedContext: opt.context || '',
    outputLanguage: opt.language || 'zh',
    monitor,
  };
  const minimal = { type, length, format, monitor };

  const attempt = async (params) => {
    if (found.kind === 'new') return found.api.create(params);
    return found.api.create(params);
  };

  try {
    return await withTimeout(attempt(rich), 240000, '创建摘要器');
  } catch (err) {
    // 参数不被识别（旧 API 不认识 outputLanguage 等）→ 退回最小参数集
    if (/not a valid|unrecognized|Invalid|outputLanguage|sharedContext/i.test(String(err?.message))) {
      return await withTimeout(attempt(minimal), 240000, '创建摘要器');
    }
    throw err;
  }
}

async function runSummarize(summarizer, text, context) {
  const opts = context ? { context } : undefined;
  try {
    return await summarizer.summarize(text, opts);
  } catch (err) {
    // 某些版本不认识 options 参数
    if (opts && /argument|options|context/i.test(String(err?.message))) {
      return await summarizer.summarize(text);
    }
    throw err;
  }
}

/**
 * 主入口：对正文生成摘要，长文自动 map-reduce。
 * @param {string} rawText
 * @param {object} settings
 * @param {{title?:string, siteName?:string, lang?:string, description?:string}} page
 * @param {(p:object)=>void} onProgress
 */
export async function summarizeWithNano(rawText, settings, page = {}, onProgress) {
  const text = normalizeSpace(rawText);
  if (text.length < 60) throw new Error('正文过短，无法摘要');

  const maxInput = Math.max(2000, settings.maxInputChars || 12000);
  const threshold = Math.max(2000, settings.mapReduceThreshold || 9000);

  const baseContext = [
    page.title ? `网页标题：${page.title}` : '',
    page.siteName ? `来源站点：${page.siteName}` : '',
    settings.outputLanguage === 'zh' ? '请用简体中文输出。' : '',
  ].filter(Boolean).join('\n');

  onProgress?.({ stage: 'creating', message: '正在准备本地模型…' });

  const summarizer = await createSummarizer({
    type: settings.summaryType,
    length: settings.summaryLength,
    format: settings.summaryFormat,
    language: settings.outputLanguage,
    context: truncate(baseContext, 400),
  }, onProgress);

  try {
    // ── 短文：一次直出 ──
    if (text.length <= threshold) {
      onProgress?.({ stage: 'summarizing', message: '本地模型正在生成摘要…' });
      const out = await withTimeout(
        runSummarize(summarizer, truncate(text, maxInput), baseContext),
        180000,
        '生成摘要'
      );
      return { summary: cleanOutput(out), engine: 'gemini-nano', chunks: 1 };
    }

    // ── 长文：先分段 tl;dr，再汇总为 key-points ──
    const n = Math.min(MAX_CHUNKS, Math.max(2, Math.ceil(text.length / threshold)));
    const chunkSize = Math.max(CHUNK_MIN, Math.ceil(text.length / n));
    const chunks = chunkByParagraph(text, chunkSize).slice(0, MAX_CHUNKS);

    onProgress?.({
      stage: 'map',
      message: `长文分 ${chunks.length} 段处理…`,
      percent: 0,
    });

    const partials = [];
    for (let i = 0; i < chunks.length; i++) {
      onProgress?.({
        stage: 'map',
        percent: Math.round(((i + 1) / chunks.length) * 100),
        message: `提炼第 ${i + 1}/${chunks.length} 段…`,
      });
      const piece = await withTimeout(
        runSummarize(summarizer, truncate(chunks[i], maxInput), `${baseContext}\n这是全文的第 ${i + 1} 部分。`),
        120000,
        `分段摘要 ${i + 1}`
      );
      if (piece && piece.trim()) partials.push(piece.trim());
    }

    if (!partials.length) throw new Error('分段摘要全部为空');

    if (partials.length === 1) {
      return { summary: cleanOutput(partials[0]), engine: 'gemini-nano', chunks: 1 };
    }

    onProgress?.({ stage: 'reduce', message: '正在合并各段要点…' });
    const merged = partials.join('\n');
    const finalOut = await withTimeout(
      runSummarize(
        summarizer,
        truncate(merged, maxInput),
        `${baseContext}\n下面是同一篇文章各部分的分段摘要，请合并去重，输出整篇的核心要点。`
      ),
      150000,
      '合并摘要'
    );

    return {
      summary: cleanOutput(finalOut),
      engine: 'gemini-nano(map-reduce)',
      chunks: partials.length,
    };
  } finally {
    try { summarizer.destroy?.(); } catch { /* noop */ }
  }
}

/** 清理模型输出里多余的包裹符号 */
function cleanOutput(str) {
  let s = String(str || '').trim();
  s = s.replace(/^(摘要|Summary|以下是[^：:\n]{0,12})[：:]\s*/i, '');
  s = s.replace(/^```[a-z]*\n/i, '').replace(/```$/, '');
  return s.trim();
}
