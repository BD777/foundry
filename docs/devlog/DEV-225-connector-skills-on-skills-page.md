# DEV-225 授权连接器带来的 Skill 在 Skills 页显示为开

状态：已部署 dev 并自验，待本人验收。已合入 main（PR #268）。

## 问题

本人在 ccm-omh-integration 启用了 OpenLark（「Use byte-dev OpenLark（内网） in this workspace · Ready」），但这个工作区的 Skills 页上，OpenLark 的 Skill 没有显示为开，本人只好手动打开。早上 bytedcli 也是一样：连接器已授权，Skills 页上它的 Skill 却是关的。要求是：连接器授权给工作区或助理后，它的 Skill 默认就是开的。

## 调查（只读）

- 本人手动做的改动：`skill_bundle_selections` 里这个工作区（`ws_56c549f3…`）多了一行，选中了 OpenLark 套件 `repo_4a2f329c…`。没有任何 `workspace_skill_exclusions`。
- 会话实际拿到了什么：读 byte-dev 上的原生 transcript。这个工作区在本人手动打开之前的会话，Skill 清单里就已经有 `foundry-workspace:olk`、`foundry-workspace:open-lark`、`foundry-workspace:setup-open-lark`（03:21 的 `0b63aa6d…`、09:42 的 `42d7f226…`），ByteWork 和 open-lark 工作区也一样。所以问题不在会话：**会话拿到了这些 Skill，只是 Skills 页显示它们是关的。**
- 根因：会话下发时（`sessionPackageSkills` / `workspacePackageSkills`），连接器 Skill 是在 Workspace 的选择之后另外加上的。Skills 页的开关状态则只看选择（`workspaceSkillBindings`）、默认和套件（`inheritedSkillIds`），而 `resolveWorkspaceSkills` 根本不知道连接器的存在。连接器 Skill 只出现在 `workspaceSkills`（输入框 `/` 菜单）里，页面的勾选框读不到。bytedcli 的 tool bundle（DEV-218）也是这样。
- 助理：会话里，助理主工作区经权限包拿到本人全部账号。但页面和输入框是在会话还不存在时计算的，`SessionAccounts` 只按已存在会话解析权限包，没有会话就退回到只看绑定。主工作区通常没有绑定，所以它的 Skills 页同样看不到 OpenLark。

## 修复

一条规则，只实现一次（`httpapi/session_packages.go` `workspaceConnectorSkills`）。会话下发、输入框菜单、Skills 页都用它：

- 授权给工作区的连接器（Server 持有型账号绑定；设备持有型可用 `device_login`；助理主工作区按权限包）带来自己的 bundle：集成包的全部 Skill，或工具 bundle 里 `tool.skills.default` 列出的那几个。这些 Skill 默认是开的。Workspace 已有同名的、设备自己有同名的（DEV-218 C）不再重复添加。Workspace 关掉的（`workspace_skill_exclusions`）不给，但仍算作这个连接器带来的。
- 页面投影（`foundry_data.go` `workspaceConnectorSkillView`）：这些 Skill 加入 `inheritedSkillIds`，关掉的加入 `offSkillIds`；新字段 `connectorSkills` 按连接器列出 `{kind, label, skillIds, bundleIds}`（协议 `FoundryDataField` 加了 `connectorSkills`）。原有的“继承 + 关掉”机制不变：取消勾选再保存，就写一条 exclusion，从此一直生效。
- 助理：`externalaccounts.SessionAccounts` 在没有已存会话时，按“本人在这个工作区新开一个对话”解析权限包，所以主工作区的页面和输入框，与它的会话拿到的账号相同。项目工作区仍然只看绑定（测试覆盖）。
- 授权变化后页面会刷新：工作区绑定账号、设备连接器绑定、集成包启用变化时，都会通知 `workspaceSkillFields`（含 `connectorSkills`）。
- Web：Skill 行显示「来自连接器 OpenLark」，关掉后显示「来自连接器 OpenLark，此处已关闭」。套件区里连接器的套件显示「来自连接器 X · 已启用 n / m」。连接器已经带上全部 Skill 的套件，在全部开着时显示为已勾选，勾选框不可点，单个 Skill 在下面的列表里关。
- 迁移：不需要。开关状态由授权直接推出，没有要回填的数据。已有授权的工作区一上线就显示为开；没有任何既有 exclusion，所以不会误关。OpenLark 集成包只有 3 个 Skill，没有声明 default，全部默认开；不需要改它的描述符，代码里也没有出现 OpenLark 的名字。
- 文档：`docs/connector-extensions.md`「Skills 页显示为开」。

## 检查

- Go（本机）：`go build ./...`、`go vet ./internal/httpapi ./internal/externalaccounts`；`go test ./internal/externalaccounts` 通过（新增：助理主工作区在没有会话时拿到本人账号，项目工作区拿不到）；`go test ./internal/httpapi -run 'TestConnectorSkills|TestConnectorToolSkills|TestConnectorPackage|TestNPMSkillBundle|TestWorkspaceDeviceConnectors|TestDeviceHeldConnector|Skill|PersonalAgent|Assistant'` 中其余用例都通过，新加的 `TestConnectorSkillsAreOnInTheWorkspaceSkillsPage` 修正后单独重跑通过。这个新用例：假 npm registry + 假 Worker 上报一个设备持有型连接器，其 `tool.skills.default` 为 2 个；`GET /api/foundry-data` 把这 2 个列为 inherited 和 connectorSkills，第 3 个不在其中；关掉一个后它出现在 `offSkillIds`，会话不再拿到；登录失效后三者都消失。
- Web：`tsc --noEmit` 通过；`test/workspace-skill-versions.test.mjs` 6/6（新增连接器 Skill 显示为开、带标签、套件「2 of 2 on」不可点、关掉一个后变「off here」「1 of 2 on」、保存时 `offSkillIds: ["olk"]`）；`skill-selection-engine`、`skill-listing-budget` 通过；`audit-component-system`、`audit-copy`、`audit-feature-architecture` 通过。
- 真实数据（只读）：用线上库的只读副本（`/tmp`，验后删除）加本次代码，算出各工作区页面上会显示的内容：
  - ByteWork（助理主工作区，没有绑定）：OpenLark `olk`、`open-lark`、`setup-open-lark`；bytedcli `bytedance-meego`（其余 5 个默认 Skill 设备上有同名的）。
  - llm-gateway（绑定 OpenLark）：同上。
  - open-lark 工作区：OpenLark `olk`、`setup-open-lark`（`open-lark` 这个名字工作区自己已有）。
  - ccm-omh-integration：连接器这一项为 0，因为本人手动选的 OpenLark 套件已经覆盖了这 3 个。

## 部署与上线后核对

- 车次负责人 sess_1794555762602239151 于 2026-11-13 15:27 UTC 上线：Server `39f337fd2d54c4e1…`（healthz 200）、Web `6d7a3efe85bf12de`，Worker 未变。上线前负责人在 byte-dev 上重跑：go build/vet、externalaccounts、上面的 httpapi 测试列表、protocol/web tsc、workspace-skill-versions 6/6、skill-selection-engine 7/7、skill-listing-budget 4/4、device-held-connectors 29/29、audit:ui，全部通过。
- 真实浏览器（线上 Web + 线上 Server，e2e-alice，DEV-148 合成工作区 `ws_68dbe9ca…`）：`fields=connectorSkills` 被线上 Server 接受，e2e-alice 没有连接器，所以值为空。在浏览器里把 `connectorSkills`（OpenLark，库里真实存在的 3 个 Skill）注入 foundry-data 的 GET 响应后：套件行显示「来自连接器 OpenLark · 已启用 3 / 3」，勾选框已勾、不可点；展开后 olk、open-lark、setup-open-lark 都是开的，各带「来自连接器 OpenLark」；取消 olk 后显示「来自连接器 OpenLark，此处已关闭」、「已启用 2 / 3」，「保存选择」可点。没有点保存，重新加载后丢弃。密码只由脚本读取、没有输出，验完已登出，cookie 已删除。（playwright-cli 的浏览器发请求时不带 `Sec-Fetch-Site`，所以路由里补了 `Origin`，否则 Server 会以 browser provenance 拒绝。）
- 本人账号（只读）：上线后本人在 15:29 UTC 打开了 ccm-omh-integration，foundry-data 正常返回，Server 日志没有错误。

## 限制

- ccm-omh-integration 里本人手动打开的 OpenLark 套件选择保留没动。修复后这一选择是多余的：页面上这个套件仍显示为已勾选，取消后由连接器继续保持开。但只要这个选择还在，日后移除 OpenLark 授权，这 3 个 Skill 仍会留在这个工作区。是否取消由本人决定。
- 设备持有型连接器的登录状态变化（登出、过期）不主动通知页面，靠快照短 TTL 或下次读取更新。
- 真实浏览器只在 e2e-alice 上配合注入数据验证过；本人账号的 Skills 页没有登录查看（不碰本人登录）。上线后本人在已绑定 OpenLark 的工作区里还没开过新会话，所以「新会话列出这些 Skill」只有上线前的 transcript 作证据（会话这一侧本次没有改变行为）。浅色 1280 宽，未截深色/窄屏。

## 验收

1. 打开 ByteWork（助理）→ Skills：`olk`、`open-lark`、`setup-open-lark` 显示为开，标「来自连接器 OpenLark」；套件区 open-lark 显示「来自连接器 OpenLark · 已启用 3 / 3」。
2. 在 llm-gateway → Skills 取消 `olk` 并保存：显示「来自连接器 OpenLark，此处已关闭」；刷新后仍是关的；之后在这里新开的会话里，`/olk` 不再出现。重新勾选并保存，恢复原状。
3. 在某个工作区移除 OpenLark 绑定：它的 Skills 页上，这 3 个 Skill 不再显示（ccm-omh-integration 因为保留了手动套件选择，除外）。
