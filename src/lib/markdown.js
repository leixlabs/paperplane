/**
 * 排版层：构建 Telegram 消息（MarkdownV2）
 *
 * 关键约束：本模块产出的 MarkdownV2 **实体一律不跨行**（代码块会被摊平成
 * 普通行、加粗/斜体/链接都以行为单位闭合）。这样按行切分 4096 字符时，
 * 绝不会切坏实体导致 "can't parse entities"。
 */

const MDV2_SPECIAL = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMdV2(str) {
  return String(str ?? '').replace(MDV2_SPECIAL, '\\$1');
}

function escapeCode(str) {
  return String(str ?? '').replace(/([`\\])/g, '\\$1');
}

const PH = '\u0000';

/** 行内格式转换：先摘出实体，整体转义，再放回 */
function inline(line) {
  const stash = [];
  const put = (v) => `${PH}${stash.push(v) - 1}${PH}`;

  let s = String(line);

  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, (_, c) => put('`' + escapeCode(c) + '`'));
  // 链接
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, t, u) =>
    put('[' + escapeMdV2(t) + '](' + String(u).replace(/([)\\])/g, '\\$1') + ')')
  );
  // 加粗
  s = s.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, (_, t) => put('*' + escapeMdV2(t) + '*'));
  s = s.replace(/__(?!\s)(.+?)(?<!\s)__/g, (_, t) => put('*' + escapeMdV2(t) + '*'));
  // 斜体
  s = s.replace(/(?<![A-Za-z0-9*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![A-Za-z0-9*])/g, (_, t) => put('_' + escapeMdV2(t) + '_'));
  // 删除线
  s = s.replace(/~~(?!\s)(.+?)(?<!\s)~~/g, (_, t) => put('~' + escapeMdV2(t) + '~'));

  s = escapeMdV2(s);
  return s.replace(new RegExp(`${PH}(\\d+)${PH}`, 'g'), (_, i) => stash[Number(i)]);
}

/**
 * 把任意（AI 生成的）Markdown 转成安全的 MarkdownV2。
 * 实体不跨行、不保留围栏代码块，保证可安全分片。
 */
export function mdToTelegramV2(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inFence = false;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();

    // 围栏代码块：摊平为缩进纯文本
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (trimmed) out.push('▏' + escapeMdV2(trimmed));
      continue;
    }

    if (!trimmed) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }

    // 分隔线
    if (/^([-*_]\s*){3,}$/.test(trimmed)) continue;

    // 标题
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const text = h[2].trim();
      if (text) out.push(out.length ? '' : '', '*' + inline(text) + '*');
      continue;
    }

    // 引用
    const q = trimmed.match(/^>\s?(.*)$/);
    if (q) {
      if (q[1].trim()) out.push('▏' + inline(q[1].trim()));
      continue;
    }

    // 表格：降级为「a · b · c」
    if (/^\|.*\|$/.test(trimmed)) {
      const cells = trimmed.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // 分隔行
      out.push('· ' + cells.filter(Boolean).map((c) => inline(c)).join(' · '));
      continue;
    }

    // 列表
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const depth = Math.min(2, Math.floor(li[1].length / 2));
      const bullet = depth === 0 ? '•' : (depth === 1 ? '◦' : '▪');
      out.push('  '.repeat(depth) + bullet + ' ' + inline(li[3]));
      continue;
    }

    out.push(inline(trimmed));
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 组装完整消息（MarkdownV2）
 * @param {object} p
 */
export function buildMessage(p) {
  const {
    title, url, siteName, author, charCount, summary, engine, degraded,
    settings = {},
  } = p;

  const blocks = [];

  if (settings.includeTitle !== false && title) {
    blocks.push('*' + escapeMdV2(title.trim()) + '*');
  }

  if (settings.includeMeta !== false) {
    const metaBits = [];
    if (siteName) metaBits.push(escapeMdV2(siteName));
    if (author) metaBits.push(escapeMdV2(author));
    if (charCount) metaBits.push(escapeMdV2(charCount) + ' 字');
    if (metaBits.length) blocks.push(metaBits.join(' · '));
  }

  const body = mdToTelegramV2(summary || '');
  if (body) blocks.push('', body);

  if (settings.includeUrl !== false && url) {
    blocks.push('', '🔗 ' + escapeMdV2(url));
  }

  if (settings.includeFooter !== false) {
    const tag = degraded ? '本地启发式' : 'Gemini Nano · 本地';
    const sumLen = String(summary || '').replace(/\s/g, '').length;
    const bits = [tag];
    if (charCount && sumLen) {
      const ratio = Math.max(1, Math.round((sumLen / charCount) * 100));
      bits.push(`${charCount} → ${sumLen} 字（${ratio}%）`);
    }
    blocks.push('', '_' + escapeMdV2(bits.join(' · ')) + '_');
  }

  return blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 按行分片，保证每条 ≤ limit（默认留出 200 字符余量给 "（1/2）" 标记）
 */
export function chunkMessage(md, limit = 3900) {
  const text = String(md || '');
  if (text.length <= limit) return [text];

  const lines = text.split('\n');
  const chunks = [];
  let buf = '';

  const push = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = '';
  };

  for (const line of lines) {
    if (line.length > limit) {
      // 超长单行：硬切
      push();
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      continue;
    }
    if (buf && buf.length + line.length + 1 > limit) push();
    buf = buf ? buf + '\n' + line : line;
  }
  push();

  if (chunks.length === 1) return chunks;

  const total = chunks.length;
  return chunks.map((c, i) => {
    if (i === 0) return c;
    return `（续 ${i + 1}/${total}）\n` + c;
  });
}
