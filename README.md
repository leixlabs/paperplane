# Link2Tele · 一键 AI 摘要推 TG

点一下浏览器工具栏图标 → 当前网页正文用 **Chrome 内置 AI（Gemini Nano）** 在本地提炼成要点 → 直接 `fetch` 到 **Telegram 频道**。

零后端、零数据库、零第三方 API Key。整条链路只有两个参与者：你的浏览器，和 `api.telegram.org`。

---

## 快速开始

**1. 装插件**

```
chrome://extensions → 打开「开发者模式」→「加载已解压的扩展程序」→ 选本目录
```

**2. 建 Bot**

Telegram 里找 `@BotFather` → `/newbot` → 拿到 `123456789:AAH...` 形式的 token。

**3. 建频道并授权（最容易漏的一步）**

- 新建一个频道
- 把刚建的 Bot **加为管理员**，勾选「发布消息」
- 频道 ID 可直接用 `@频道用户名`；私有频道用 `-100...` 数字 ID

**4. 填配置**

点插件图标右侧「详情 → 扩展程序选项」，或在 `chrome://extensions` 里点「扩展程序选项」。填 Token 和频道 ID → **测试发送** 验证链路。

也可以把 token 硬编码进 `src/background/config.js` 的 `HARDCODED_BOT_TOKEN` / `HARDCODED_CHANNEL_ID`，装完即用、不用打开设置页（自用推荐）。

**5. 用**

点图标。徽标 `···` → `✓` / `ERR`，悬停看具体原因。快捷键 `Alt+Shift+T` 可在 `chrome://extensions/shortcuts` 改。

---

## 架构

```
                        ┌──────────────────────────────────────────┐
   点击图标 / 快捷键 ──► │ Service Worker（编排层，无 DOM）          │
                        │  ① chrome.tabs 取 url/title              │
                        │  ② chrome.scripting 注入提取器            │
                        └───────────────┬──────────────────────────┘
                                        │ chrome.runtime.sendMessage
                        ┌───────────────▼──────────────────────────┐
                        │ offscreen document（有 window 的隐藏页）  │
                        │  ③ Summarizer / window.ai.summarizer     │
                        │     Gemini Nano 本地推理，数据不出设备     │
                        └───────────────┬──────────────────────────┘
                                        │ 摘要文本
                        ┌───────────────▼──────────────────────────┐
                        │ 排版层：Markdown → MarkdownV2（实体不跨行）│
                        │ 分片层：>4096 字符按行切开，首片留预览卡片 │
                        └───────────────┬──────────────────────────┘
                                        │ fetch(HTTPS)
                        ┌───────────────▼──────────────────────────┐
                        │ api.telegram.org/bot<TOKEN>/sendMessage  │
                        └───────────────┬──────────────────────────┘
                                        ▼
                                  Telegram 频道
```

### ⚠️ 与原始设计的一处必要修正

原架构图把「AI 计算层」直接放在 Service Worker 里。**这在 MV3 里跑不通**：Service Worker 没有 `window`，而 Chrome Built-in AI 的入口（`Summarizer` / `window.ai`）挂在 `window` 上。

所以中间插了一层 **offscreen document** —— 一个不可见的扩展页面，专门把 `window` 借给 AI 用。它仍然是纯本地的（`chrome-extension://` 源、无网络请求），隐私模型不变，只是多了一个 `chrome.offscreen` 权限和一次消息往返。

另外，`ai.summarizer` 是老命名。Chrome 131 起稳定为全局 `Summarizer`，代码对新旧两代 API 都做了兼容（`src/offscreen/ai.js`）。

---

## 目录结构

```
manifest.json                  MV3 清单：权限、快捷键、入口
icons/                         图标（tools/gen_icons.py 零依赖生成）

src/
├─ background/
│  ├─ service-worker.js        事件编排：点击 → 守卫 → 流水线 → 徽标反馈
│  ├─ pipeline.js              编排：提取 → 摘要 → 排版 → 发送（与 chrome.* 解耦）
│  ├─ ai-bridge.js             SW ↔ offscreen；超时控制；AI 失败自动降级
│  ├─ telegram.js              Bot API 客户端：429 重试 / 错误码映射 / Markdown 降级
│  ├─ badge.js                 徽标 + 系统通知
│  └─ config.js                硬编码默认值 + storage 覆盖
├─ content/
│  └─ extractor.js             注入页面的正文提取（Readability 精简版）
├─ offscreen/
│  ├─ offscreen.html/.js       隐藏页与消息泵
│  └─ ai.js                    Gemini Nano 调用 + map-reduce 长文摘要
├─ lib/
│  ├─ text.js                  分句 / 词频 / 分块
│  ├─ heuristic.js             纯 JS 抽取式摘要（降级引擎）
│  └─ markdown.js              Markdown → MarkdownV2 + 4096 分片
└─ options/                    配置页（原生 HTML/CSS，无框架）

tests/                         node 测试：纯逻辑 / DOM 提取 / 端到端接线
tools/gen_icons.py             零依赖 PNG 图标生成
```

---

## 关键设计决策

**1. 不用 Popup。** `chrome.action.onClicked` 直接触发，省掉「打开弹窗 → 再点一次」。代价是没有 UI 承载结果，所以用徽标（`···` / `✓` / `ERR`）+ 悬停文案 + 可选系统通知三重反馈。

**2. 权限最小化。** 只要 `activeTab`（点击时临时授权当前页）+ `scripting` + `offscreen` + `storage` + `notifications`，`host_permissions` 仅 `api.telegram.org`。不申请 `<all_urls>`，安装时不会看到「读取你在所有网站上的数据」。

**3. 正文提取不用 innerText。** 自己遍历 DOM（`visibleText`），跳过 `script/nav/footer/aside` 以及 class 命中 `comment|related|sidebar|share|promo…` 的子树。容器选择是「文本量达标的候选里取最内层」——否则 `<main>` 会把评论区一起吞进来（这个 bug 是被 `tests/extract.mjs` 抓出来的）。

**4. 长文 map-reduce。** 超过 9000 字符先按段落切块、逐块出 `tldr`，再把各段摘要合并成 `key-points`。Nano 的上下文窗口很小，直接塞长文会静默截断。

**5. MarkdownV2 实体不跨行。** 这是分片的前提。AI 输出的代码围栏会被摊平成普通行、表格降级成 `· a · b`，保证任何一行单独切出去都是合法实体，不会触发 Telegram 的 `can't parse entities`。

**6. 三层容灾，几乎不会「点了没反应」。**

| 情况 | 行为 |
|---|---|
| Nano 就绪 | 按配置的 `summaryType` 出摘要，页脚标 `Gemini Nano · 本地` |
| 模型未下载 / 硬件不支持 / 调用超时 | 自动降级到 TF 打分抽取式摘要，页脚标 `本地启发式`；四种类型同样会被复现，但输出语言沿用原文（无法翻译） |
| 用户关掉了内置 AI | 直接走启发式，秒出结果 |
| MarkdownV2 解析失败 | 去掉 `parse_mode` 重发纯文本，宁可丢格式不丢内容 |
| 429 限流 | 按 `retry_after` 等待后重试一次 |
| 消息超长 | 按行分片，首片带预览卡片 |

**7. 硬编码 Token 的取舍。** 自家插件写死 token 免了整条后端链路，但要知道：token 明文存在扩展目录里，能被同机进程读到；`chrome.storage.local` 同样是明文。别把带这个 token 的 crx 传给别人。

---

## 排错

| 现象 | 原因 |
|---|---|
| 徽标 `ERR` + 「Bot 无权…（403）」 | Bot 没被设为频道管理员，或没勾「发布消息」 |
| 「频道不存在（chat not found）」 | 频道 ID 写错，或 Bot 没被加进频道 |
| 「仅支持 http / https 网页」 | 在 `chrome://`、扩展商店、PDF 阅读器上点了图标 |
| 「正文过短」 | 不是文章页（首页/列表页），或正文在跨域 iframe 里 |
| 一直显示 `···` 且模型没反应 | 首次调用在下载模型（1~2GB），看悬停文案的百分比 |
| 模型始终 `unavailable` | `chrome://flags/#optimization-guide-on-device-model` 设 `Enabled BypassPerfRequirement`，再去 `chrome://components` 更新 *Optimization Guide On Device Model*；需 Chrome 127+、磁盘 ≥22GB、显存 ≥4GB |

自检：设置页 →「检测本地模型」，会打印 Chrome 版本、API 代次、可用性。

---

## 测试

```bash
node tests/smoke.mjs     # 转义 / 排版 / 4096 分片 / 降级摘要
node tests/extract.mjs   # 需 jsdom：真实 DOM 上验证正文命中与噪音剔除
node tests/wiring.mjs    # chrome 桩 + 假网页，跑完整点击链路并校验请求体
```

`wiring.mjs` 会打印实际发往 Telegram 的 JSON，改排版逻辑后拿它当快照看最直观。

---

## 隐私

- 网页正文只在本机内存里存在，唯一的出境数据是最终摘要 + 标题 + 链接。
- 不发任何遥测，不引第三方 CDN，无远程脚本。CSP 保持 MV3 默认。
- 唯一的外部请求：`POST https://api.telegram.org/bot<TOKEN>/sendMessage`。
