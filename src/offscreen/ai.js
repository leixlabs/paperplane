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

/**
 * Session 池 —— 这是「换个网页又要等一遍模型」的根治点。
 *
 * Chrome 的 on-device 模型只在第一次真正下载；之后每次 Summarizer.create()
 * 仍要把约 2GB 的权重重新加载进内存并重建执行流水线（冷启动），短则数秒、
 * 长则几十秒 —— 体感上就是「又下载了一遍」。
 *
 * 官方明确说过：Unlike the Prompt API, the Writer, Rewriter and Summarizer API
 * are designed to be reused. 它们不保留上下文，同一个 session 可以安全地用于
 * 互不相关的任务。
 *
 * 所以这里按「参数组合」缓存 session 并跨网页复用。关键点：
 *   - key 只包含 {type,length,format,language}，绝不能掺入随页面变化的内容，
 *     否则每个网页都是一个新 key，缓存等于没有；
 *   - 因此 sharedContext 不再进 create()，逐页的上下文改由 summarize(text, {context})
 *     传入（本来就在传）；
 *   - 空闲 SESSION_IDLE_MS 后才 destroy()，避免长期占内存。
 */
const sessions = new Map();
const SESSION_IDLE_MS = 10 * 60 * 1000;

function sessionKey(o) {
  return [o.type, o.length, o.format, o.language || ''].join('|');
}

/** 从 settings 推导 create() 参数（不含任何随页面变化的内容） */
function sessionOpts(settings = {}) {
  const lang = String(settings.outputLanguage || '').toLowerCase();
  return {
    type: apiType(settings.summaryType),
    length: settings.summaryLength || 'medium',
    format: settings.summaryFormat || 'markdown',
    language: SUPPORTED_OUTPUT_LANGS.has(lang) ? lang : '',
  };
}

/** 取一个 session；同参数并发调用共享同一个 create() promise */
function acquireSession(key, opt, onProgress) {
  const hit = sessions.get(key);
  if (hit) {
    if (hit.timer) {
      clearTimeout(hit.timer);
      hit.timer = null;
    }
    return hit.promise;
  }

  const promise = createSummarizer(opt, onProgress).catch((err) => {
    sessions.delete(key); // 创建失败不留坑，下次重新尝试
    throw err;
  });
  sessions.set(key, { promise, timer: null });
  return promise;
}

/** 用完后转为「空闲计时」，到点再真正释放 */
function releaseSession(key) {
  const entry = sessions.get(key);
  if (!entry || entry.timer) return;
  entry.timer = setTimeout(() => {
    try { dropSession(key); } catch { /* noop */ }
  }, SESSION_IDLE_MS);
}

/** 立即释放（session 损坏或用户改了配置时用） */
function dropSession(key) {
  const entry = sessions.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  sessions.delete(key);
  Promise.resolve(entry.promise)
    .then((s) => { try { s?.destroy?.(); } catch { /* noop */ } })
    .catch(() => {});
}

export function disposeSessions() {
  for (const key of [...sessions.keys()]) dropSession(key);
}

/**
 * Chrome 内置 AI 的 outputLanguage 白名单（由 API 报错信息给出）。
 * 传白名单外的值（zh / ko / ru …）会让整个 create() 请求 abort。
 * 中文等语言改为「不传该参数」，让模型跟随输入语言输出，效果反而更好。
 */
export const SUPPORTED_OUTPUT_LANGS = new Set(['de', 'en', 'es', 'fr', 'ja']);

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

  // outputLanguage 只接受白名单里的语言码，传别的（比如 zh）会让整个请求 abort：
  // "Unsupported Summarizer API languages were specified, and the request was aborted"
  const lang = (opt.language || '').toLowerCase();
  const canSetLang = SUPPORTED_OUTPUT_LANGS.has(lang);
  if (opt.language && !canSetLang) {
    console.warn(
      `[paperplane] outputLanguage="${opt.language}" 不在 Chrome 内置 AI 支持列表 ` +
      `[${[...SUPPORTED_OUTPUT_LANGS].join(', ')}] 中，本次不传该参数，由模型跟随输入语言输出。`
    );
  }

  // 注意：这里刻意不传 sharedContext。它是 create() 参数的一部分，
  // 一旦塞进网页标题/站点名，每个页面都会变成新的参数组合，session 缓存
  // 就失效了。逐页上下文统一走 summarize(text, { context })。
  const rich = { type, length, format, monitor };
  if (canSetLang) rich.outputLanguage = lang;

  const minimal = { type, length, format, monitor };

  const attempt = async (params) => {
    if (found.kind === 'new') return found.api.create(params);
    return found.api.create(params);
  };

  try {
    return await withTimeout(attempt(rich), 240000, '创建摘要器');
  } catch (err) {
    // 参数不被识别 / 语言不支持（旧 API 不认识 outputLanguage，新 API 拒绝白名单外语言）
    // → 一律退回最小参数集重试，别让整个 AI 调用废掉
    if (/not a valid|unrecognized|invalid|unsupported|language/i.test(String(err?.message))) {
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
    // 视频页没有正文，送进去的是标题+简介。不说清楚的话模型会当成残缺文章，
    // 输出「文章未给出足够信息」之类的废话。
    page.videoPage ? '这是一个视频页面，下面的内容是该视频的标题与简介，不是文章正文。请据此概括这个视频讲了什么。' : '',
    settings.outputLanguage === 'zh' ? '请用简体中文输出。' : '',
  ].filter(Boolean).join('\n');

  const opts = sessionOpts(settings);
  const key = sessionKey(opts);
  const reused = sessions.has(key);

  onProgress?.({
    stage: reused ? 'warm' : 'creating',
    message: reused ? '复用已加载的本地模型…' : '正在加载本地模型（之后会复用，无需重复加载）…',
  });

  const summarizer = await acquireSession(key, opts, onProgress);

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
  } catch (err) {
    // session 可能已被系统回收或进入坏状态，丢掉它，下次调用重建一个。
    // 否则一次偶发失败会把坏 session 永久留在池里。
    dropSession(key);
    throw err;
  } finally {
    releaseSession(key);
  }
}

/**
 * 预热：提前建好 session，把冷启动的等待从「点击之后」挪到「点击之前」。
 * 官方建议 —— 别等用户按下生成才初始化 session。
 */
export async function warmUp(settings, onProgress) {
  const opts = sessionOpts(settings);
  const key = sessionKey(opts);
  if (sessions.has(key)) {
    onProgress?.({ stage: 'warm', message: '本地模型已就绪' });
    return { ok: true, reused: true, key };
  }
  onProgress?.({ stage: 'creating', message: '正在预热本地模型…' });
  try {
    await acquireSession(key, opts, onProgress);
    releaseSession(key);
    return { ok: true, reused: false, key };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), key };
  }
}

/** 清理模型输出里多余的包裹符号 */
function cleanOutput(str) {
  let s = String(str || '').trim();
  s = s.replace(/^(摘要|Summary|以下是[^：:\n]{0,12})[：:]\s*/i, '');
  s = s.replace(/^```[a-z]*\n/i, '').replace(/```$/, '');
  return s.trim();
}
