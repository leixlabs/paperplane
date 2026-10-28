/**
 * 配置层：硬编码默认值 + chrome.storage.local 覆盖。
 *
 * 设计取舍：自用插件把 BOT_TOKEN / CHANNEL_ID 直接写死在这里，
 * 省掉一整套后端（Vercel / CF Workers）。若同时在 options 页里
 * 填过值，则以 storage 里的为准（方便多频道切换、临时调试）。
 */

/** ── 硬编码区：把你的 Bot 信息填在这里即可 ─────────────────── */
export const HARDCODED_BOT_TOKEN = '';
export const HARDCODED_CHANNEL_ID = '';
/** ──────────────────────────────────────────────────────── */

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Telegram 单条消息上限（UTF-16 code unit） */
export const TG_MAX_MESSAGE_CHARS = 4096;

/** 摘要引擎来源标记 */
export const ENGINE = {
  NANO: 'gemini-nano',
  NANO_MAPREDUCE: 'gemini-nano(map-reduce)',
  HEURISTIC: 'local-heuristic',
  META: 'meta-only',
};

export const DEFAULTS = {
  botToken: HARDCODED_BOT_TOKEN,
  channelId: HARDCODED_CHANNEL_ID,

  // ── AI 计算层 ──
  enableAI: true,              // 关闭则永远走启发式降级
  summaryType: 'key-points',   // key-points | tl;dr | teaser | headline
  summaryLength: 'medium',     // short | medium | long
  summaryFormat: 'markdown',   // markdown | plain-text
  outputLanguage: 'zh',        // 输出语言提示
  maxInputChars: 12000,        // 单次送入 Nano 的字符上限
  mapReduceThreshold: 9000,    // 超过则先分段 tldr 再汇总 key-points

  // ── 消息排版 ──
  includeTitle: true,
  includeUrl: true,
  includeMeta: true,           // 站点名 / 作者 / 字数
  includeFooter: true,         // 引擎来源小尾巴
  linkPreview: true,           // Telegram 网页预览卡片
  parseMode: 'MarkdownV2',

  // ── 过滤剔重 ──
  skipDuplicates: false,       // 开启后，发过的地址直接跳过不再发送
  dedupeKeepDays: 0,           // 去重有效期（天）；0 = 永久记住

  // ── 反馈 ──
  notifyOnSuccess: false,
  notifyOnError: true,
  autoFallback: true,          // AI 不可用时自动降级而非直接报错
};

// 注意：这里沿用旧名字，不要改成 paperplane。
// 改名会让已经装好插件的用户丢失已保存的 Token 与频道配置。
const STORAGE_KEY = 'link2tele.settings';

export async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** 配置是否可发送（缺 token 或频道即视为未配置） */
export function isConfigured(settings) {
  return Boolean(
    settings?.botToken &&
    settings?.botToken.trim() &&
    settings?.channelId &&
    settings?.channelId.trim()
  );
}
