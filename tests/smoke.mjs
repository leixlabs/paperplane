/**
 * 冒烟测试：只覆盖不依赖浏览器的纯逻辑（排版 / 降级摘要 / 分片）。
 * 运行：node tests/smoke.mjs
 */
import assert from 'node:assert/strict';

import {
  escapeMdV2, mdToTelegramV2, buildMessage, chunkMessage,
} from '../src/lib/markdown.js';
import { heuristicSummary } from '../src/lib/heuristic.js';
import { splitSentences, chunkByParagraph, stripMarkdown } from '../src/lib/text.js';

let pass = 0;
const ok = (name) => { pass++; console.log('  ✓ ' + name); };

/* ── 1. 转义 ───────────────────────────────────────────── */
{
  assert.equal(escapeMdV2('a.b_c*d'), 'a\\.b\\_c\\*d');
  assert.equal(escapeMdV2('100%'), '100%');            // % 不是特殊字符
  assert.equal(escapeMdV2('https://x.com/a?b=1'), 'https://x\\.com/a?b\\=1');
  ok('escapeMdV2 转义特殊字符');
}

/* ── 2. Markdown → MarkdownV2 ──────────────────────────── */
{
  const ai = `## 核心结论
这是一段**加粗**和 *斜体* 的说明，含 1.5 倍、50% 数据。

- 第一点：React 19 引入 Actions
- 第二点：\`useOptimistic\` 简化乐观更新
  1. 嵌套条目
> 引用一句话

| 项 | 值 |
| --- | --- |
| 性能 | +12% |

\`\`\`js
const a = 1 * 2;
\`\`\`

见 [官方博客](https://react.dev/blog?a=1)。`;

  const v2 = mdToTelegramV2(ai);
  console.log('\n--- MarkdownV2 预览 ---\n' + v2 + '\n----------------------\n');

  // 实体必须成对且不跨行
  for (const line of v2.split('\n')) {
    for (const ch of ['*', '_', '~']) {
      let n = 0;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === ch && line[i - 1] !== '\\') n++;
      }
      assert.equal(n % 2, 0, `行内 ${ch} 数量为奇数: ${line}`);
    }
  }
  ok('MarkdownV2 实体成对、不跨行');

  assert.ok(v2.includes('• 第一点'), '列表转圆点');
  assert.ok(v2.includes('1\\.5'), '数字点号被转义');
  assert.ok(!v2.includes('```'), '围栏被摊平');
  assert.ok(v2.includes('[官方博客](https://react.dev/blog?a=1)'), '链接保留');
}

/* ── 3. 完整消息组装 ───────────────────────────────────── */
{
  const md = buildMessage({
    title: 'React 19 正式发布：Actions 与乐观更新',
    url: 'https://react.dev/blog/2024/12/05/react-19',
    siteName: 'react.dev',
    author: 'React Team',
    charCount: 4200,
    summary: '- 要点一，包含 100% 的改动\n- 要点二',
    engine: 'gemini-nano',
    degraded: false,
    settings: { includeTitle: true, includeUrl: true, includeMeta: true, includeFooter: true },
  });
  assert.ok(md.startsWith('*React 19'), '标题加粗打头');
  assert.ok(md.includes('react\\.dev · React Team · 4200 字'), '元信息行');
  assert.ok(md.includes('🔗 https://react\\.dev'), '链接行');
  ok('buildMessage 组装完整消息');
}

/* ── 4. 4096 分片 ──────────────────────────────────────── */
{
  const long = Array.from({ length: 300 }, (_, i) => `• 第 ${i + 1} 条要点：这是一段用于验证分片逻辑的中文内容，包含标点、数字 3.14 与英文 words。`).join('\n');
  const chunks = chunkMessage(long, 3900);
  assert.ok(chunks.length > 1, '应产生多片');
  for (const c of chunks) {
    assert.ok(c.length <= 4096, `分片超长: ${c.length}`);
    for (const line of c.split('\n')) {
      let n = 0;
      for (let i = 0; i < line.length; i++) if (line[i] === '*' && line[i - 1] !== '\\') n++;
      assert.equal(n % 2, 0, '分片后实体仍成对');
    }
  }
  assert.ok(chunks[1].startsWith('（续 2/'), '续片带序号');
  ok(`chunkMessage 分片 ${chunks.length} 片，每片 ≤ 4096 且实体完整`);
}

/* ── 5. 分句 / 分块 ────────────────────────────────────── */
{
  const s = splitSentences('这是第一句完整的话，长度足够。这是第二句话，同样不短！Is this third sentence? Yes, that is.');
  assert.ok(s.length >= 4, `中英混排分句，实得 ${s.length}: ${JSON.stringify(s)}`);
  const chunks = chunkByParagraph('a'.repeat(50) + '\n\n' + 'b'.repeat(50), 60);
  assert.equal(chunks.length, 2);
  ok('splitSentences / chunkByParagraph');
}

/* ── 6. 启发式降级摘要 ─────────────────────────────────── */
{
  const article = {
    title: 'Chrome 内置 AI 的现状与限制',
    description: 'Chrome 正在把 Gemini Nano 下沉到浏览器，但硬件门槛仍然存在。',
    headings: ['背景', '能力边界', '实践建议'],
    text: [
      'Chrome 内置 AI 指的是把 Gemini Nano 这个轻量模型直接打包进浏览器，让网页和扩展可以在本地调用它。',
      '最大的好处是隐私。所有推理都在用户设备上完成，输入文本不会离开这台电脑，也不需要任何 API Key。',
      '代价是硬件门槛。官方建议设备至少拥有 4GB 显存、22GB 可用磁盘，并且需要 Chrome 127 以上版本。',
      '目前 Summarizer API 支持 key-points、tldr、teaser、headline 四种输出类型，每种都支持三档长度。',
      '扩展开发者需要注意的是，Service Worker 里没有 window 对象，因此必须借助 offscreen document 才能访问这些 API。',
      '如果模型尚未下载完成，第一次调用会阻塞数分钟，产品设计上必须给出明确的进度反馈。',
      '当硬件不满足条件时，合理的做法是降级到传统的抽取式摘要，而不是直接报错。',
    ].join('\n'),
  };

  const h = heuristicSummary(article, { type: 'key-points', length: 'medium' });
  console.log('\n--- 启发式降级摘要 ---\n' + h.summary + '\n---------------------\n');
  assert.ok(h.points.length >= 3, '至少 3 个要点');
  assert.ok(h.summary.includes('•'), '要点以圆点开头');
  assert.equal(h.engine, 'local-heuristic');

  const tl = heuristicSummary(article, { type: 'tl;dr' });
  assert.ok(tl.summary.length > 10 && tl.summary.length <= 320, 'tl;dr 长度合理');

  const empty = heuristicSummary({ title: 'x', text: '' }, {});
  assert.ok(empty.summary.length > 0, '空正文也给出兜底文案');
  ok('heuristicSummary 三条路径（key-points / tl;dr / 空正文）');
}

/* ── 7. stripMarkdown ──────────────────────────────────── */
{
  const plain = stripMarkdown('**粗** 与 `代码` 和 [链接](http://a.b)\n- 列表');
  assert.equal(plain.includes('**'), false);
  assert.ok(plain.includes('粗'));
  ok('stripMarkdown 去语法，供字数统计');
}

/* ── 8. 摘要类型 / 长度配置必须生效（降级引擎） ────────── */
{
  // 12 句，足够让 short / medium / long 拉出差距
  const art = {
    title: '浏览器端推理的取舍',
    description: '',
    headings: [],
    text: [
      '把推理放到浏览器端，最直接的收益是数据不再离开用户的设备，隐私合规的压力一下子小了很多。',
      '其次是延迟。省掉一次跨地域的网络往返之后，交互式功能的响应时间可以从几百毫秒降到几十毫秒。',
      '成本结构也随之改变：原本按调用量计费的云端 GPU，变成了用户自己承担的一次性硬件折旧。',
      '但这套模型有个前提，就是用户的机器得跑得动，否则体验会比云端方案更糟而不是更好。',
      '端侧模型的体积目前仍然受限，参数量上不去，复杂推理和长上下文的任务还扛不住。',
      '另一个麻烦是版本碎片化，不同浏览器、不同操作系统下可用的算子集合并不一致，兼容性测试成本很高。',
      '离线场景是端侧推理无可替代的优势，飞机上、内网里、弱网环境下都能稳定工作。',
      '能耗也需要认真评估，长时间跑模型会让笔记本电池明显掉电，移动设备上尤其敏感。',
      '从工程角度看，模型文件的分发和更新是一整套独立的基建，增量更新和回滚都得自己实现。',
      '安全方面，端侧意味着模型权重会落到用户磁盘上，逆向和提取的风险需要提前考虑。',
      '比较务实的路线是端云协同：简单高频的任务走端侧，复杂长尾的任务仍然回落到云端。',
      '最终判断标准还是用户价值，如果端侧只是让架构变复杂而体验没有提升，那就不值得做。',
    ].join('\n'),
  };

  const kp = heuristicSummary(art, { summaryType: 'key-points', summaryLength: 'medium' });
  const tldr = heuristicSummary(art, { summaryType: 'tl;dr', summaryLength: 'short' });
  const teaser = heuristicSummary(art, { summaryType: 'teaser', summaryLength: 'short' });
  const head = heuristicSummary(art, { summaryType: 'headline', summaryLength: 'short' });

  console.log('\n[类型] key-points →\n' + kp.summary.slice(0, 80));
  console.log('[类型] tl;dr      → ' + tldr.summary.slice(0, 80));
  console.log('[类型] teaser     → ' + teaser.summary.slice(0, 80));
  console.log('[类型] headline   → ' + head.summary.slice(0, 80));

  assert.ok(kp.summary.startsWith('•'), 'key-points 应输出圆点列表');
  assert.equal(tldr.summary.includes('•'), false, 'tl;dr 不该输出圆点列表（配置未生效）');
  assert.equal(teaser.summary.includes('•'), false, 'teaser 不该输出圆点列表（配置未生效）');
  assert.equal(head.summary.includes('•'), false, 'headline 不该输出圆点列表（配置未生效）');
  assert.equal(head.summary.includes('\n'), false, 'headline 必须是单行');
  assert.ok(head.summary.length <= 62, `headline 过长: ${head.summary.length}`);

  const shortPts = heuristicSummary(art, { summaryType: 'key-points', summaryLength: 'short' }).points.length;
  const longPts = heuristicSummary(art, { summaryType: 'key-points', summaryLength: 'long' }).points.length;
  console.log(`[长度] short=${shortPts} 条  long=${longPts} 条`);
  assert.ok(longPts > shortPts, `长度配置未生效：short=${shortPts}, long=${longPts}`);
  assert.equal(shortPts, 3, 'short 应为 3 条');

  ok('摘要类型与长度配置在降级引擎上生效');
}

/* ── 9. outputLanguage 白名单（Chrome 内置 AI） ────────── */
{
  const base = {
    summaryType: 'key-points', summaryLength: 'medium', summaryFormat: 'markdown',
    maxInputChars: 12000, mapReduceThreshold: 9000,
  };
  const text = '这是一段足够长的中文正文，用来触发一次真实的摘要调用。'.repeat(30);

  const calls = [];
  const stubApi = (onCreate) => {
    globalThis.Summarizer = {
      availability: async () => 'available',
      create: async (opts) => {
        calls.push(opts);
        return onCreate(opts);
      },
    };
  };
  const okSession = () => ({ summarize: async () => '• 要点一\n• 要点二', destroy() {} });

  const ai = await import('../src/offscreen/ai.js');

  // zh 不在白名单 → 绝不能传 outputLanguage，否则请求直接 abort
  calls.length = 0;
  stubApi(async () => okSession());
  await ai.summarizeWithNano(text, { ...base, outputLanguage: 'zh' }, { title: '标题' });
  assert.equal(calls[0].outputLanguage, undefined, 'zh 不应出现在参数里');
  assert.ok(calls[0].sharedContext.includes('简体中文'), 'zh 应改用 sharedContext 提示');

  // en 在白名单 → 正常传
  calls.length = 0;
  await ai.summarizeWithNano(text, { ...base, outputLanguage: 'en' }, { title: '标题' });
  assert.equal(calls[0].outputLanguage, 'en', 'en 应正常传递');

  // 严格校验拒绝 outputLanguage → 应自动去掉参数重试，而不是整个失败
  calls.length = 0;
  stubApi(async (opts) => {
    if (opts.outputLanguage) {
      throw new Error('Unsupported Summarizer API languages were specified, and the request was aborted.');
    }
    return okSession();
  });
  const res = await ai.summarizeWithNano(text, { ...base, outputLanguage: 'en' }, { title: '标题' });
  assert.equal(calls.length, 2, '应在去掉 outputLanguage 后重试一次');
  assert.equal(calls[1].outputLanguage, undefined, '重试时不应再带 outputLanguage');
  assert.ok(res.summary.includes('要点'), '重试后应拿到摘要');

  delete globalThis.Summarizer;
  ok('outputLanguage 白名单 + 语言报错自动重试');
}

console.log(`\n全部通过：${pass} 组断言\n`);
