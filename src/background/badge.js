/**
 * 通知层：工具栏徽标（Badge）+ 系统通知，给「一键点击」提供即时视觉反馈。
 */
const COLOR = {
  busy: '#5B8DEF',
  ok: '#22C55E',
  err: '#EF4444',
};

let resetTimer = null;

function clearReset() {
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
}

async function safe(fn) {
  try { await fn(); } catch { /* 徽标失败不该影响主流程 */ }
}

async function paint(text, color, title) {
  await safe(() => chrome.action.setBadgeBackgroundColor({ color }));
  await safe(() => chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' }));
  await safe(() => chrome.action.setBadgeText({ text }));
  await safe(() => chrome.action.setTitle({ title }));
}

/** 处理中：显示三个点，悬停看进度文案 */
export async function setBusy(title = '正在提取并摘要…') {
  clearReset();
  await paint('···', COLOR.busy, `Link2Tele · ${title}`);
}

/** 更新悬停文案但不改徽标（用于模型下载进度） */
export async function setProgress(title) {
  await safe(() => chrome.action.setTitle({ title: `Link2Tele · ${title}` }));
}

export async function setSuccess(tip = '已发送到 Telegram', { autoClearMs = 6000 } = {}) {
  clearReset();
  await paint('✓', COLOR.ok, `Link2Tele · ${tip}`);
  resetTimer = setTimeout(() => { reset().catch(() => {}); }, autoClearMs);
}

export async function setError(tip = '发送失败', { autoClearMs = 15000 } = {}) {
  clearReset();
  await paint('ERR', COLOR.err, `Link2Tele · ${tip}`);
  resetTimer = setTimeout(() => { reset().catch(() => {}); }, autoClearMs);
}

export async function reset() {
  clearReset();
  await safe(() => chrome.action.setBadgeText({ text: '' }));
  await safe(() => chrome.action.setTitle({ title: '发送到 Telegram（AI 摘要）' }));
}

export async function notify({ title, message }) {
  await safe(() =>
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title,
      message: String(message || '').slice(0, 400),
      silent: false,
    })
  );
}
