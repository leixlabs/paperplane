/**
 * 容灾降级引擎：不依赖任何 AI，纯 JS 抽取式摘要。
 *
 * 当 Gemini Nano 不可用（未下载模型、非 Chrome、设备不满足要求、
 * 或调用超时），pipeline 自动落到这里，保证「一键发送」永不断链。
 *
 * 算法：TF 加权句子打分 + 位置先验 + 标题重合度 + MMR 去冗余。
 */
import {
  splitSentences,
  termFrequency,
  termsOf,
  jaccard,
  stripMarkdown,
} from './text.js';

function titleTerms(title) {
  return termsOf(title || '');
}

function scoreSentence(sentence, index, total, freq, titleSet) {
  const terms = termsOf(sentence);
  if (!terms.size) return 0;

  let weight = 0;
  for (const t of terms) weight += Math.log(1 + (freq.get(t) || 0));

  // 长度归一（避免长句独占），但惩罚过短的句子
  const norm = weight / Math.sqrt(Math.max(6, terms.size));
  const lenPenalty = sentence.length < 20 ? 0.6 : 1;

  // 位置先验：越靠前越可能是核心论点
  const positionBoost = 1 + 0.45 * (1 - index / Math.max(1, total));

  // 与标题的关键词重合
  let overlap = 0;
  for (const t of terms) if (titleSet.has(t)) overlap++;
  const titleBoost = 1 + Math.min(0.5, (overlap / Math.max(1, terms.size)) * 1.6);

  return norm * lenPenalty * positionBoost * titleBoost;
}

/**
 * 入参兼容两种命名：插件 settings 用 summaryType / summaryLength，
 * 直接调用时也可以简写 type / length。早先只认后者，导致配置页改了类型不生效。
 */
function normalizeOpts(opts) {
  return {
    type: opts.summaryType || opts.type || 'key-points',
    length: opts.summaryLength || opts.length || 'medium',
    points: opts.points,
  };
}

const POINTS_BY_LENGTH = { short: 3, medium: 5, long: 8 };

/**
 * @param {{title?:string, description?:string, headings?:string[], text:string}} page
 * @param {{points?:number, type?:string, length?:string, summaryType?:string, summaryLength?:string}} opts
 * @returns {{summary:string, points:string[], engine:string}}
 */
export function heuristicSummary(page, opts = {}) {
  const { type, length: lengthKey, points } = normalizeOpts(opts);
  const pointsCount = points || POINTS_BY_LENGTH[lengthKey] || 5;

  const body = String(page.text || '');
  const sentences = splitSentences(body).filter((s) => s.length >= 14 && s.length <= 400);

  // 要点数随文章长度自适应：短文不该硬凑 5 条（否则压缩比接近 100%）
  const densityCap = Math.max(2, Math.ceil(sentences.length / 3));
  const count = Math.min(pointsCount, densityCap);

  const freq = termFrequency(sentences);
  const tSet = titleTerms(page.title);

  const scored = sentences.map((s, i) => ({
    s,
    i,
    score: scoreSentence(s, i, sentences.length, freq, tSet),
    terms: termsOf(s),
  }));

  scored.sort((a, b) => b.score - a.score);

  // MMR 式贪婪选择：兼顾得分与多样性
  const picked = [];
  const usedTerms = [];
  for (const cand of scored) {
    if (picked.length >= count) break;
    let dup = false;
    for (const u of usedTerms) {
      if (jaccard(cand.terms, u) > 0.42) { dup = true; break; }
    }
    if (dup) continue;
    picked.push(cand);
    usedTerms.push(cand.terms);
  }

  // 输出按原文顺序，读起来更连贯
  picked.sort((a, b) => a.i - b.i);

  const trim = (s) => {
    let t = s.replace(/\s+/g, ' ').trim();
    t = t.replace(/^[\s·•\-–—*]+/, '');
    if (t.length > 180) t = t.slice(0, 180).replace(/[，,、]$/, '') + '…';
    if (!/[。！？.!?…]$/.test(t)) t += '。';
    return t;
  };

  const bullets = picked.map((p) => trim(p.s));

  // headline：单行短标题，不带句号
  if (type === 'headline') {
    let head = trim(picked[0]?.s || page.description || page.title || '')
      .replace(/[。！？.!?…]+$/, '');
    if (head.length > 60) head = head.slice(0, 60) + '…';
    return { summary: head, points: [head], engine: 'local-heuristic' };
  }

  const clip = (s) => (s.length > 300 ? s.slice(0, 300) + '…' : s);

  // teaser：吊胃口的一两句钩子
  if (type === 'teaser') {
    const n = { short: 1, medium: 1, long: 2 }[lengthKey] || 1;
    const t = bullets.slice(0, n).join(' ');
    return {
      summary: clip(t || (page.description || '').trim()),
      points: bullets,
      engine: 'local-heuristic',
    };
  }

  // tl;dr：一句到三句的结论，优先用站点自带的 description
  if (type === 'tl;dr') {
    const n = { short: 1, medium: 2, long: 3 }[lengthKey] || 2;
    const useDesc = (page.description || '').trim().length > 40 && lengthKey !== 'long';
    const t = useDesc ? (page.description || '').trim() : bullets.slice(0, n).join(' ');
    return {
      summary: clip(t || (page.title || '')),
      points: bullets,
      engine: 'local-heuristic',
    };
  }

  // key-points（默认）
  let summary = bullets.map((b) => '• ' + b).join('\n');

  // 标题层级清单一并附上，补足结构感
  if (page.headings && page.headings.length >= 3 && lengthKey !== 'short') {
    const outline = page.headings.slice(0, 5).map((h) => '· ' + h).join('\n');
    summary += '\n\n📑 文章结构\n' + outline;
  }

  if (!summary.trim()) {
    const fallbackText = stripMarkdown(page.description || body).slice(0, 260);
    summary = fallbackText ? fallbackText + '…' : '（该页面未提取到足够的正文内容）';
  }

  return { summary, points: bullets, engine: 'local-heuristic' };
}
