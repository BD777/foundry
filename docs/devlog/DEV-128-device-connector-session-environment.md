# DEV-128 设备持有型连接器：会话环境只有一个来源，“可用”在会话环境里验证

状态：已部署 dev（Server `6dd7a009daf5d1d2`、Web `27a08cb78b0c432d`、Worker `…1793874861`，2026-11-05 18:34–18:45 UTC+8）；Agent 自验完成（macbook 真实会话 clone 私有仓库成功；sg-chaos 的真实会话待其执行宿主换新，见“部署”）；待人工验收；未提交。负责会话 `foundry-64`（编排会话 `sess_1793855865906282308` 下发，结构要求见“通用框架与适配器”）。

## 问题

`sess_1793869900823251856`（sg-chaos）：GitHub CLI 连接器显示已登录 BD777，但会话里 `git clone https://github.com/<私有仓库>` 被要求输入用户名，`which gh` 也找不到；Agent 于是去问用户要 token。

调查（读代码，未动本人的设备配置）：

1. `gh` 在 `~/.local/bin/gh`，是设备自己装的、在 Foundry 之外登录的。Worker 检测时搜了 `~/.local/bin`（`defaultToolDirs`），会话的 PATH 只有 Worker 的 PATH 加 `~/.foundry/tools/bin`，所以会话找不到。
2. `git config` 里没有任何 credential.helper：`github.ts` 只在经 Foundry 引导登录完成后才跑全局的 `gh auth setup-git`；在 Foundry 之外登录的就没有。
3. 根因：Foundry 判断“可用”的环境（Worker 的环境）和会话实际运行的环境不是同一个，登录状态读的是前者。

## 通用框架与适配器

本人要的是一套通用协议：**通用运行时加适配器的少数几个方法或声明**，不是给某个连接器定制的代码。

通用（所有设备持有型连接器共用，包括扩展）：

- `device-held.ts` 的 `sessionSetup(uses, binDir)`：会话环境的唯一生成处（真实会话在 `connectors/index.ts` 的 `prepareSessionConnectors` 调它，状态检查在 `checkSession` 里调同一个 `setupFor`）。只对 `run_session` 写明该会话能用（`device_login`）的连接器生成；工具（Foundry 管理的或设备自己装的）链接进这个会话自己的 bin 目录（`<状态根>/session-bin/<会话>`），放在 PATH 前面，会话结束删除，七天未动的残留在下次准备时清理；不往共享的 `~/.foundry/tools/bin` 放，也不改设备的全局配置。不能用的（`none`）拿到隔离变量。
- `session-environment.ts`：`applySessionSetup`（PATH 在前、变量覆盖）、`mergeEnvironment`（git 的 `GIT_CONFIG_COUNT/KEY_n/VALUE_n` 与会话已有的接续编号，不互相覆盖）、`linkTool`、`findOnPath`、`pruneSessionFolders`。会话环境的拼装在 `session-ambient.ts` 一处（`withSessionConnectors`）。
- 状态检查（读状态、已登录时做，`checkSession`）：在两种会话形状的环境里复用适配器现有的 `readLogin` 和 `readAuthorizations`，不给每个连接器另写检查命令。能用的环境：工具在会话 PATH 上找得到、`readLogin` 显示已登录；被隔离的环境（描述符 `isolationEnv` 加适配器的 `isolationEnvironment()`）：登录和每个附加授权都显示未登录。**扩展**：不新增 JSON-RPC 方法；声明式扩展在进程内，用一个环境覆盖层（`AsyncLocalStorage`）再问一次 `connector.status`；程序扩展由 `ExtensionHost.call(…, environment)` 单独起一个带这些变量的进程问一次后结束（`host.ts`）。
- 结果是通用状态字段 `sessionCheck`（契约 `DeviceConnectorSessionCheck`，`contracts/models/connectors.yaml`）：`usable`、`reason`、`isolationHolds`（缺省表示没有可隔离的或没能检查）、`isolationReason`、`checkedAt`。存 `device_connector_states.session_check`（启动时对旧库 `ALTER TABLE ADD COLUMN`），Server 只留布尔值和一句话（`cleanSessionCheck`，未登录的不留）。Web 通用渲染（`device-held-format.ts` 的 `sessionCheckText`）：“会话可以使用 / 会话里不可用：原因 / 没有授权的会话仍能拿到这份登录：原因”，与“已登录”分开显示，中英文。

适配器只多两个可选方法（与 `isolationEnvironment()` 对称，AWS 等其他内置适配器不用实现）：

- `sessionEnvironment(located)`：能用的会话额外需要的变量。
- `sessionCheck(shape, environment, located)`：读登录之外的检查，返回原因；永远不返回凭据。

GitHub 适配器的实现（`github.ts`，其余都是通用的）：

- `sessionEnvironment`：`GIT_CONFIG_COUNT=1`、`GIT_CONFIG_KEY_0=credential.https://github.com.helper`、`GIT_CONFIG_VALUE_0=!"<检测到的 gh>" auth git-credential`，只在会话进程里生效（形式同 `extensions/sources.ts` 的 `gitConfigFor`）。
- 去掉登录后的全局 `gh auth setup-git`，不再改本人的 `~/.gitconfig`。**已经写进 `~/.gitconfig` 的不去删**：那是本人的；Foundry 只管自己会话里怎么用（两处并存无害：同一个助手）。扩展从私有 GitHub 仓库安装仍用 `gitConfigFor` 给那一次拉取加助手，不依赖全局配置。
- `sessionCheck`：用 `git credential fill`（`GIT_CONFIG_GLOBAL=/dev/null`，`GIT_TERMINAL_PROMPT=0`，不提示）判断能用的会话里 git 拿得到 github.com 的凭据；被隔离的环境里（给它一个有 gh 助手的配置）拿不到。只判断有没有 `password=`，答案读完即丢，不打印、不上报。
- **Server 的隔离判定（行为变化）**：`connectors/deviceheld.go` 的 `SessionUses` 原来是 `case session.CreatedByUserID != deviceOwner && len(descriptor.IsolationEnv) > 0` 才对非所有者、又没有共享绑定的会话下发 `access: "none"`，把“要不要隔离”和“描述符有没有声明隔离变量”绑在了一起。GitHub CLI 的描述符没有声明隔离变量（隔离靠适配器自己的 `isolationEnvironment()`，指向空 gh 配置目录），所以**以前没有声明隔离变量的设备持有型连接器，对其他成员的会话根本没有隔离**（当前受影响的是 GitHub CLI；适配器里那段隔离从未执行）。现在：不是设备所有者、又没有共享绑定的会话，对这台设备上的每个设备持有型连接器一律下发 `none`，与描述符有没有 `isolationEnv` 无关，有声明的一并带上。没有改 catalog（不给 GitHub 加哨兵式的 `isolationEnv`）。测试：`connectors` 里新增“其他人的会话对每个设备登录都被隔离”（GitHub 不声明变量，没有登录、有登录、所有者、共享绑定四种情形），原有断言按新规则更新。Worker 侧由 `connectors-session-environment.test.mjs` 证明：没有声明变量的 `none` 用途下 `GH_CONFIG_DIR` 指向空目录，gh 读到未登录，就算给它 gh 的凭据助手也拿不到凭据，状态里的反向检查通过。登录说明文案里“设备上的 git 之后也用这份登录”改为“之后可以使用它的会话里的 gh 和 git”。

凭据暴露面：凭据助手属于“只选 profile”那一档，与会话直接用 `gh` 的暴露面相同；会话里不出现真 token（检查里读到的答案不外传）。

## 验证

- Worker 测试 `connectors-session-environment.test.mjs`（假 gh 装在任何 PATH 之外的目录，真 git）：
  - 设备自己装、不在会话 PATH 上的 gh 被链接进会话自己的 bin 目录并排在 PATH 前面，`command -v gh` 和 `gh --version` 在会话环境里成功；没有会话设置的同一 PATH 找不到；共享的工具目录没动；
  - 会话里 `git credential fill`（git clone 的第一步）从 gh 拿到 github.com 的凭据；`~/.gitconfig` 逐字未变，也没有别的全局文件；
  - 被隔离的会话：没有 gh，没有链接；就算给它 gh 的凭据助手，也拿不到凭据；
  - git 设置合并（会话自己的 `GIT_CONFIG_*` 保留，连接器的接在后面）；
  - GitHub 登录流程完成时没有任何 `setup-git` 调用，`~/.gitconfig` 未变；
  - 状态：已登录 + 会话可用 + 隔离成立；凭据助手坏了 → `usable:false`、原因 “git gets no github.com credential …”；gh 不遵守隔离 → `isolationHolds:false`、原因 “still reads as signed in”；状态里没有 token；未登录的没有 `sessionCheck`；
  - 扩展的连接器：同一套检查生效，扩展在隔离变量下仍读到登录或附加授权为 ready 时报 `isolationHolds:false`；工具同样被链接。
- `connectors-session-prepare.test.mjs`：真实入口 `prepareSessionConnectors` + `withSessionConnectors`，设备自己装在 `~/.local/bin` 的 gh（不在会话 PATH）被找到、链接，PATH 与 git 设置与会话自己的合并，另一个会话不受影响，`release` 后 bin 目录被删。
- Go：`connectors`（`cleanSessionCheck` 的清洗：换行、300 字截断、可用时不留原因、未登录不留检查；成员的 GitHub 隔离）、`sqlitestore`（存取、替换、旧库补列）通过。Web：`device-held-connectors` 新增用例（已登录与会话可用分开、原因、泄漏、未检查、未登录）。
- bytedcli 的 lark-cli 泄漏：框架**只能报出读取（登录或附加授权）覆盖到的泄漏**。bytedcli 扩展的状态读取是 `bytedcli auth status` 与 Meego 附加授权，不含 `bytedcli lark auth status`，所以 `BYTEDCLI_PROFILE=foundry-no-login` 下 lark 仍已登录这件事，框架现在看不到；扩展把 lark 声明成一个附加授权组（或让 `connector.status` 的登录读取覆盖它），反向检查就会报 `isolationHolds:false`。测试里用“扩展在隔离下仍读到附加授权 ready / 登录”的假扩展证明了框架能报。按要求没有新增扩展协议，也没有改扩展本身。

## 限制

- 会话的基础环境来自 Agent 的 profile；检查用 Worker 的环境加上述会话设置，不是逐字复制。
- 隔离是防误用，不是系统安全边界（同一个系统用户）。
- 只有 GitHub 适配器实现了 `sessionEnvironment`/`sessionCheck`；扩展没有 `sessionEnvironment`（按要求，若需要先报告）。
- 已写进 `~/.gitconfig` 的旧 `gh auth setup-git` 结果仍在（本人的）。

## 真实环境验证

- **sg-chaos 上用已装的新 Worker 代码、真实的 gh 2.67.0（`~/.local/bin/gh`，在 Foundry 之外登录为 BD777）和真实 git 读状态**（只读，状态根指向临时目录，不打印任何凭据）：`signedIn: true`，`sessionCheck: {usable: true, isolationHolds: true}`。同一台设备的 `~/.gitconfig` 里没有任何 `credential` 项（正是原问题的第二个原因）。
- **macbook 上开真实会话**（`sess_1793875253543254889`，Codex，`research` 工作区，新执行宿主 `…1793874861`）：`gh` 在会话 PATH 上，`git clone https://github.com/nwverse/astergate-dist.git`（私有）**直接成功**（`GIT_TERMINAL_PROMPT=0`，没有任何认证参数，没有问用户名），能读到提交；会话里有 `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`，`git config --global` 里没有 `credential` 项；临时目录已删除。（macbook 的 gh 在 `/opt/homebrew/bin`，本来就在 PATH 上，所以这里证明的是 git 凭据助手；“不在 PATH 上”的链接由 Worker 测试和 sg-chaos 的原症状覆盖。）
- **sg-chaos 上开真实会话**（`sess_1793875177335354674`，clone 同一仓库）：**失败**，与原症状一致（`could not read Username for 'https://github.com'`，`gh: command not found`）——这是预期的：该会话落在 sg-chaos 仍在运行的旧执行宿主 `…1793867080` 上（旧 Worker 代码，没有会话设置）。新宿主要等旧宿主上没有回合在跑才会换（`drain.ts`：超过 30 秒的上限后新回合就在旧宿主上跑，只有“立即切换”才会停回合，这里没有强停）。sg-chaos 是共享设备，编排会话和本会话自己的回合都在旧宿主上。**待办：旧宿主换新之后，在 sg-chaos 上重开一个会话再做一次这个 clone（验收步骤 1）。**

## 部署

2026-11-05（UTC+8），持 `/tmp/fdy-deploy.lock`，在 `foundry-int` 里：`device-held.ts`、`github.ts`、`adapter.ts`、`host.ts`、`session-ambient.ts`、`index.ts`、Web、Go 文件整份带入（与 `foundry-int` 的版本逐项核对过只差本次的改动）；`declarative.ts` 和 `connector-extensions.test.mjs` 因别的会话已有改动，只替换我的段落；契约在该树重新生成（只多 `DeviceConnectorSessionCheck` 和 `sessionCheck`）。

- Server：`6dd7a009daf5d1d2`（原 `05b33acf2a4968c2`，回滚 `releases/dev023-candidate/foundry-server.pre-dev127`），18:34 SIGHUP，`new server pid 845318 took over; previous pid 767019 exited after 582ms`，`/healthz` 200；启动时给 `device_connector_states` 加了 `session_check` 列（已核对）。
- Web：`27a08cb78b0c432d`（原 `7072d87c25e09110`，回滚 `releases/dev127/previous-20261105T103518Z`）。
- Worker：`0.5.7-dev.269.g97415a6e.local.1793874861`（原 `…1793872794`，`worker-packages/release.before-dev127.json`）。打包前核对：`foundry-int` 的编译产物与线上包只差本次的 7 个文件（别的会话在两次部署之间发过 `…1793872794`，没有被回退）。经计算租约更新 7 台设备：守护进程全部换到新版；执行宿主：limen-canada、byte-dev-sg、cottoncpp、CanWendeMac-mini、macbook 已是新版；byte-dev 和 sg-chaos 的旧宿主仍被运行中的回合占着，没有强停。没有设备的会话因此中断。
- 设备状态里的 `sessionCheck` 要等本人打开 Connectors 页（Server 在页面上读一次过期的状态）才会出现；本会话没有本人的登录，所以没有在页面上看到它，只在 sg-chaos 上用同一份 Worker 代码读了状态（见上）。

## 人工验收步骤

1. （sg-chaos 的旧执行宿主换新之后）在 sg-chaos 的 `astergate-dist` 工作区开新会话，让它 `git clone https://github.com/nwverse/astergate-dist.git` 到临时目录。预期：直接成功，不问用户名、不要 token；`which gh` 有路径；会话里 `env` 有 `GIT_CONFIG_COUNT`；`git config --global --get-regexp credential` 没有输出；用完删掉临时目录。
2. 打开 Connectors → GitHub CLI。预期：sg-chaos 一行显示“Signed in as BD777”，并另有一行“Sessions can use it”（会话可以使用）；设备上把 `gh` 的登录退出后，该行变为未登录，没有“会话可以使用”。
3. 让另一位没有被共享的成员在这台设备上开会话。预期：那个会话里 `gh` 不在 PATH 上，`GH_CONFIG_DIR` 指向空目录，clone 私有仓库要凭据而拿不到。
