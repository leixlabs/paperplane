/**
 * 采集层验证：用 jsdom 造一个「正文 + 侧边栏 + 评论区」的仿真页面，
 * 检查提取器能否选中正文、剔除噪音。
 * 运行：NODE_PATH=<jsdom所在node_modules> node tests/extract.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const here = path.dirname(fileURLToPath(import.meta.url));

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <title>从零理解 Chrome 内置 AI - 技术博客</title>
  <meta property="og:site_name" content="技术博客">
  <meta property="og:description" content="Chrome 把 Gemini Nano 下沉到浏览器，扩展开发者该如何使用。">
  <meta name="author" content="张三">
  <link rel="canonical" href="https://blog.example.com/chrome-builtin-ai">
</head>
<body>
  <header class="site-header">
    <nav class="main-nav"><a href="/">首页</a><a href="/archives">归档</a><a href="/about">关于</a></nav>
  </header>

  <div class="container">
    <main>
      <article class="post">
        <h1>从零理解 Chrome 内置 AI</h1>
        <div class="post-meta">2026-10-20 · 阅读 12 分钟</div>
        <div class="post-content">
          <p>Chrome 内置 AI 的本质，是把一个约 40 亿参数的轻量模型直接塞进浏览器安装包，让网页和扩展都能在本地调用它。这意味着推理不经过任何服务器。</p>
          <p>对扩展开发者来说，最直接的变化是不再需要 API Key，也不需要为自己的密钥管理写一套后端。你只需要在 manifest 里申请权限，然后调用全局对象即可。</p>
          <p>但这里有一个很容易踩的坑：Manifest V3 的 Service Worker 没有 window 对象，而 AI 接口恰恰挂在 window 上。因此必须借助 offscreen document 这个隐藏页面来访问它们。</p>
          <p>第二个坑是模型下载。如果用户设备上还没有这个模型，第一次调用会触发一次一到两 GB 的下载，整个过程可能持续数分钟，期间调用会一直挂起。</p>
          <p>因此产品设计上必须给出进度反馈，否则用户会以为插件卡死了。比较稳妥的做法是把进度写进徽标标题，或者弹一条通知。</p>
          <p>最后是降级策略。当硬件不满足官方要求时，接口会直接返回不可用。此时合理的做法是退回到传统的抽取式摘要算法，而不是给用户抛一个错误。</p>
        </div>
      </article>

      <section class="comment-area">
        <h2>评论区（共 3 条）</h2>
        <div class="comment"><p>写得很清楚，收藏了！不过我这边 Chrome 版本还是 120，估计还得等一阵子。</p></div>
        <div class="comment"><p>请问 offscreen document 会不会常驻内存？如果常驻的话，对老机器可能不太友好。</p></div>
      </section>
    </main>

    <aside class="sidebar">
      <h3>相关阅读</h3>
      <ul>
        <li><a href="/a">Manifest V3 迁移指南</a></li>
        <li><a href="/b">Service Worker 生命周期详解</a></li>
        <li><a href="/c">Chrome 扩展的性能陷阱</a></li>
      </ul>
    </aside>
  </div>

  <footer class="site-footer"><p>© 2026 技术博客 · 京 ICP 备 000000 号</p></footer>
</body>
</html>`;

const dom = new JSDOM(HTML, { url: 'https://blog.example.com/chrome-builtin-ai' });
const { window } = dom;

// jsdom 没有实现 innerText，这里做一个接近浏览器的近似实现
const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'TR', 'BR', 'NAV']);

function innerTextOf(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      out += child.nodeValue.replace(/\s+/g, ' ');
    } else if (child.nodeType === 1) {
      const tag = child.tagName;
      const isBlock = BLOCK.has(tag);
      if (isBlock) out += '\n';
      out += innerTextOf(child);
      if (isBlock) out += '\n';
    }
  }
  return out;
}

Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
  get() { return innerTextOf(this).replace(/\n{2,}/g, '\n').trim(); },
  configurable: true,
});

// 把提取器脚本放进 jsdom 的全局环境里执行
globalThis.window = window;
globalThis.document = window.document;
globalThis.location = window.location;

const src = readFileSync(path.join(here, '../src/content/extractor.js'), 'utf8');
new Function(src)();

assert.equal(typeof globalThis.__LINK2TELE_EXTRACTOR__, 'function', '提取器未挂载到全局');
const page = globalThis.__LINK2TELE_EXTRACTOR__();

console.log('--- 提取结果 ---');
console.log('title      :', page.title);
console.log('siteName   :', page.siteName);
console.log('author     :', page.author);
console.log('lang       :', page.lang);
console.log('container  :', page.extractedFrom);
console.log('charCount  :', page.charCount);
console.log('headings   :', page.headings);
console.log('text       :\n' + page.text);
console.log('---------------');

assert.ok(page.title.includes('Chrome 内置 AI'), '标题提取错误：' + page.title);
assert.equal(page.siteName, '技术博客');
assert.equal(page.author, '张三');
assert.equal(page.lang, 'zh');
assert.ok(page.charCount > 300, '正文字数过少：' + page.charCount);
assert.ok(page.text.includes('Windows 对象') === false, 'sanity');

// 正文必须包含
assert.ok(page.text.includes('40 亿参数'), '正文首段缺失');
assert.ok(page.text.includes('降级策略') || page.text.includes('抽取式摘要'), '正文末段缺失');

// 噪音必须剔除
console.log('\n噪音检查：');
for (const noise of ['Manifest V3 迁移指南', 'ICP 备', '收藏了', '首页', '阅读 12 分钟']) {
  const hit = page.text.includes(noise);
  console.log(`  ${hit ? '✗ 泄漏' : '✓ 已剔除'}  ${noise}`);
  assert.equal(hit, false, `噪音未剔除：${noise}`);
}

console.log('\n采集层通过：正文命中、噪音剔除。\n');
