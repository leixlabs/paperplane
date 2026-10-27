/**
 * 文本工具：分句、术语频率、截断、分块。SW 与 offscreen 共用。
 */

const CJK_RE = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/;

const EN_STOP = new Set((
  'a an the and or but if then than that this these those of in on at to for from by with without as is are was were be been ' +
  'being it its it\'s we you they he she i not no do does did have has had will would can could should may might must ' +
  'about into over after before more most other some such only own same so too very just also here there when where why how ' +
  'what which who whom whose all any both each few many much neither nor now our out up down off again further once ' +
  'said says say new like get got one two use used using make made'
).split(/\s+/));

export function isCJK(str) {
  return CJK_RE.test(str || '');
}

export function normalizeSpace(str) {
  return String(str || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0\u3000]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(str, max) {
  const s = String(str || '');
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

/** 去掉 markdown 语法，得到纯文本（用于计算长度、分片） */
export function stripMarkdown(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** 分句：中英混排友好 */
export function splitSentences(text) {
  const out = [];
  const paragraphs = String(text || '').split(/\n+/);
  for (const para of paragraphs) {
    const line = para.trim();
    if (!line) continue;
    let parts;
    try {
      parts = line.split(/(?<=[。！？!?])|(?<=[.])\s+(?=[A-Z0-9"'“‘(])/);
    } catch {
      parts = line.split(/[。！？!?]/);
    }
    for (const raw of parts) {
      const s = (raw || '').trim();
      if (s.length >= 8) out.push(s);
    }
  }
  return out;
}

/** 词/双字组频率表：中文用 bigram，英文用单词 */
export function termFrequency(sentences) {
  const freq = new Map();
  const bump = (k) => freq.set(k, (freq.get(k) || 0) + 1);

  for (const s of sentences) {
    const lower = s.toLowerCase();
    // 英文单词
    const words = lower.match(/[a-z][a-z'’-]{2,}/g) || [];
    for (const w of words) if (!EN_STOP.has(w)) bump(w);
    // 中文 bigram
    const cjk = lower.replace(/[^\u4e00-\u9fa5\u3040-\u30ff]/g, ' ');
    for (const seg of cjk.split(/\s+/)) {
      for (let i = 0; i + 2 <= seg.length; i++) bump(seg.slice(i, i + 2));
    }
  }
  return freq;
}

export function termsOf(sentence) {
  const lower = String(sentence).toLowerCase();
  const set = new Set();
  const words = lower.match(/[a-z][a-z'’-]{2,}/g) || [];
  for (const w of words) if (!EN_STOP.has(w)) set.add(w);
  const cjk = lower.replace(/[^\u4e00-\u9fa5\u3040-\u30ff]/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i++) set.add(seg.slice(i, i + 2));
  }
  return set;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 估算 token 量（粗略：中文 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token） */
export function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const rest = s.length - cjk;
  return Math.round(cjk + rest / 4);
}

/** 按段落边界切块，尽量不在句子中间断开 */
export function chunkByParagraph(text, chunkSize) {
  const paras = String(text || '').split(/\n{1,}/);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if (!p.trim()) continue;
    if (buf && buf.length + p.length + 1 > chunkSize) {
      chunks.push(buf.trim());
      buf = '';
    }
    if (p.length > chunkSize) {
      // 超长单段：硬切
      for (let i = 0; i < p.length; i += chunkSize) {
        const piece = p.slice(i, i + chunkSize);
        if (i + chunkSize < p.length) chunks.push(piece.trim());
        else buf = piece.trim();
      }
    } else {
      buf = buf ? buf + '\n' + p : p;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.length ? chunks : [String(text || '').trim()];
}
