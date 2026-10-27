import { loadSettings, saveSettings } from '../background/config.js';

const $ = (id) => document.getElementById(id);
const form = $('form');

const TEXT_FIELDS = ['botToken', 'channelId', 'summaryType', 'summaryLength', 'outputLanguage'];
const NUM_FIELDS = ['maxInputChars'];
const BOOL_FIELDS = [
  'includeTitle', 'includeUrl', 'includeMeta', 'includeFooter',
  'linkPreview', 'notifyOnSuccess', 'notifyOnError', 'enableAI', 'autoFallback',
];

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function fillForm(s) {
  for (const k of TEXT_FIELDS) if (form.elements[k]) form.elements[k].value = s[k] ?? '';
  for (const k of NUM_FIELDS) if (form.elements[k]) form.elements[k].value = s[k] ?? '';
  for (const k of BOOL_FIELDS) if (form.elements[k]) form.elements[k].checked = Boolean(s[k]);
}

function collect() {
  const patch = {};
  for (const k of TEXT_FIELDS) {
    const v = form.elements[k]?.value ?? '';
    patch[k] = v.trim();
  }
  for (const k of NUM_FIELDS) {
    const n = Number(form.elements[k]?.value);
    patch[k] = Number.isFinite(n) && n > 0 ? n : 12000;
  }
  for (const k of BOOL_FIELDS) patch[k] = Boolean(form.elements[k]?.checked);
  return patch;
}

async function persist() {
  const patch = collect();
  await saveSettings(patch);
  return patch;
}

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res) throw new Error('后台没有响应，请到 chrome://extensions 重新加载插件');
  return res;
}

function busy(btn, on, label) {
  btn.disabled = on;
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.textContent = label;
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
  }
}

/* ── 初始化 ── */
const settings = await loadSettings();
fillForm(settings);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = $('statusSave');
  try {
    await persist();
    // 摘要类型/输出语言属于 session 参数，改了就丢掉旧 session 立即释放内存
    chrome.runtime.sendMessage({ type: 'L2T_AI_DISPOSE' }).catch(() => {});
    setStatus(el, '✓ 已保存', 'ok');
    setTimeout(() => setStatus(el, ''), 2500);
  } catch (err) {
    setStatus(el, '保存失败：' + err.message, 'err');
  }
});

/* ── Token 显隐 ── */
$('toggleToken').addEventListener('click', (e) => {
  const input = $('botToken');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  e.target.textContent = show ? '隐藏' : '显示';
});

/* ── 校验 Bot 身份 ── */
$('btnTestConn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const el = $('statusConn');
  busy(btn, true, '校验中…');
  setStatus(el, '正在调用 getMe…', 'busy');
  try {
    await persist();
    const res = await send({ type: 'L2T_CONNECTION_TEST' });
    if (!res.ok) throw new Error(res.message);
    setStatus(el, `✓ Bot @${res.bot.username}（${res.bot.name}）· 目标 ${res.chatId}`, 'ok');
  } catch (err) {
    setStatus(el, '✕ ' + err.message, 'err');
  } finally {
    busy(btn, false);
  }
});

/* ── 测试发送 ── */
$('btnTestSend').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const el = $('statusConn');
  busy(btn, true, '发送中…');
  setStatus(el, '正在发送测试消息…', 'busy');
  try {
    await persist();
    const res = await send({ type: 'L2T_TEST_SEND' });
    if (!res.ok) throw new Error(res.message);
    setStatus(el, `✓ 已送达（message_id=${res.messageId}），去频道看看`, 'ok');
  } catch (err) {
    setStatus(el, '✕ ' + err.message, 'err');
  } finally {
    busy(btn, false);
  }
});

/* ── 探测本地模型 ── */
$('btnProbe').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const el = $('statusAI');
  const log = $('aiLog');
  busy(btn, true, '检测中…');
  setStatus(el, '正在查询 Summarizer API…', 'busy');
  try {
    const res = await send({ type: 'L2T_PROBE_AI' });
    const chromeVer = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || '?';
    const lines = [
      `Chrome: ${chromeVer}`,
      `API 版本: ${res.apiVersion || 'n/a'}`,
      `可用性: ${res.availability || 'n/a'}`,
      `说明: ${res.message || res.error || ''}`,
      `平台: ${navigator.platform || navigator.userAgentData?.platform || '-'}`,
    ];
    log.hidden = false;
    log.textContent = lines.join('\n');

    if (res.availability === 'available') {
      setStatus(el, '✓ 模型已就绪，可离线生成摘要', 'ok');
    } else if (res.availability === 'downloadable') {
      setStatus(el, '! 模型未下载，首次点击图标会自动下载', 'busy');
    } else {
      setStatus(el, '✕ 不可用，将使用本地启发式降级', 'err');
    }
  } catch (err) {
    setStatus(el, '✕ ' + err.message, 'err');
  } finally {
    busy(btn, false);
  }
});

/* ── 高级开关联动：关闭 AI 时禁用自动降级项 ── */
function syncFallbackState() {
  const ai = form.elements.enableAI;
  const fb = form.elements.autoFallback;
  if (!ai || !fb) return;
  fb.disabled = !ai.checked;
  fb.closest('.check').style.opacity = ai.checked ? '1' : '.45';
}
form.elements.enableAI?.addEventListener('change', syncFallbackState);
syncFallbackState();
