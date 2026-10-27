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
        <div class="player-mask">
          <p>您可在浏览器通知中允许 blog.example.com 查找并连接设备请求。</p>
          <p>您可以进入浏览器设置，找到 www.blog.example.com，开启 "本地网络访问权限"。</p>
          <p>开启 "本地网络访问权限" 后刷新页面即可正常播放视频。</p>
        </div>
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

/* ── 场景 2：B 站视频页 ──────────────────────────────────
   视频页没有正文，正文在 meta 简介里。DOM 上那些「本地网络访问权限」
   之类的播放器提示绝不能被当成正文抓走。 */
const BILI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <title>在AI里抛硬币，概率是50%吗？_哔哩哔哩_bilibili</title>
  <meta name="author" content="影视飓风">
  <meta name="description" content="抛硬币你应该很熟悉，正面朝上的概率大概是50%，但如果我让AI反复抛硬币，它正面朝上的概率，还是50%吗？这听起来是个有点无厘头的问题，但它背后其实隐藏着现在科技界的巨大分水岭，这一次，我们想和你一起看看，AI投硬币这个小动作背后，到底发生了什么……, 视频播放量 7943947、弹幕量 5986、点赞数 398913、投硬币枚数 696">
  <meta property="og:type" content="video.other">
  <meta property="og:title" content="在AI里抛硬币，概率是50%吗？_哔哩哔哩_bilibili">
  <meta property="og:description" content="抛硬币你应该很熟悉，正面朝上的概率大概是50%，但如果我让AI反复抛硬币，它正面朝上的概率，还是50%吗？这听起来是个有点无厘头的问题，但它背后其实隐藏着现在科技界的巨大分水岭，这一次，我们想和你一起看看，AI投硬币这个小动作背后，到底发生了什么……, 视频播放量 7943947、弹幕量 5986、点赞数 398913、投硬币枚数 696">
  <meta property="og:site_name" content="哔哩哔哩">
  <meta property="og:url" content="https://www.bilibili.com/video/BV1Wzjg65EM6/">
  <link rel="canonical" href="https://www.bilibili.com/video/BV1Wzjg65EM6/">
</head>
<body>
  <div id="app">
    <div class="bili-player">
      <div class="player-mask">
        <p>您可在浏览器通知中允许 bilibili.com 查找并连接设备请求。</p>
        <p>您可以进入浏览器设置，找到 www.bilibili.com，开启 "本地网络访问权限"。</p>
        <p>开启 "本地网络访问权限" 后刷新页面即可正常播放视频。</p>
      </div>
    </div>
    <div class="video-info">
      <h1>在AI里抛硬币，概率是50%吗？</h1>
      <div class="up-info"><span>影视飓风</span><span>关注 1883万</span></div>
      <div class="stats"><span>794.3万</span><span>5986</span><span>39.9万</span></div>
    </div>
    <div class="recommend">
      <h3>接下来播放</h3>
      <ul>
        <li><a href="/video/BV2xx">AI可以取代我，那我的意义是？</a></li>
        <li><a href="/video/BV3xx">带着100万，我们见了成人网红</a></li>
      </ul>
    </div>
  </div>
</body>
</html>`;

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

function installInnerText(win) {
  Object.defineProperty(win.HTMLElement.prototype, 'innerText', {
    get() { return innerTextOf(this).replace(/\n{2,}/g, '\n').trim(); },
    configurable: true,
  });
}

/** 把提取器脚本放进指定 jsdom 的全局环境里执行并返回提取结果 */
const src = readFileSync(path.join(here, '../src/content/extractor.js'), 'utf8');

function runExtractor(win) {
  installInnerText(win);
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.location = win.location;
  new Function(src)();
  assert.equal(typeof globalThis.__LINK2TELE_EXTRACTOR__, 'function', '提取器未挂载到全局');
  return globalThis.__LINK2TELE_EXTRACTOR__();
}

/* ── 场景 1：文章页 ── */
const page = runExtractor(window);

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

// 噪音必须剔除（含播放器/浏览器权限类的 UI 提示）
console.log('\n噪音检查：');
for (const noise of [
  'Manifest V3 迁移指南', 'ICP 备', '收藏了', '首页', '阅读 12 分钟',
  '查找并连接设备', '本地网络访问权限', '刷新页面即可',
]) {
  const hit = page.text.includes(noise);
  console.log(`  ${hit ? '✗ 泄漏' : '✓ 已剔除'}  ${noise}`);
  assert.equal(hit, false, `噪音未剔除：${noise}`);
}

console.log('\n场景 1 通过：正文命中、噪音剔除。\n');

/* ── 场景 2：B 站视频页 ── */
const biliDom = new JSDOM(BILI_HTML, { url: 'https://www.bilibili.com/video/BV1Wzjg65EM6/' });
const vpage = runExtractor(biliDom.window);

console.log('--- B 站视频页提取结果 ---');
console.log('title      :', vpage.title);
console.log('videoPage  :', vpage.videoPage);
console.log('siteName   :', vpage.siteName);
console.log('author     :', vpage.author);
console.log('container  :', vpage.extractedFrom);
console.log('charCount  :', vpage.charCount);
console.log('text       :\n' + vpage.text);
console.log('--------------------------');

assert.equal(vpage.ok, true, '视频页应提取成功：' + vpage.reason);
assert.equal(vpage.videoPage, true, '未识别为视频页（og:type=video.other）');
assert.equal(vpage.extractedFrom, 'video-meta', '视频页应走 meta 简介，而不是 DOM 正文');
assert.equal(vpage.title, '在AI里抛硬币，概率是50%吗？', '标题应去掉 _哔哩哔哩_bilibili 尾巴');
assert.equal(vpage.author, '影视飓风');
assert.ok(vpage.charCount > 80, '视频简介过少：' + vpage.charCount);

// 简介正文必须在
assert.ok(vpage.text.includes('抛硬币'), '视频简介缺失');
assert.ok(vpage.text.includes('分水岭'), '视频简介被截断');

// 播放器 UI 与统计数字必须剔除
console.log('\n视频页噪音检查：');
for (const noise of [
  '查找并连接设备', '本地网络访问权限', '刷新页面即可',
  '视频播放量', '弹幕量', '投硬币枚数', '接下来播放', '关注 1883万',
]) {
  const hit = vpage.text.includes(noise);
  console.log(`  ${hit ? '✗ 泄漏' : '✓ 已剔除'}  ${noise}`);
  assert.equal(hit, false, `视频页噪音未剔除：${noise}`);
}

console.log('\n场景 2 通过：视频页走简介、播放器提示与统计数字已剔除。');

/* ── 场景 3：视频页连简介都没有 → 明确失败，而不是发一堆播放器 UI ── */
const emptyDom = new JSDOM(
  `<!DOCTYPE html><html lang="zh-CN"><head>
     <title>x</title><meta property="og:type" content="video.other">
   </head><body><div class="p">您可在浏览器通知中允许 a.com 查找并连接设备请求。</div></body></html>`,
  { url: 'https://vimeo.com/video/123' }
);
const epage = runExtractor(emptyDom.window);
assert.equal(epage.ok, false, '无简介的视频页应明确失败');
assert.match(epage.reason, /视频页/, '失败原因应说明是视频页');
console.log('场景 3 通过：无简介的视频页明确报出「' + epage.reason + '」');

console.log('\n采集层全部通过：文章页正文命中、视频页走简介、UI 噪音剔除。\n');
process.exit(0);
