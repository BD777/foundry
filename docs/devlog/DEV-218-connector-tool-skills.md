# DEV-218 连接器自带工具的 Skill 跟着连接器走（bytedcli）

状态：两步都已部署 dev 并自验，待本人验收。改动未提交。

## 问题

本人看 byte-dev 的 bytedcli 连接器卡片：「他对应的skill似乎没关联起来？」卡片上没有任何 Skill；两项附加能力 “Meego Web session (CN)” 与 “Feishu CLI (bytedcli lark)” 都显示 Not verified。

## 调查

- Skill 库里有一个 bundle 跟随 `npm:@bytedance-dev/bytedcli`（`repo_14507295…`，0.192.0，276 个 Skill，带 bytedcli 工具，由 byte-dev 代读 bnpm），但 bytedcli 的描述符（`extensions/bytedcli/foundry-extension.json`）没有任何 Skill 声明，两者在 Foundry 里没有关联：只有 4 个 Workspace 手动勾选了这个 bundle（`skill_bundle_selections`），绑定 bytedcli 的 Workspace 不会因此拿到它。
- 连接器与 Skill 唯一的关联是集成包 `package`（DEV-185，OpenLark）：GitHub 上游 + 仓库工具 + 按设备启用，不适合“CLI 由连接器自己从 npm 装、Skill 就在同一个 npm 包里”的情况。
- ByteWork 会话（sess_1794542612133670581）用到的 `bytedance-insearch` 不是 Foundry 给的：Loaded skills 里没有它，它在 byte-dev 本人自己的 `~/.claude/skills`、`~/.agents/skills`（54 个 bytedance-*，设备上自行安装）。
- 只读核对 byte-dev（bytedcli 0.192.0）：
  - `bytedcli --json --site cn meego status`：`providers.goapi.state = "bootstrap_available"`（source `feishu_web_session`）。描述符把它映射为 unknown + `bootstrap_available`，页面显示 Not verified 与“Prepare existing login”。这是设计如此：GoAPI 会话还没建，用已有的飞书网页会话点一次“准备”即可，不重复基础登录。没有改。
  - `bytedcli --json lark --no-auto-install auth status`：`{"status":"error","error":{"code":"LARK_CLI_NOT_FOUND",…}}`，即设备上没有 lark-cli 运行时。描述符没有对应规则，落到 `otherwise` → `check_failed`（“暂时无法检查”），说法不对。

## 修复

- 描述符新增 `tool.skills: { path }`（契约 `ConnectorToolSkills`，只用于 `tool.source: "npm"`，Server `catalog.go` 校验）：声明工具自己的 npm 包里带 Skill。
- Server（`httpapi/connector_skills.go`）：关联的是 Skill 库里跟随 `npm:<tool.package>` 的 bundle（同文件夹优先，其次读整个包的那个）。会话收到这个连接器时（`connectorKinds`，设备持有型须 `device_login`）把这个 bundle 加进 `sessionPackageSkills`，与集成包同一条路径：版本按设备上的 CLI 配对，Workspace 自己的同名选择与关掉的 Skill 优先；输入框 `/` 菜单（`withPackageSkills`）同样。代码里没有 bytedcli 的名字。
- 视图：`GET /api/connectors` 与 Workspace 连接器视图增加 `skillBundles`（kind、来源 package/tool、仓库、名称、版本、个数；没被跟随时只给包名）。
- Web：`connector-skills.tsx`，在“凭据在哪”下面显示“Skills: bytedcli · 276 skills · 0.192.0 — sessions that use this connector get them.”，名称链到 Skill 库里这个 bundle；未跟随时说明包名并链到 Skill 库。Workspace 卡片对两种来源都显示；Connectors 页只对 tool 来源显示（集成包的 Skill 已在它的面板里逐个列出）。
- bytedcli 描述符 2.1.0：`tool.skills.path = "skills"`；lark 读取增加规则 `/error/code == LARK_CLI_NOT_FOUND` → `needs_auth`，授权说明补上“首次运行 `bytedcli lark auth login` 时 bytedcli 会安装 lark-cli”。
- 文档：`docs/connector-extensions.md`“连接器带来的 Skill”。

## 检查

- byte-dev-sg（本人允许，Mac mini 离线；工作树快照上传到 scratch，Go/pnpm 缓存都放 scratch 内，用后整个删除）：`go build ./...`、`go vet ./internal/httpapi ./internal/connectors ./internal/store`；`go test ./internal/connectors -run 'TestExtensionDescriptorsPassServerChecks|TestToolSkillsBelongToAnNPMPackage'`（bytedcli 2.1.0 描述符过 Server 校验；`tool.skills` 只接受 npm 工具、包内路径）ok；`go test ./internal/httpapi -run 'TestConnectorToolSkills|TestConnectorPackage|TestNPMSkillBundle|TestWorkspaceDeviceConnectors|TestConnectorCatalog'` ok（新 `TestConnectorToolSkillsComeFromTheFollowedPackageBundle`：假 npm registry 上跟随 `npm:corpcli` 的 bundle 被关联、视图给出名称/版本/个数、未跟随的包只给包名、收到连接器的会话拿到带 bundle 标记的 Skill、没有连接器的会话拿不到；集成包原有用例改签名后照常通过）。
- byte-dev：Web 我改动的 5 个文件语义与语法诊断为 0（`tsc` 程序内逐文件检查）；整体 `tsc --noEmit` 当时只报别的会话进行中的 `personalAgent.ts` 语法错误。
- Worker：`connector-bytedcli-declarative.test.mjs` 新增 `LARK_CLI_NOT_FOUND` → `needs_auth` 用例（输出取自 byte-dev 真实 0.192.0，存入 fixture）。sg-chaos 上 `run-worker-tests.mjs` 7/7 通过。

## 部署与版本证据

- 由部署车次 DEV-219（sess_1794555762602239151）上线，Server 先于 Worker：Server `789843f2ffc11b24…`、Web `fbb6b42c7eb3e557`（2026-11-13 11:14 UTC）；Worker `0.5.7-dev.357.g8f394c91.local.1794567381`（含 bytedcli 扩展 2.1.0）11:18:58 UTC 装到 byte-dev。
- 真实库核对：byte-dev 上报的 bytedcli 描述符为扩展 2.1.0，`tool.skills = {path: "skills"}`。
- 会话：在 ByteWork 起一条只回 “OK” 的 haiku 验证会话 `sess_1794569214215157666`（不用工具，验后已归档）。Preparing skills 从改动前的 18 个变为 290 个，Loaded skills 含 274 个 `bytedance-*`，其中有 `bytedance-insearch`（这次由 Foundry 提供）。
- 截图（1280 宽，浅色）：用线上同一个 Server 二进制（sha256 `789843f2…`）和线上 Web 目录，跑在线上库的副本上（`FOUNDRY_INTEGRATIONS=off`，外连指向死代理；只在副本里重设了本人密码用于登录）。验后停掉服务，删除副本。副本没有连上 Worker，所以设备显示 Offline，其余数据都是真实的。
  - `.foundry/attachments/dev218/workspace-card.png`：ByteWork 的 bytedcli 卡片显示 “Skills: bytedcli · 276 skills · 0.193.0 — sessions that use this connector get them.”；“Feishu CLI (bytedcli lark)”显示 Needs authorization。
  - `.foundry/attachments/dev218/connectors-page.png`：Connectors → bytedcli 显示同一行，以及 “ByteDance tools extension 2.1.0”。
- Skill 库跟随的 bytedcli 已更新到 0.193.0；会话拿到的是与设备上 CLI 版本配对的那一版。

## 第二步：默认子集、同名用设备的、清单预算提示（2026-11-13，编排决定 A + C）

起因：第一步上线后每个 ByteWork 会话拿到 290 个 Skill，其中 bytedcli 占 276 个。实测 token 只多约 100（清单有固定预算），但带描述的条目从 81 降到 47，byte-dev 自己的 `bytedance-insearch` 和 Foundry 给的那份同时出现，而且都只剩名字。编排会话（sess_1794464313271186377）决定：只开默认子集，设备已有的同名 Skill 用设备的那份，并在 Skills 页显示清单预算。

- **默认子集**：`tool.skills.default` 列出会话默认拿到的 Skill（契约 `ConnectorToolSkills.default`，Server 校验名字合法、不重复）。会话只拿这些，外加 Workspace 自己勾选的同一 bundle 成员；关掉的照旧不给（`connectorSkillSource.activeMembers`、`mergePackageSkillRefs`）。bytedcli 描述符 2.2.0 默认 6 个：`bytedcli`、`bytedance-codebase`、`bytedance-meego`、`bytedance-insearch`、`bytedance-feishu`、`bytedance-scm`。挑选依据：dev 库里会话实际执行的 bytedcli 子命令，按用到的会话数排：codebase 58、mr 46（属 codebase）、meego 25、checks 13（属 codebase）、insearch 9、scm 6、lark 5（即 bytedance-feishu）；Skill 工具的直接调用只有 `bytedance-insearch` 1 次。`bytedcli` 本身是总入口。
- **卡片**：显示 “Skills: bytedcli · 6 of 276 on · 0.193.0”。`onCount` 等于默认的个数，加上这个 Workspace 勾选的成员，减去关掉的。Workspace 卡片上另有 “Turn on more” 链到这个 Workspace 的 Skills 页，在那里勾选更多（已有的逐个选用机制）。
- **同名用设备的**：连接器带来的 Skill 如果和设备自己文件夹里的 Skill 同名，就不加 Foundry 那一份（`deviceOwnSkillNames`）。设备自己的文件夹指设备级的 `~/…` 根目录，以及这个 Workspace 的 `.claude/skills`、`.agents/skills`，按设备最近一次扫描。只算会话的 Agent 读的那些：Claude Code 读 `.claude/skills`，Codex 读 `.codex/skills` 和 `.agents/skills`。输入框菜单两种都算。为什么不比版本：设备上的 Skill 没有可比较的版本号，而那一份是本人自己装、自己维护的。Workspace 显式勾选的 Skill 不受影响。
- **清单预算提示**：Claude Code 的规则读自它 2.1.311 的程序：预算 = 上下文窗口 × 每 token 字节数 × 1%，按显示宽度计；超出时先全部只留名字，再按它自己的优先级把描述加回去。dev 上的实测：两条会话的清单（同一 byte-dev，Opus 5.5 / Haiku 5.5）宽度都是 29,981，预算都是 30,000，即 1M × 3 × 1%。Workspace 的 Skills 页用这个预算估算，从最窄的描述加起，所以给的是下限（`skill-listing-budget.ts`）。超出时显示 “at least N … by name only”。用 dev 库数据回算 ByteWork：改动前下限 57（实测 111）；第一步后下限 348（实测 418）；第二步后下限 58，和改动前持平。默认 6 个里有 5 个设备上已有同名的，所以 Foundry 只新加 1 个。
- 文档：`docs/connector-extensions.md`（默认子集、同名规则、卡片），`docs/skills.md`（清单预算提示）。

检查（byte-dev，本人允许 Mac mini 离线时使用；工作树快照放在 scratch，依赖与缓存都在 scratch 内，验后删除）：`go build ./...`、`go vet`（httpapi/connectors/store）、`go test ./internal/connectors -run 'TestExtensionDescriptorsPassServerChecks|TestToolSkillsBelongToAnNPMPackage'`（默认名重复被拒）、`go test ./internal/httpapi -run 'TestConnectorToolSkills|TestConnectorPackage|TestNPMSkillBundle|TestWorkspaceDeviceConnectors|TestConnectorCatalog|Skill'`（含新增的默认子集、Workspace 勾选计数、Claude/Codex 同名规则）都通过；Web 整体 `tsc --noEmit` 通过；Web 测试 `skill-listing-budget`（新）、`device-held-connectors`、`connector-package`、`workspace-skill-versions`、`skill-selection-engine` 49/49 通过。

部署与复测：补丁交给车次负责人 sess_1794555762602239151 随第 3 车部署，没有自行部署。Server `3afdc9f1…`、Web `dca3830f79230b7e` 于 12:49 UTC 先上线；之后 Worker `0.5.7-dev.357.g8f394c91.local.1794573931`（含 bytedcli 扩展 2.2.0）于 12:49:42 在 byte-dev 加载。负责人在上线前重跑了上面列出的测试，全部通过，另加 Worker 的 connector-bytedcli-declarative 7/7。复测：在 ByteWork 起一条只回 “OK” 的 haiku 验证会话 `sess_1794574239019903592`（验后已归档），读 byte-dev 上的原生 transcript：

| ByteWork 会话                                  | Foundry 给的 Skill | 清单条目 | 带描述 | 清单宽度 / 预算 | 首个请求输入 |
| ---------------------------------------------- | ------------------ | -------- | ------ | --------------- | ------------ |
| DEV-218 之前（sess_1794542612133670581，opus） | 18                 | 192      | 81     | 29,981 / 30,000 | 28,346       |
| 第一步后（sess_1794569214215157666，haiku）    | 290                | 465      | 47     | —               | 30,386       |
| 第二步后（sess_1794574239019903592，haiku）    | 16                 | 191      | 82     | 29,998 / 30,000 | 29,556       |

第二步后，bytedcli 只多了 `bytedance-meego` 一个（其余 5 个默认 Skill 设备上已有同名的）。`bytedance-insearch` 只出现一次，是设备自己那份，并带描述。另外，DEV-218 之前那条会话里的 OpenLark 集成包 Skill（`olk`、`open-lark`、`setup-open-lark`）在两条验证会话里都没有。这两条验证会话都是 Agent 发起的，那条会话是本人在 Chat 里发起的；第一步时就已经没有，与第二步的改动无关，是否是 Agent 发起的会话拿不到 OpenLark 连接器，留给连接器授权一侧（DEV-215）核对。

## 限制

- 上下文占用（编排会话 2026-11-13 提问后实测，byte-dev 上的原生 transcript）：Claude Code 的 `skill_listing` 有固定预算，改动前 192 条、28,832 字符，改动后 465 条、29,160 字符（+328 字符，约 100 token）。首个请求的输入从 28,346 变为 30,386 token，但两条会话的模型和输入都不同，不能全算到 Skill 头上。代价在可见性上：带描述的条目从 81 条降到 47 条，只有名字的从 111 条升到 418 条；设备本地 54 个 `bytedance-*` 里带描述的从 54 降到 26，`bytedance-insearch` 两份（本地和 `foundry-workspace:`）都只剩名字。Foundry 插件提供的 Skill 改动前就都只有名字（0/17）。Codex 的初始清单上限是窗口的 2%（`skills.max_context_tokens`），这里没有测。是否改为默认只激活精选子集，等编排确认。

- Skill 库没有跟随这个 npm 包时不自动跟随（跟随仓库要 Admin，且私有 registry 要选代读设备）；页面只说明包名并链到 Skill 库。
- lark-cli 运行时的安装仍在设备终端完成（`bytedcli lark auth login`）；Foundry 没有为附加能力提供安装动作。

## 验收

1. 打开 byte-dev 所在 Workspace（如 ByteWork）的 Connectors：bytedcli 卡片在“Credentials on each device”下显示 “Skills: bytedcli · 276 skills · 0.192.0”，点名称进入 Skill 库的 bytedcli bundle。
2. 在这个 Workspace 新开会话，输入 `/bytedance-in`：出现 `bytedance-insearch`（Foundry 给的）。
3. Connectors → bytedcli → byte-dev：“Feishu CLI (bytedcli lark)”显示 Needs authorization，而不是“Could not check this capability”。
