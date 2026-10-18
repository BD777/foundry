# 插件体系调研：业界做法与 Foundry 输入框文本动作

日期：2026-10-15。本文只做调研和方案建议，没有改代码。外部事实附来源；Foundry 现状附代码位置（基于 `35ec2a2`）。

触发诉求：给 Chat 输入框加“翻译”和“润色/语法检查（diff 后接受替换）”按钮；在正文或输入框中选中词句后显示释义。用户的判断是，这类需求适合做插件，不适合放进本体。

## 结论

1. **这三个功能其实是同一个原语：取一段文本（草稿或选区），套上提示词，做一次模型调用，再按某种方式呈现结果（替换并附 diff、弹出浮层、插入）。** 原语本身必须由本体提供，单个功能只是一份数据。
2. **所以第一步不是“插件体系”，而是“文本动作（Text Actions）”：本体提供插槽、受控的模型调用和结果渲染器；翻译、润色、释义作为内置预设；用户自定义动作只写声明式配置（提示词、位置、输入、输出方式、模型），不写代码。** 这对应 Minecraft 数据包、Cursor rules、Raycast/VS Code manifest 那一层，覆盖大部分“打 mod”式的个性化。
3. **在页面内执行第三方 JS 的插件，现阶段不要做。** Foundry Web 用 cookie 会话鉴权且没有 CSP（`web_static.go` 只设置了 `Cache-Control`），页面内的插件代码等于拿到用户的完整权限：可以批准工具调用、删除 workspace、读取所有对话。这还违反 `AGENTS.md` 里“不得穿透组件私有 DOM”和“推理只走 agent SDK/CLI”的规定。真需要自定义 UI 时，走 MCP Apps（沙箱 iframe）这个跨厂商标准，不自己发明协议。
4. **“像打 mod 一样自然”关键不在于代码能力有多强，而在于四件事：** 做起来便宜（写一句提示词就生效）、能分享（导出/导入、跟着 workspace 分发）、可管理（统一列表里开关、排序、看来源）、默认安全。Foundry 还有一个独有的优势：**让 Personal Agent 帮用户写动作**，比如对它说“给输入框加个按钮，把内容翻成商务日语”，就像 skill-creator 帮用户写 skill 一样。

## 业界怎么做

| 产品                       | 隔离方式                                                                                                                                                | 扩展面                                                                                                                                       | UI 由谁画                                                                                                                   | 信任与分发                                                                                                                | 值得借鉴                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code                    | 独立 extension host 进程（防卡顿，不防恶意，[权限与 VS Code 相同](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security)） | `package.json` 的 `contributes` 声明式贡献，加上激活后的命令式 API；[懒激活](https://code.visualstudio.com/api/references/activation-events) | 原生控件由宿主渲染，自定义 UI 用 [Webview iframe + postMessage](https://code.visualstudio.com/api/extension-guides/webview) | 签名、扫描、远程黑名单、Workspace Trust                                                                                   | **`vscode.lm`**：扩展调用“用户选的模型”，自己不持有凭据，首次使用需用户同意，宿主计量用量（[文档](https://code.visualstudio.com/api/extension-guides/ai/language-model)）。扩展工具调用一律弹确认框 |
| Obsidian                   | 无隔离，在主进程内运行，权限全开                                                                                                                        | 命令式：`addCommand`、`addRibbonIcon`、`editor-menu` 事件、CM6 扩展                                                                          | 插件直接操作 DOM                                                                                                            | [默认 Restricted Mode](https://obsidian.md/help/Extending+Obsidian/Plugin+security)，需用户主动开启；自动扫描加抽样人工审 | `register*` 系列让卸载可靠，生态极其繁荣；代价是只能靠信任作者                                                                                                                                      |
| Zed                        | WASM（Wasmtime + WIT），[细粒度能力授权](https://zed.dev/docs/extensions/capabilities)                                                                  | 以声明式为主（语言、主题、片段）                                                                                                             | **不能扩展 UI**                                                                                                             | 扩展注册表                                                                                                                | 扩展里的斜杠命令、ACP agent 已被移除或弃用，改走 MCP/ACP 协议注册表：**协议优先于私有扩展类型**                                                                                                     |
| JetBrains                  | 同一个 JVM                                                                                                                                              | `plugin.xml` 扩展点                                                                                                                          | 插件自己画                                                                                                                  | Marketplace                                                                                                               | [热卸载很难事后补](https://plugins.jetbrains.com/docs/intellij/dynamic-plugins.html)，从第一天就要设计卸载                                                                                          |
| Figma                      | 逻辑跑在无浏览器 API 的 JS VM 沙箱（编译成 WASM），UI 跑在 iframe                                                                                       | 小而窄的场景 API                                                                                                                             | iframe 内由插件自己画                                                                                                       | manifest 声明网络白名单                                                                                                   | [逻辑与 UI 分离，中间只有一条消息通道](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/)；Realms 方案出漏洞后换了沙箱引擎，API 不受影响                                             |
| Chrome MV3                 | content script 运行在隔离 world                                                                                                                         | manifest 权限，可选权限运行时再申请                                                                                                          | 扩展自己画                                                                                                                  | [禁止远程代码](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)，审核才有意义                    | 渐进授权；能用声明式 API 就不用任意拦截                                                                                                                                                             |
| Raycast                    | React 组件树，由自定义 reconciler 渲染成原生视图                                                                                                        | manifest 中的 commands、preferences、tools                                                                                                   | **插件描述，宿主渲染**                                                                                                      | 所有扩展经开源仓库 PR 审核，由 Raycast CI 构建                                                                            | **[`AI.ask`](https://developers.raycast.com/api-reference/ai)**：消耗用户自己的 AI 额度，扩展没有 key，宿主负责限流                                                                                 |
| Claude Code plugins / mods | 插件可执行任意代码，[明确告知需完全信任](https://code.claude.com/docs/en/plugins/security)                                                              | skills、commands、agents、hooks、MCP；mods 用中间件式 `on(event)`                                                                            | mods 向具名渲染位（`AbovePrompt` 等）提交元素树，由宿主渲染                                                                 | marketplace 固定到 commit SHA，管理员白名单                                                                               | 与“聊天型 agent 工作台的插件”[最接近的现成设计](https://code.claude.com/docs/en/plugins/mods/reference)：分层排序、单个钩子的时间预算                                                               |
| MCP Apps                   | 沙箱 iframe，无法访问父页面 DOM 和 cookie                                                                                                               | 工具声明 `ui://` 资源，经 postMessage 走 JSON-RPC                                                                                            | iframe                                                                                                                      | 宿主决定 app 能调哪些工具；[2026-01-26 规范已 Stable](https://github.com/modelcontextprotocol/ext-apps)                   | Claude、VS Code、ChatGPT 都已支持，是第三方 UI 的通用标准                                                                                                                                           |

游戏 mod 的经验：

- **分层可改性。** Minecraft 的数据包和资源包是纯数据，覆盖大多数改动，版本升级也不易坏；Fabric mixin 能深度改字节码，但兼容性成了所有人的负担。Factorio 把加载分成“声明 → 互相打补丁 → 运行”几个阶段，每个 mod 的存储独立，还有确定性沙箱（[生命周期](https://lua-api.factorio.com/latest/auxiliary/data-lifecycle.html)）。
- **冲突与顺序。** Skyrim 一旦允许改动重叠，就要靠加载顺序、依赖元数据和 LOOT 这类冲突工具来收拾。命名空间、显式排序和依赖声明要先定好。
- **受保护动作（WoW taint）。** 插件可以随意换皮、做自动化，但施法、选目标这类关键动作必须来自未被污染的、由人发起的路径。对应到 Foundry：**插件可以“提议”，但不能替用户点“批准、发送、接受”**。这和润色“展示 diff，用户点接受才替换”天然一致。

关于“DSH”：我没能确定它具体指哪个产品。上面覆盖了 Obsidian、Zed、JetBrains 等常被拿来对比的产品。如果指的是别的，告诉我再补。

## Foundry 现状（与本诉求相关）

- **输入框没有扩展位。** `AgentComposer`（`apps/web/src/components/ui/agent-composer.tsx:97-177`）的按钮是硬编码 JSX：附件、agent 选择、运行参数、发送。props 里没有动作数组，只有 `children` 能插到输入框上方。
- **斜杠菜单只能插入文本。** `slash-menu.tsx` 加上 `message-composer.tsx:118-133`，选中后插入 `/<skill> `，没有动作回调，数据只来自 skills。
- **没有任何选区处理。** 正文和输入框都不处理 `getSelection` 或右键菜单；Radix 右键菜单只用在会话列表行上。
- **草稿状态是现成的。** `use-conversation-drafts.ts` 负责草稿状态和本地持久化，“接受润色后替换草稿”可以直接走它。
- **一次性推理已有先例，但每次都是一个完整会话。** 标题生成（`chat_title_service.go` 的 `createTitleJob`）和 workspace 摘要（`workspace_digests.go:375`）都会创建一个 `AgentSession`，`Source` 为 `naming` 或 `digest`，派发到设备上，经 Claude Agent SDK / Codex SDK 执行，只带提示词、不带工具（`session-roles.ts:142-153` 的 `isPromptOnlySession`）。标题任务复用当前 Chat 的 agent、profile 和 model。**这正好满足“推理只走 agent SDK/CLI”的规定**，所以文本动作应走同一条路，新增一个 `Source`。
- **模型选择已有现成范式。** 服务端的 `ProfileDefinition`，加上 Personal Agent 的 `AssistantProfileID` / `AssistantModel`（`store/personal_agent.go:108-131`），就是“跟随 Chat 模型”或“指定服务端提供的另一个 profile + model”的现成写法。
- **已有分发体系可以复用。** skills 是服务端的不可变版本库，支持 git/npm 来源、按 workspace 绑定、按用户设默认值，由设备物化（`docs/skills.md`）。Connectors 明确不做动态加载代码（`docs/connectors.md:23`）。
- **没有通用的用户偏好表。** 偏好分散在 localStorage 和 `personal_agents.settings_json`。自定义动作要跨设备同步，就需要服务端存储。
- **安全前提。** Web 没有 CSP；会话 token 由 `policy.go` 的 `agentRouteAllowed` 白名单约束。任何第三方 UI 落地之前，都要先补 CSP。

## 建议方案：分层可改性

```
层 3  代码 + 自定义 UI    MCP Apps 沙箱 iframe（有真实需求才做；不做页面内 JS）
层 2  分享与分发          动作包随 skill 库版本化，按 workspace 绑定或个人默认
层 1  声明式文本动作      用户或 Personal Agent 写 JSON：提示词 + 位置 + 输入 + 输出 + 模型
层 0  本体原语            插槽、受控推理、结果渲染器、管理页
```

### 层 0：本体原语（必须进本体）

1. **插槽（slot），不开放 DOM。**
   - 给 `AgentComposer` 加一个 `actions` prop，由宿主渲染成统一风格的按钮或“更多”菜单。
   - 在正文和输入框加一个“选区工具条”：选中文字后出现，用 Radix Popover 的虚拟锚点定位。
   - 斜杠菜单增加一类“动作”，选中即执行，不再只是插入文本。
2. **受控推理 `runTextAction`。**
   - 服务端新增 `Source: "text-action"`，只带提示词、无工具、只读，复用 `createTitleJob` 的派发路径。
   - 模型解析规则：默认跟随当前 Chat 的 agent/profile/model；动作也可以指定某个服务端 profile + model。
   - 结果以流的形式返回给发起它的浏览器。
   - 动作本身拿不到凭据，也拿不到会话 token。对应 `vscode.lm`、Raycast `AI.ask` 的模式。
3. **结果渲染器，共三种，由本体实现：**
   - `replace-with-diff`：新旧对比；中文按 `Intl.Segmenter` 分词或按字做 diff；用户点“接受”才写回草稿，并且能撤销。
   - `popover`：浮层显示释义或翻译，带“复制 / 插入到输入框”。
   - `insert`：追加到草稿。
   - 所有写回草稿的操作都由用户点击触发（受保护动作原则）。
4. **管理入口。** 设置里放一个“文本动作”列表：开关、排序、来源（内置 / 我的 / workspace 包）、所用模型，以及一个“试运行”。

### 层 1：声明式动作（用户的 mod）

```jsonc
{
  "id": "me.polish-business-en",
  "label": "润色为商务英语",
  "icon": "sparkles",
  "placements": ["composer", "selection"],
  "input": "draft-or-selection",
  "output": "replace-with-diff",
  "model": { "follow": "chat" }, // 或 { "profileId": "...", "model": "..." }
  "prompt": "Rewrite as natural business English. Return only the text.\n\n{{text}}",
}
```

内置的三个预设：

| 预设            | 位置                     | 输入         | 输出                                             | 说明             |
| --------------- | ------------------------ | ------------ | ------------------------------------------------ | ---------------- |
| 翻译            | `composer` / `selection` | 草稿或选区   | `replace-with-diff`（输入框）、`popover`（正文） | 目标语言作为参数 |
| 润色 / 语法检查 | `composer`               | 草稿         | `replace-with-diff`                              |                  |
| 释义            | `selection`              | 选区加上下文 | `popover`                                        | 跨语言           |

用户最常见的个性化是“我要的润色风格”“我常用的目标语言”，都可以在这一层完成，不需要写代码。Personal Agent 加一个 MCP 工具（例如 `upsert_text_action`），就能“一句话造一个按钮”。

### 层 2：分享

动作包放在 skill 包里，比如作为可选文件 `foundry-actions.json`，复用现有的版本化、git/npm 来源、workspace 绑定和个人默认机制，不另建市场。命名空间沿用 `foundry-workspace:<name>` 的约定，冲突时按“个人 > workspace > 内置”的优先级处理，与斜杠菜单现有的 `composerSlashItems` 优先级逻辑保持一致的思路。

### 层 3：代码（暂缓）

只有出现“声明式确实表达不了”的需求时才做，比如自定义可视化面板，或者需要访问外部服务的交互。做法是接入 MCP Apps：在沙箱 iframe 里运行，用 CSP 声明白名单，由宿主决定 app 能调哪些工具。先补全站 CSP。**不做页面内 JS 插件**：Obsidian 模式在 Foundry 的鉴权模型下等于把账号交给插件作者。

## 你的诉求该不该“用插件体系做”

- **该进本体的：** 插槽、受控推理、diff 和浮层渲染器、管理页。这是底座，所有 mod 都依赖它，做成插件只会变成“每个插件各写一套 diff UI”。
- **该做成“数据 mod”的：** 翻译、润色、释义这三个具体功能，以及用户自己的变体。内置为预设，可以关闭、复制、修改。
- **不需要代码插件的：** 这三个诉求没有一个需要第三方代码。用代码插件体系来做，成本最高，安全面最大。

## 需要你拍板的问题

1. **延迟。** 每次动作都是派发到设备的完整 SDK 会话，冷启动耗时要实测。如果润色、翻译要做到“秒回”，可能需要在 worker 上保持预热的 prompt-only 会话。这一点要先测再定。
2. **作用域。** 自定义动作是“只属于我”（需要新建服务端用户偏好表），还是也允许 workspace 级别（随 skill 包分发）？建议两者都支持，第一期先做个人级别。
3. **计费与可见性。** 动作产生的会话是否出现在会话列表或用量里？建议像 `naming` 一样作为工具型会话，默认隐藏，但计入用量。
4. **斜杠菜单是否承载动作。** 建议承载，这样键盘用户也能触发。
