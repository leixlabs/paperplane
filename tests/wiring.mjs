/**
 * 接线测试：用 chrome API 桩 + 假网页，跑完整个「点击图标 → 提取 → 摘要 → 发送」链路。
 *
 * 覆盖：
 *  - Service Worker 事件监听是否正常注册
 *  - 提取器返回值 → pipeline → 排版 → sendMessage 的数据流
 *  - 内置 AI 不可用时是否自动降级到启发式（真实场景：模型未下载）
 *  - 请求体：chat_id 归一化、parse_mode、MarkdownV2 实体、链接预览开关
 *  - 错误映射：403 权限不足给出可操作提示
 */
import assert from 'node:assert/strict';

/* ── chrome API 桩 ─────────────────────────────────────── */
const captured = { onClicked: [], onMessage: [], onCommand: [], onInstalled: [], onStartup: [] };
const badge = { texts: [], titles: [] };
let stored = {};

const mockSettings = {
  botToken: '123456789:' + 'A'.repeat(35),
  channelId: 'my_channel',
  enableAI: true,
  autoFallback: true,
  summaryType: 'key-points',
  summaryLength: 'medium',
  summaryFormat: 'markdown',
  outputLanguage: 'zh',
  maxInputChars: 12000,
  mapReduceThreshold: 9000,
  includeTitle: true,
  includeUrl: true,
  includeMeta: true,
  includeFooter: true,
  linkPreview: true,
  parseMode: 'MarkdownV2',
  notifyOnSuccess: false,
  notifyOnError: false,
};

const fakePage = {
  ok: true,
  title: 'Chrome 内置 AI 的现状与限制',
  url: 'https://blog.example.com/chrome-builtin-ai',
  siteName: '技术博客',
  author: '张三',
  description: 'Chrome 正在把 Gemini Nano 下沉到浏览器。',
  lang: 'zh',
  headings: ['背景', '能力边界', '实践建议'],
  text: [
    'Chrome 内置 AI 指的是把 Gemini Nano 这个轻量模型直接打包进浏览器，让网页和扩展可以在本地调用它。',
    '最大的好处是隐私。所有推理都在用户设备上完成，输入文本不会离开这台电脑，也不需要任何 API Key。',
    '代价是硬件门槛。官方建议设备至少拥有 4GB 显存、22GB 可用磁盘，并且需要 Chrome 127 以上版本。',
    '扩展开发者需要注意，Service Worker 里没有 window 对象，必须借助 offscreen document 才能访问这些 API。',
    '如果模型尚未下载完成，第一次调用会阻塞数分钟，产品设计上必须给出明确的进度反馈。',
    '当硬件不满足条件时，合理的做法是降级到传统的抽取式摘要，而不是直接报错。',
  ].join('\n'),
  charCount: 320,
  wordCount: 210,
  extractedFrom: 'DIV.post-content',
};

globalThis.chrome = {
  action: {
    onClicked: { addListener: (fn) => captured.onClicked.push(fn) },
    setBadgeText: async ({ text }) => { badge.texts.push(text); },
    setBadgeBackgroundColor: async () => {},
    setBadgeTextColor: async () => {},
    setTitle: async ({ title }) => { badge.titles.push(title); },
  },
  commands: { onCommand: { addListener: (fn) => captured.onCommand.push(fn) } },
  runtime: {
    onInstalled: { addListener: (fn) => captured.onInstalled.push(fn) },
    onStartup: { addListener: (fn) => captured.onStartup.push(fn) },
    onMessage: { addListener: (fn) => captured.onMessage.push(fn) },
    getURL: (p) => 'chrome-extension://fake/' + p,
    getContexts: async () => [],
    getPlatformInfo: (cb) => cb && cb({}),
    openOptionsPage: async () => {},
    sendMessage: async (msg) => {
      if (String(msg?.type || '').startsWith('L2T_AI_')) throw new Error('Could not establish connection');
      return { ok: true };
    },
  },
  storage: { local: { get: async (k) => ({ [k]: stored }), set: async () => {} } },
  offscreen: { createDocument: async () => {}, Reason: { DOM_PARSER: 'DOM_PARSER' } },
  notifications: { create: async () => {} },
  scripting: {
    executeScript: async (opts) => (opts.files ? [{}] : [{ result: fakePage }]),
  },
  tabs: { query: async () => [] },
};

/* ── 网络桩 ────────────────────────────────────────────── */
const requests = [];
let nextResponse = null;

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  requests.push({ url, body });
  const r = nextResponse || { ok: true, status: 200, payload: { ok: true, result: { message_id: 4242 } } };
  return {
    ok: r.ok,
    status: r.status,
    json: async () => r.payload,
  };
};

/* ── 加载被测模块 ──────────────────────────────────────── */
stored = mockSettings;
const sw = await import('../src/background/service-worker.js');
const { assertSendable } = await import('../src/background/pipeline.js');
const { normalizeChatId, isValidToken } = await import('../src/background/telegram.js');

assert.equal(captured.onClicked.length, 1, '未注册 action.onClicked');
assert.equal(captured.onMessage.length, 1, '未注册 runtime.onMessage');
assert.equal(captured.onInstalled.length, 1, '未注册 onInstalled');
assert.equal(captured.onStartup.length, 1, '未注册 onStartup');
console.log('  ✓ 事件监听注册完整（onClicked / onMessage / onInstalled / onStartup）');

/* ── 纯函数 ────────────────────────────────────────────── */
assert.equal(normalizeChatId('my_channel'), '@my_channel');
assert.equal(normalizeChatId('@my_channel'), '@my_channel');
assert.equal(normalizeChatId('-1001234567890'), '-1001234567890');
assert.equal(normalizeChatId('https://t.me/my_channel'), '@my_channel');
assert.equal(isValidToken('123456789:' + 'A'.repeat(35)), true);
assert.equal(isValidToken('bad-token'), false);
assert.throws(() => assertSendable({ id: 1, url: 'chrome://extensions' }), /内部页面/);
assert.throws(() => assertSendable({ id: 1, url: 'file:///a.html' }), /仅支持/);
assert.doesNotThrow(() => assertSendable({ id: 1, url: 'https://a.com/x' }));
console.log('  ✓ chat_id 归一化 / Token 校验 / 受限页面拦截');

/* ── 端到端：点击图标 ──────────────────────────────────── */
const waitFor = async (fn, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

captured.onClicked[0]({ id: 1, url: 'https://blog.example.com/chrome-builtin-ai', title: 'x' });

const done = await waitFor(() => badge.texts.includes('✓') || badge.texts.includes('ERR'));
assert.ok(done, '流程未在 6s 内结束，徽标停留在：' + badge.texts.join(' → '));

console.log('  徽标序列:', badge.texts.join(' → '));
console.log('  悬停文案:', badge.titles.slice(-1)[0]);

assert.deepEqual(badge.texts[0], '···', '首个反馈应为处理中');
assert.equal(badge.texts.includes('ERR'), false, '流程应成功，但出现 ERR：' + badge.titles.slice(-1)[0]);
assert.equal(badge.texts.includes('✓'), true, '应出现成功徽标');

/* 校验实际发出的 Telegram 请求 */
assert.equal(requests.length, 1, '应只发送 1 条消息');
const req = requests[0];
console.log('\n--- 发出的请求体 ---');
console.log('URL :', req.url);
console.log('body:', JSON.stringify(req.body, null, 2).slice(0, 900));
console.log('--------------------\n');

assert.ok(req.url.endsWith('/bot' + mockSettings.botToken + '/sendMessage'), 'API 端点错误');
assert.equal(req.body.chat_id, '@my_channel', 'chat_id 未归一化');
assert.equal(req.body.parse_mode, 'MarkdownV2');
assert.equal(req.body.link_preview_options.is_disabled, false, '首条应开启预览');
assert.ok(req.body.text.length <= 4096);

const text = req.body.text;
assert.ok(text.includes('*Chrome 内置 AI 的现状与限制*'), '标题应加粗');
assert.ok(text.includes('• '), '应包含要点圆点');
assert.ok(text.includes('🔗 https://blog\\.example\\.com'), '链接应被转义');
assert.ok(text.includes('本地启发式'), '内置 AI 不可用时应自动降级并在页脚标注');
assert.ok(!text.includes('**'), '不应残留双层星号');

// MarkdownV2 实体配平
for (const line of text.split('\n')) {
  for (const ch of ['*', '_', '~']) {
    let n = 0;
    for (let i = 0; i < line.length; i++) if (line[i] === ch && line[i - 1] !== '\\') n++;
    assert.equal(n % 2, 0, `实体不配平: ${line}`);
  }
}
console.log('  ✓ 端到端成功：AI 缺失 → 自动降级 → 请求体合规');

/* ── 错误映射：403 ────────────────────────────────────── */
requests.length = 0;
badge.texts.length = 0;
nextResponse = {
  ok: false,
  status: 403,
  payload: { ok: false, error_code: 403, description: 'Forbidden: bot is not a member of the channel chat' },
};

captured.onClicked[0]({ id: 2, url: 'https://blog.example.com/x', title: 'y' });
const done2 = await waitFor(() => badge.texts.includes('ERR'));
assert.ok(done2, '403 应打出 ERR 徽标');
const tip = badge.titles.slice(-1)[0];
console.log('  403 提示:', tip);
assert.match(tip, /管理员/, '403 应提示把 Bot 设为管理员');
console.log('  ✓ 403 权限错误映射为可操作提示');

/* ── 未配置时自动打开设置页 ───────────────────────────── */
stored = { ...mockSettings, botToken: '', channelId: '' };
badge.texts.length = 0;
let opened = false;
chrome.runtime.openOptionsPage = async () => { opened = true; };
captured.onClicked[0]({ id: 3, url: 'https://a.com' });
await waitFor(() => opened);
assert.equal(opened, true, '未配置时应打开设置页');
assert.ok(badge.texts.includes('ERR'), '未配置应提示错误徽标');
console.log('  ✓ 未配置时打开设置页并报错');

console.log('\n接线测试全部通过。\n');
process.exit(0);
