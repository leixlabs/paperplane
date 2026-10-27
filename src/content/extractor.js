/**
 * 数据采集层 · 注入式正文提取器（classic script，运行在 ISOLATED world）
 *
 * 由 background 通过 chrome.scripting.executeScript({ files }) 注入，
 * 暴露 globalThis.__LINK2TELE_EXTRACTOR__，由第二次 executeScript 调用取回结果。
 *
 * 只读 DOM，不做任何修改。算法为 Mozilla Readability 的精简版：
 *   1) 语义选择器：在文本量达标的候选里取「最内层」节点（避免把评论区/侧边栏吞进来）
 *   2) 段落打分：文本长度 + 标点密度 + 祖先加权 + 链接密度惩罚（语义选择器失效时兜底）
 *   3) 正文遍历：跳过 script/nav/footer/评论/相关阅读等噪音子树
 *   4) 行级清洗与去重
 */
(function () {
  'use strict';

  var MAX_TEXT = 60000;
  var MAX_BLOCKS = 4000;

  var POSITIVE = /(?:^|[-_ ])(article|content|post|entry|body|main|text|story|markdown|prose|detail|rich_media|articlebody)(?:$|[-_ ])/i;
  var NEGATIVE = /(comment|sidebar|footer|foot|nav|menu|advert|adsense|promo|related|share|social|recommend|banner|popup|modal|cookie|subscribe|newsletter|toolbar|breadcrumb|pagination|tag-list|meta-info|login|signup|paywall)/i;

  var BLOCK_SEL = 'p,li,blockquote,pre,td,dd,figcaption,h1,h2,h3,h4,h5,h6';
  var SEMANTIC_SEL = [
    'article',
    '[itemprop="articleBody"]',
    '.markdown-body',
    '.rich_media_content',
    '.article-content',
    '.post-content',
    '.entry-content',
    '.post-body',
    '#js_content',
    '[role="main"]',
    'main'
  ];

  var BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD',
    'BLOCKQUOTE', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'FIGURE',
    'FIGCAPTION', 'HR', 'BR', 'ADDRESS', 'DETAILS', 'SUMMARY', 'FORM', 'FIELDSET'
  ]);

  var SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'CANVAS',
    'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT',
    'NAV', 'ASIDE', 'FOOTER'
  ]);

  var NOISE_LINE = /^(分享|分享到|分享至|点赞|收藏|评论|上一篇|下一篇|相关阅读|推荐阅读|广告|本文来自|免责声明|返回顶部|加载中|阅读原文|扫码关注|关注我们|点击关注|展开全文|收起|更多|阅读全文|全文完|原创|转载|接下来播放|自动连播|稍后再看|登录后观看|立即登录|大会员|发消息|充电)\s*[:：]?$/;

  /**
   * 播放器 / 浏览器权限类的 UI 提示。这类文案在视频站上是「常驻可见文本」，
   * 一旦页面本身没有正文，就会被当成正文抓走 —— B 站那个
   * 「开启本地网络访问权限后刷新页面」就是这么混进摘要的。
   */
  var UI_HINT_LINE = /(查找并连接设备|本地网络访问权限|刷新页面即可|您可在浏览器通知中|您可以进入浏览器设置|请开启[^。]{0,10}权限后重试|您的浏览器不支持)/;

  /** 视频站：这类站点的页面正文是播放器，真正的可读内容在 meta 简介里 */
  var VIDEO_HOST = /(^|\.)(bilibili\.com|youtube\.com|youtu\.be|vimeo\.com|youku\.com|iqiyi\.com|v\.qq\.com|ixigua\.com|xigua\.video|douyin\.com|kuaishou\.com|twitch\.tv|dailymotion\.com|nicovideo\.jp)$/i;
  var VIDEO_PATH = /\/video\/|\/bangumi\/|\/shorts\/|[?&]v=|bvid=|bilibili\.com\/list/i;

  function textOf(el, cache) {
    if (!el) return '';
    if (cache.has(el)) return cache.get(el);
    var t = '';
    try {
      t = (el.innerText || '').trim();
    } catch (e) {
      t = '';
    }
    if (!t) t = (el.textContent || '').trim();
    cache.set(el, t);
    return t;
  }

  function linkDensity(el) {
    try {
      var all = (el.textContent || '').length;
      if (!all) return 1;
      var linkText = 0;
      var as = el.querySelectorAll('a');
      for (var i = 0; i < as.length; i++) linkText += (as[i].textContent || '').length;
      return Math.min(1, linkText / all);
    } catch (e) {
      return 0;
    }
  }

  function classWeight(el) {
    var sig = ((el.className && String(el.className)) || '') + ' ' + (el.id || '');
    if (!sig.trim()) return 1;
    var w = 1;
    if (POSITIVE.test(sig)) w += 0.6;
    if (NEGATIVE.test(sig)) w -= 0.75;
    return Math.max(0.15, w);
  }

  function isNoiseNode(el) {
    var sig = ((el.className && String(el.className)) || '') + ' ' + (el.id || '');
    if (!sig.trim()) return false;
    return NEGATIVE.test(sig);
  }

  function isHiddenNode(el) {
    if (el.hasAttribute && (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true')) return true;
    var style = el.getAttribute && (el.getAttribute('style') || '');
    return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
  }

  function depth(el) {
    var d = 0;
    var n = el;
    while (n && n.parentElement) { d++; n = n.parentElement; }
    return d;
  }

  /** 标题是否落在评论区/侧栏等噪音区域内 */
  function hasNoiseAncestor(el) {
    var n = el.parentElement;
    var hops = 0;
    while (n && hops < 8) {
      if (isNoiseNode(n)) return true;
      if (n.tagName === 'ASIDE' || n.tagName === 'FOOTER' || n.tagName === 'NAV') return true;
      n = n.parentElement;
      hops++;
    }
    return false;
  }

  /**
   * 正文遍历：模拟 innerText 的块级换行语义，同时跳过噪音子树。
   * 不用 innerText 是为了行为可控（可跳过评论/相关阅读），也便于测试。
   */
  function visibleText(root) {
    if (!root) return '';
    var rootLen = (root.textContent || '').length;
    var parts = [];

    var walk = function (node) {
      if (node.nodeType === 3) {
        parts.push(node.nodeValue);
        return;
      }
      if (node.nodeType !== 1) return;

      var tag = node.tagName;
      if (SKIP_TAGS.has(tag)) return;
      if (isHiddenNode(node)) return;
      if (node !== root) {
        // 只跳「占比不大」的噪音块，避免把整篇文章误杀
        var len = (node.textContent || '').length;
        if (isNoiseNode(node) && len < rootLen * 0.5) return;
      }

      var block = BLOCK_TAGS.has(tag);
      if (block) parts.push('\n');
      var child = node.firstChild;
      while (child) {
        walk(child);
        child = child.nextSibling;
      }
      if (block) parts.push('\n');
    };

    walk(root);
    return parts.join('')
      .replace(/[ \t\u00a0\u3000]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** 1) 语义选择器：取「文本量达标的候选中最内层」的那个 */
  function bySemantic(cache) {
    var cands = [];
    var seen = new Set();

    for (var i = 0; i < SEMANTIC_SEL.length; i++) {
      var nodes;
      try {
        nodes = document.querySelectorAll(SEMANTIC_SEL[i]);
      } catch (e) {
        continue;
      }
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        if (seen.has(el)) continue;
        seen.add(el);
        var t = textOf(el, cache);
        if (t.length < 220) continue;
        var ld = linkDensity(el);
        if (ld > 0.55) continue;
        cands.push({ el: el, len: t.length });
      }
    }

    if (!cands.length) return null;

    var maxLen = 0;
    for (var k = 0; k < cands.length; k++) maxLen = Math.max(maxLen, cands[k].len);
    // 只保留承载了 60% 以上正文的候选，再取最内层 —— 这样 <main> 里混着
    // 评论区时，会优先命中 <article> / .post-content
    var dominant = cands.filter(function (c) { return c.len >= maxLen * 0.6; });
    dominant.sort(function (a, b) { return depth(b.el) - depth(a.el); });
    return dominant[0].el;
  }

  /** 2) 段落打分兜底 */
  function byScoring(cache) {
    var scores = new Map();
    var blocks = document.querySelectorAll(BLOCK_SEL);
    var limit = Math.min(blocks.length, MAX_BLOCKS);

    for (var i = 0; i < limit; i++) {
      var el = blocks[i];
      var t = textOf(el, cache);
      if (t.length < 25) continue;

      var punct = (t.match(/[,，。、;；.!?！？]/g) || []).length;
      var base = 1 + Math.min(punct * 0.35, 6) + Math.min(t.length / 120, 8);

      var p = el.parentElement;
      if (p) scores.set(p, (scores.get(p) || 0) + base);
      var gp = p && p.parentElement;
      if (gp) scores.set(gp, (scores.get(gp) || 0) + base * 0.45);
    }

    var winner = null;
    var winnerScore = 0;
    scores.forEach(function (raw, el) {
      if (!el) return;
      var tag = el.tagName;
      if (tag === 'HTML' || tag === 'BODY') return;
      var len = textOf(el, cache).length;
      if (len < 160) return;

      var ld = linkDensity(el);
      if (ld > 0.5) return;

      var final = raw * (1 - ld) * classWeight(el) * Math.min(1 + len / 6000, 1.8);
      if (final > winnerScore) {
        winner = el;
        winnerScore = final;
      }
    });

    return winner;
  }

  function cleanLines(text) {
    var raw = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var prev = '';
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i].replace(/[\t\u00a0\u3000]+/g, ' ').replace(/ {2,}/g, ' ').trim();
      if (!line) {
        if (out.length && out[out.length - 1] !== '') out.push('');
        continue;
      }
      if (line.length < 2) continue;
      if (NOISE_LINE.test(line)) continue;
      if (UI_HINT_LINE.test(line)) continue;
      if (/^https?:\/\/\S+$/.test(line)) continue;
      if (line === prev) continue;
      out.push(line);
      prev = line;
    }
    var joined = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return joined.length > MAX_TEXT ? joined.slice(0, MAX_TEXT) : joined;
  }

  function meta(name) {
    var el = document.querySelector('meta[property="' + name + '"],meta[name="' + name + '"]');
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  /** 简介尾部常挂着「视频播放量 xx、弹幕量 xx」这类统计，砍掉 */
  function cleanVideoDesc(d) {
    return String(d || '')
      .replace(/[,，、;；\s]*(视频播放量|播放量|弹幕量|点赞数|投硬币枚数|硬币枚数|评论数|收藏数|转发数)[\s\S]*$/i, '')
      .trim();
  }

  /** 去掉「xxx_哔哩哔哩_bilibili」「xxx - YouTube」这类站名尾巴 */
  function stripVideoSuffix(t) {
    return String(t || '')
      .replace(/[_\-–—|\s]*(哔哩哔哩|bilibili)[_\-–—|\s]*$/i, '')
      .replace(/[_\-–—|\s]*(哔哩哔哩|bilibili)[_\-–—|\s]*$/i, '')
      .replace(/[_\-–—|\s]*YouTube[_\-–—|\s]*$/i, '')
      .trim();
  }

  /** 视频页正文：标题 + 简介（+UP 主），这是页面上唯一的可读内容 */
  function videoBodyText() {
    var parts = [];
    var t = stripVideoSuffix((meta('og:title') || document.title || '').trim());
    if (t) parts.push('视频标题：' + t);

    var up = (meta('author') || meta('article:author') || '').trim();
    if (up) parts.push('作者/UP 主：' + up);

    var d = cleanVideoDesc(meta('og:description') || meta('description') || meta('twitter:description'));
    if (d) parts.push('视频简介：' + d.slice(0, 1500));

    return parts.join('\n');
  }

  function countWords(text) {
    var cjk = (text.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) || []).length;
    var latin = (text.match(/[A-Za-z0-9'’\-]+/g) || []).length;
    return { cjk: cjk, latin: latin, total: cjk + latin };
  }

  function extract() {
    var cache = new Map();

    // ── 视频页：正文不在 DOM 里，在 meta 简介里 ──
    var host = location.hostname || '';
    var ogType = meta('og:type') || '';
    var videoPage = /^video\b/i.test(ogType) ||
      (VIDEO_HOST.test(host) && VIDEO_PATH.test(location.href || ''));

    var container = null;
    var text = '';

    if (videoPage) {
      text = cleanLines(videoBodyText());
    } else {
      container = bySemantic(cache) || byScoring(cache);
      text = container ? cleanLines(visibleText(container)) : '';

      if (text.length < 120) {
        // 兜底：容器选错时退回整页（噪音子树仍会被跳过）
        container = document.body;
        text = cleanLines(visibleText(document.body));
      }
    }

    var headings = [];
    if (!videoPage) {
      try {
        var scope = container || document;
        var hs = scope.querySelectorAll('h1,h2,h3');
        for (var i = 0; i < hs.length && headings.length < 12; i++) {
          var h = (hs[i].textContent || '').trim().replace(/\s+/g, ' ');
          if (h && h.length >= 2 && h.length <= 120 && headings.indexOf(h) === -1) headings.push(h);
        }
        // 容器选得比较内层时（如 .post-content），标题往往在外层，回退到全文档但跳过噪音区
        if (headings.length < 2) {
          var all = document.querySelectorAll('h1,h2,h3');
          for (var m = 0; m < all.length && headings.length < 8; m++) {
            if (hasNoiseAncestor(all[m])) continue;
            var hh = (all[m].textContent || '').trim().replace(/\s+/g, ' ');
            if (hh && hh.length >= 2 && hh.length <= 120 && headings.indexOf(hh) === -1) headings.push(hh);
          }
        }
      } catch (e) { /* noop */ }
    }

    var title = (meta('og:title') || meta('twitter:title') || document.title || '').trim();
    if (!title) {
      var h1 = document.querySelector('h1');
      if (h1) title = (h1.textContent || '').trim();
    }
    if (videoPage) title = stripVideoSuffix(title);

    var desc = (meta('og:description') || meta('description') || meta('twitter:description') || '').trim();

    var canonical = document.querySelector('link[rel="canonical"]');
    var url = (canonical && canonical.href) || location.href;

    var lang = (document.documentElement.getAttribute('lang') || '').toLowerCase();
    var isCJK = !lang || /^(zh|ja|ko)/.test(lang) || /[\u4e00-\u9fa5]/.test(text.slice(0, 400));
    var wc = countWords(text);

    // 视频页连简介都没有 —— 明确失败，好过把播放器 UI 当成内容发出去
    if (videoPage && text.length < 30) {
      return {
        ok: false,
        reason: '这是视频页，但页面没有可摘要的标题/简介（视频内容本身无法离线提取）',
        videoPage: true,
        title: title.slice(0, 300),
        url: url,
      };
    }

    return {
      ok: true,
      title: title.slice(0, 300),
      url: url,
      siteName: (meta('og:site_name') || location.hostname).trim(),
      author: (meta('author') || meta('article:author') || meta('og:article:author') || '').trim().slice(0, 80),
      description: desc.slice(0, 400),
      lang: isCJK ? 'zh' : (lang.split('-')[0] || 'en'),
      headings: headings,
      text: text,
      charCount: text.length,
      wordCount: wc.total,
      videoPage: Boolean(videoPage),
      contentType: meta('og:type') || '',
      extractedFrom: videoPage ? 'video-meta' : (container ? (container.tagName + (container.id ? '#' + container.id : '') +
        (container.className && typeof container.className === 'string' ? '.' + container.className.trim().split(/\s+/)[0] : '')) : 'NONE')
    };
  }

  globalThis.__LINK2TELE_EXTRACTOR__ = extract;
})();
