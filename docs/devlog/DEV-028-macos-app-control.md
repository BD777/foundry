# DEV-028 — macOS 指定 App / 窗口控制

状态：本地实现与检查通过，尚未部署本项或完成正向无抢占验收。最新目标按用户备用授权回到已解锁 MacBook；Mac mini 锁屏且无人可授权，已停止其操作。MacBook 启动前采样中止，待可归因的短暂基线验收窗口。

## 已定位的问题

1. `resources/providers/cua-driver.ts` 的远程后端是 `cua-driver mcp`，每租约一个 MCP transport。现有 pid/window_id、element_token、delivery_mode 已存在，不需要重造输入系统。
2. 旧映射对 drag 无条件写入 `delivery_mode:foreground`；0.34.0、0.35.2 上游原本会拒绝后台拖拽。这是明确的集成层抢占路径。其他动作省略 mode 时，这两版上游默认仍为 background，不能把所有抢占归因于“没传后台参数”。
3. 旧 MCP 描述直接承诺除 activate/drag 以外均后台且不动指针；真实后端只保证尝试某条输入路径，目标 App 可能忽略事件、主动激活、弹出菜单或抢键盘焦点。成功响应不等于 UI 生效。
4. `convertToolResult` 在 isError 时丢弃 structuredContent，把 background_unavailable、effect、escalation 折成 backend_error。set_value 原先还接收上游 schema 不支持的 delivery_mode、未要求 element_token。
5. native_session 的 foundry-worker/screencapture/osascript 与 remote_ops 的 CuaDriver 是不同能力。资源就绪不能证明任意本机 shell 操作都具备相同后台保证。

## 六个独立边界

| 边界          | 证据与结论                                                           | 交付承诺范围                          |
| ------------- | -------------------------------------------------------------------- | ------------------------------------- |
| 指定窗口采集  | ScreenCaptureKit 支持筛选采集内容；用户截图只证明共享窗口            | 窗口捕获不等于窗口输入                |
| 后台输入      | AX 语义动作、PID 定向事件、应用专有接口有不同覆盖                    | 后端效果必须单独观察                  |
| 鼠标指针      | PID 路由与全局 HID 不同；旧 drag 强制前台                            | 不自动把后台请求升级为前台            |
| 键盘焦点      | 目标 App 可以主动抢焦点；driver 含焦点恢复逻辑                       | 指针没动不作为键盘未抢占证据          |
| 前台 App/窗口 | 前台事件即使随后恢复也曾打断用户                                     | 需明确 foreground 参数与用户允许      |
| 剪贴板        | type_text 不应由 Foundry改成粘贴；用户要求的复制快捷键自身会改剪贴板 | 只测 changeCount/是否变化，不记录内容 |

Apple [AXUIElementPerformAction](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction) 是请求可访问对象执行其支持的动作，可能返回 actionUnsupported、invalidUIElement、cannotComplete。Apple [CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent) 提供面向 PID 的事件接口；没有据此推导任意应用保证接受后台输入。Apple [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos) 是采集机制，不是独立鼠标或输入注入机制。

上游按实际已安装版本固定读取：

- [0.34.0 b0968e1](https://github.com/trycua/cua/tree/b0968e1b12834e485dda68789541a3cc57664a9f/libs/cua-driver/rust/crates/platform-macos/src)
- [0.35.2 ad694f8](https://github.com/trycua/cua/tree/ad694f82aaaa12e67257e4510837fc1f6cfc9484/libs/cua-driver/rust/crates/platform-macos/src)

`tools/drag.rs` 两版均默认拒绝后台拖拽；`cua-driver-core/src/delivery.rs` 仅显式 foreground 才前台；`input/skylight.rs` 使用动态解析的私有 SkyLight SPI，缺失时退到公共 PID 投递，不能把它包装成 Apple 稳定公开保证。新版 main 文档可能已有不同拖拽支持，不能套用到已安装版本。未推测 Codex/ChatGPT 私有实现。

## 最小实现（本地检查通过，待实机验证）

- 在原 operate_resource 增加 select_window，仍受原资源 lease、generation、操作串行化、能力发现管理。仅新 Mac cua-driver detector 标记 `details.windowScope=v1` 的资源展示它，旧 Worker/其他平台不伪报支持。
- 选择 exact pid/window_id 后，后续窗口操作自动继承；显式冲突目标拒绝。选择失败清除原目标，不保留一个用户以为已替换的窗口。
- 读取 AppKit launchDate+bundle identity，执行前检查进程身份和 live WindowServer 窗口归属。关闭、重启、隐藏/最小化/其他 Space 时拒绝，不自动激活。此为调用前检查，非内核原子绑定；检查后发生的进程/窗口变化仍需上游 AX/窗口校验，不能声称消除所有 TOCTOU。
- 像素坐标绑定窗口最新截图的 frameId；输入后、窗口几何变化、30秒过期或新的观察未返回图像后要求重拍。负坐标显示器的窗口位置保留，不自行重缩放。窗口像素到屏幕点仍交给 driver。
- 默认显式 background，drag 不自动 foreground；activate_window 要求显式 foreground。set_value 保持语义后台接口。不自动复制粘贴。
- 后端错误 code 与 structured evidence 保留，成功时保留 effect/verified，明确 transport success 不等于效果验证。
- 无选择的 screenshot 必须给 pid/window_id 或显式 scope:desktop；已选窗口不能退到桌面。provider 会话异常重建后重新选窗，不把空目标解释成桌面。

## 第一阶段设备调查（10月20日）

| 设备             | 只读证据                                                                                    | 输入实验                                                 |
| ---------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| CanWendeMac-mini | 实际 run：macOS 26.5.2 (25F84)，cua-driver 0.35.2，daemon_running=false，TCC status unknown | 未启动 daemon、未弹权限框、未操作窗口                    |
| macbook          | resource inventory：cua-driver 0.34.0，permitted；不是本轮输入实测                          | 联合 lease 成功后 operate 间歇 not_found，未启动测试 App |

当时跨接口读异常已交 DEV024 owner（现已恢复，见下方10月21日记录）。mini compute lease 明确 released；macbook compute/screen 两租约也已收到 state=released 回执。此故障不是 TCC 拒绝，不要求用户重新授权。未保存其他 App 桌面截图或读取剪贴板内容。

已准备 `/tmp/dev028-probe.swift`：专用 AppKit 窗口含文本、计数按钮、滚动内容，orderBack，不调用 activate/makeKey，5 分钟自行退出。准备记录指针、frontmost、剪贴板 changeCount 和目标控件变化；已补只读全局键盘焦点采样（无法读取则报告unknown），并行专用窗口验证仍待实机。该阶段未在 Mac 编译/运行；后续已编译并启动，具体边界见10月21日记录，仍无正向输入通过证据。

## 验证与部署记录

- `scripts/check-changed.sh --files <本项13文件>` 通过：格式、协议构建/测试、Web类型、Worker构建/3个相关测试文件、Go资源包与HTTP能力测试、contract/modules审计（130.3s）。
- 后续失效截图/滚动升级保护定向复验：Worker重新构建，`resource-operations.test.mjs` + `macos-window-scope.test.mjs` **32/32通过**；Go `TestWindowSelectionRequiresMacWorkerCapability`、`TestMacRollingUpgradeDoesNotUseOldImplicitForegroundOrDesktop`、`TestSessionLeasesAndOperatesAScreen` 通过。覆盖默认投递、前台显式要求、作用域、PID 替换、关闭窗口、旧 element token、最小化/其他 Space、移动窗口、旧帧、reset 后不退桌面、后台拒绝终止batch且不重试前台。
- Server对Mac输入显式补background，旧Worker原drag会拒绝未知参数而非强制前台；旧Worker不支持选窗时，空截图目标不再退桌面。这是滚动升级安全保护，不等于旧Worker获得新窗口作用域。
- 第一阶段 Server 常规重启曾由 DEV024 保留故障现场而暂缓；DEV027 已释放公共源码/构建，operate_resource 对象已精确交接；其其他 schema 与 skill 修改保留。
- 新源码尚未进入目标 Mac 实际加载的 Worker。未宣称部署完成。

## 仍需实际验收

在允许的专用 App 窗口，通过真实 lease 测 AX 点击/文本/滚动，并独立观察效果、鼠标、全局键盘焦点、frontmost 与剪贴板 changeCount。测试用户在另一个专用窗口交互时是否仍成功；遮挡、最小化、AX 缺失、权限撤销、窗口关闭、进程重启、多窗口、多显示器分别记录。禁止用端到端前后指针相同掩盖中途前台切换；短暂变化需采样/事件记录。Canvas、镜像、游戏、菜单与快捷键的能力按 App/版本单独列，不宣称任意 App 后台可操控。

### 可操作验收入口

1. 部署后 `list_resources` 应在目标 Mac 的 computer_use 实例中显示 `details.windowScope=v1`，operations 包含 `select_window`；仅升级 Server 的旧 Worker 不应显示新操作。
2. 租约内 `select_window {pid, window_id}`，可同时请求 `screenshotAfter:true`。后续 `get_ui_tree {}` 与 `click {element_token}` 自动使用该窗口，不需要重复 PID。
3. 坐标点击使用该截图的 `frameId` 作为 `frame_id`。换用旧 ID、操作后复用 ID、窗口移动/调整尺寸后复用 ID，预期 `stale_frame` 且没有输入。
4. 更换 pid/window_id 必须再次 select_window；混入别窗参数预期 `target_mismatch`。目标退出/关闭后不得把输入发给同进程别窗；provider 重建后空目标预期 `target_required`。
5. driver 0.34/0.35 的无 foreground 拖拽预期拒绝；后续 batch 动作不执行。用户未授权前台时，Agent 应报告此步需前台而不是重试。窗口截图与“鼠标/全局键盘焦点/frontmost/剪贴板未变化”分别记录。
6. 实验结束 release_resource，并保存 state=released 回执。检查实际运行的 Worker/资源报告，不能用安装包存在代替加载验证。

## 2026-10-21 凌晨：通道恢复与锁屏边界实测

DEV024 上线修复后，本项在 macbook 完成一次 acquire → 只读 run → release：`lease_1a44103f801e7a41a0dd` generation 41。run exitCode=0，实读 macOS 26.5.2 (25F84)、cua-driver 0.34.0；Accessibility/Screen Recording 为 true，归属 driver-daemon，而非 Foundry Worker。释放回执明确 state=released。

按原授权在专用 scratch `dev028-probe/native-v1` 创建了独立 AppKit 测试 App，未操作用户窗口，也未启动/重启 CuaDriver 或修改 TCC：

- 直接执行 App 二进制时 launchDate 不可取得，select_window 安全拒绝 `target_unavailable`；没有降级为只信 PID。
- 系统后台启动测试 App 后可取得启动身份。实机 0.34.0 拒绝 `tree_format`，因此移除了该较新参数，使用其原有 structured elements 返回形态。说明版本源码/模拟测试不能替代安装版本实测。
- select_window 能识别 exact 窗口，但后端连续返回 `ax_window_unresolved`、0 AXWindow、三条后台输入路线 refused。没有据此转前台、没有发送点击/输入/滚动，也没有截图其他 App。
- 随后独立只读查询 `CGSessionCopyCurrentDictionary` 实得 `{locked:true,onConsole:true}`。这解释了当前 AX 窗口不可用；**不是可以通过改变测试 App 声明或放宽安全检查解决的证明**。停止窗口实验。
- 目标 App 自身每 10ms 采样指针/frontmost/WindowServer键盘焦点/剪贴板 changeCount。已取得的初始样本均无变化，但因为未执行输入，这不是输入无抢占通过证据；也不能排除采样间隔内瞬变。
- `pgrep` 精确限定本项 App 可执行路径，返回 `PROBE_NOT_RUNNING`。screen `lease_c4a2bc9b866568320275` generation 7、compute `lease_6c98f0e7dab2f8535507` generation 43 均明确 released。

为避免之后再次把“有权限”当作“可交互”，加入只读 console/锁屏检查：select_window 和绑定窗口操作前先检查系统会话，锁屏返回 `screen_locked`，不能确认当前 console 返回 `console_unavailable`。不解锁、不弹权限、不激活 App。实际 bundle 到 Mac 测试此 helper：`lease_ec2f829e2d68b0b170ab` generation 45，exitCode=0，返回 `screen_locked: The Mac is locked ... Nothing was sent`；该租约也明确 released。这轮 helper 检查没有启动任何 App。

剩余具体依赖：用户方便时解锁 macbook，继续同一合成窗口正向点击、文字与滚动测试及并发输入观察。无需重新授予 TCC，不需要用户处理工具通道故障。新 Worker/provider 与 MCP schema 仍未部署，不能关闭“Mac 指定 App 无抢占”完整交付。

锁屏检查与实机兼容修正完成后，再次运行变更相关 `check-changed`：格式、Worker 构建、两个相关测试文件、模块审计全部通过（14.3s）。同时保留 0.34.0 实际返回的嵌套 `refusal.code`，避免再次折成泛化的 backend_error。完整正向输入验收仍未完成，不将锁屏安全拒绝计为后台输入成功。

## 当前 checkpoint（继续推进授权后）

- 按新的持续推进要求，仅进行一次锁屏只读复核：`lease_51970515f1b6527d684d` generation 47，run exitCode=0，仍返回 `screen_locked`；释放明确 `state=released`。本轮没有启动 App，没有输入，没有继续轮询。
- 补充锁屏/console/身份读取失败后的失效处理：既有 frame 与 snapshot 引用清空。之后即使同一进程恢复可用，也必须重新观察，不继续使用锁屏前的引用。加入回归测试。
- Fake driver 现按实机 0.34.0 拒绝 get_window_state 的未知参数，选择成功的契约测试因此能捕获重新引入 tree_format 的错误。
- 可复现实机材料已保存至 `packages/worker/test/manual/macos-window-probe/`：Swift 合成 App、runner、Info.plist 和说明。Swift 源与已在 Mac 编译启动的源 SHA256 相同（`385695d51863329237d5b44649d77748bfe769da7143358ac05fa48a5ee5bb64`）。runner 新增启动前锁屏检查和退出状态核验；正向路线依旧未实测通过，不能视为自动验收脚本已证明全部能力。
- 本次7文件 check-changed 的格式、Worker 构建、两个相关测试文件、modules 审计全部 PASS（15.7s）；构建前后磁盘均余16GiB、使用率85%。无重复依赖树或数据库备份。
- PA owner 已确认不改本项 operate_resource/资源区域；027/024继任 owner 使用隔离源码 snapshot 发布，排除本项。已通知双方公共 build/dist 释放。Git index 未占用，本项源码尚未提交/推送/打包部署，防止未完成正向验收的作用域功能混入别项发布。
- 唯一已知环境依赖仍为解锁 macbook。解锁后先读会话状态，再按原授权运行合成 App 的正向输入、拒绝场景与用户状态观察；通过后协调安全 Worker/Server 发布、验证实际加载版本，再按授权完成提交与推送。无需再次询问普通开发/部署批准。

## 2026-10-21 白天：目标调整与启动前采样

用户先要求改到 Mac mini，并授权安全自行更新必要 Worker；随后说明 mini 不在身边、无法操作，明确允许必要时改用正在使用的 MacBook。此最新授权覆盖此前排除 MacBook 的要求；不包含 foreground 输入或干扰业务窗口。

### Mac mini fresh 准备结果

- `CanWendeMac-mini` / `dev_d783b240-ed8a-404d-96ba-2f7266363d4b` compute 可用。`lease_0a4c9ca19ac7759a0375` generation29：run exitCode=0；macOS26.5.2、CuaDriver0.35.2，daemon未运行、TCC状态unknown，系统会话locked=true/onConsole=true。
- 实际execution-host PID40702加载 `0.5.7-dev.39.gc2e46c6.local.1792369800`。资源通道已足够隔离probe，不需要用户预先update Worker。后续确需更新时可按已有授权安全处理，但不得强切活跃会话。
- mini数据盘余16GiB/92%；未做大构建、未启动权限gate、未试图解锁。租约明确released。用户不能到mini本机操作，因此不再要求其解锁或授权。

### MacBook 备用授权下的受控验证

- 一次只读预检 `lease_77bff4d686cc94a8f53d` generation49：locked=false/onConsole=true、CuaDriver0.34.0，Accessibility和Screen Recording均true且归属driver-daemon；该租约已released。不需要用户update Worker或重新授TCC。
- 在原合成App材料中增加独立、最长5分钟的只读采样进程，先于合成App启动。10ms采样仅记录鼠标/frontmost/WindowServer键盘焦点/剪贴板changeCount是否变化；无剪贴板内容、业务窗口或全屏截图。合成App采用accessory策略、orderBack与后台启动，不调用activate/makeKey，也不请求foreground投递。
- screen `lease_363a7be273df0be3a3f4` generation9、compute `lease_cd08c4cfde555c95b584` generation51。新Swift fixture在Mac编译成功。首次runner在采样器2秒冷启动期限内未取得ready文件，明确拒绝启动合成App；**没有进入任何输入动作**。
- 随后只读采样器单独运行5秒（受run超时终止），得到pointer/frontmost/keyboard-focus变化标记。人当时正在使用MacBook，这些变化无法归因，不能据此宣称由后台控制造成，也不能宣称没有干扰。停止本轮，不连续重试寻找空隙。
- 精确限定fixture可执行路径的pgrep返回PROBE_NOT_RUNNING；上述screen/compute租约均明确released。没有截图、点击、输入、滚动或前台重试。
- 冷启动期限修为最多10秒；启动前已有任何变化即拒绝App启动。Swift新版本已在Mac编译，runner本地语法/格式检查通过。短暂不移动鼠标、不切前台应用的窗口用于建立可归因基线；这不是申请foreground权限，也不替代后续并发使用验收。

当前不需用户更新Worker；仍未发布DEV028代码。PA owner的共享候选构建/发布未被占用，本项仅以当前源码小bundle输出到临时目录并通过现有compute/screen租约验证，未带入PA未验功能。普通开发/部署授权仍有效，剩余正向测试完成后再协调最小已测版本与实际加载验证。
