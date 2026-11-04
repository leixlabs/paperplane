/**
 * 通知层：工具栏徽标（Badge）+ 系统通知，给「一键点击」提供即时视觉反馈。
 */
const COLOR = {
  busy: '#5B8DEF',
  ok: '#22C55E',
  err: '#EF4444',
  skip: '#64748B',
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

/**
 * 徽标写入串行化：paint 内部有 4 个 await，队列模式下一批任务会连续改徽标，
 * 交叉执行会出现「背景色是新的、文案还是旧的」这种撕裂状态。
 */
let paintChain = Promise.resolve();

function paint(text, color, title) {
  paintChain = paintChain.then(async () => {
    await safe(() => chrome.action.setBadgeBackgroundColor({ color }));
    await safe(() => chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' }));
    await safe(() => chrome.action.setBadgeText({ text }));
    await safe(() => chrome.action.setTitle({ title }));
  });
  return paintChain;
}

/** 处理中：显示三个点（队列里有多篇时显示 1/3 这样的进度），悬停看进度文案 */
export async function setBusy(title = '正在提取并摘要…', text = '···') {
  clearReset();
  await paint(text, COLOR.busy, `Paperplane · ${title}`);
}

/** 更新悬停文案但不改徽标（用于模型下载进度 / 队列里的提示） */
export function setProgress(title) {
  paintChain = paintChain.then(() => safe(() => chrome.action.setTitle({ title: `Paperplane · ${title}` })));
  return paintChain;
}

export async function setSuccess(tip = '已发送到 Telegram', { autoClearMs = 6000, text = '✓' } = {}) {
  clearReset();
  await paint(text, COLOR.ok, `Paperplane · ${tip}`);
  resetTimer = setTimeout(() => { reset().catch(() => {}); }, autoClearMs);
}

export async function setError(tip = '发送失败', { autoClearMs = 15000, text = 'ERR' } = {}) {
  clearReset();
  await paint(text, COLOR.err, `Paperplane · ${tip}`);
  resetTimer = setTimeout(() => { reset().catch(() => {}); }, autoClearMs);
}

/** 去重命中：不是错误，用中性灰 + SKIP 区分，悬停看是哪天发过的 */
export async function setSkipped(tip = '该地址已发送过，已跳过', { autoClearMs = 6000, text = 'SKIP' } = {}) {
  clearReset();
  await paint(text, COLOR.skip, `Paperplane · ${tip}`);
  resetTimer = setTimeout(() => { reset().catch(() => {}); }, autoClearMs);
}

export function reset() {
  clearReset();
  paintChain = paintChain.then(async () => {
    await safe(() => chrome.action.setBadgeText({ text: '' }));
    await safe(() => chrome.action.setTitle({ title: 'Paperplane · 发送到 Telegram（AI 摘要）' }));
  });
  return paintChain;
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
