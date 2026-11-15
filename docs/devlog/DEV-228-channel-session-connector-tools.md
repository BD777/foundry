# DEV-228 只读通道会话里的连接器工具：olk 找不到、bytedcli 坏链接、家目录其实没隔离

状态：已部署 dev（train18-20261113：Server `36e580b1…`，Worker `0.5.7-dev.357.g8f394c91.local.1794593951`，2026-11-14 02:28–02:29 UTC+8）；byte-dev 执行宿主已加载新代码；真实通道回合待本人下一条 `/ai` 消息；待人工验收；已合入 main（PR #268）。负责会话 `sess_1794591666137320210`（编排会话 `sess_1794464313271186377` 下发，brief `.foundry/briefs/dev228-229-channel-test-fixes.md`）。

## 问题

DEV-203 通道实测报告（`sess_1794585597739851554` 最后一条回答）问题 1、3：通道会话 `sess_1794585876751990513`（byte-dev，ByteWork 助理，Claude）里

- `olk` 不在 PATH 上，助理第一条消息先花了约 30 秒找它，之后每条都用绝对路径 `/data00/home/dengcanwen/.foundry-tools/bin/olk`；
- `bytedcli` 是坏链接，按真实路径运行报 `AUTH_REQUIRED`，助理还在通道里建议 `bytedcli auth login`。

## 调查

读代码 + byte-dev 上只读查看（compute lease，不打印任何凭据内容）+ 线上库只读副本查询。

1. **olk 不在 PATH 的根因：沙箱里的会话宿主重新算 PATH 时把会话自己的工具目录当成残留删掉了。** 通道会话的 Agent 跑在 `host-child.js`（沙箱内的单独进程）里。Worker 在沙箱外把会话的工具目录（`~/.foundry-tools/.sessions/<会话>`，链接 olk 等）放在 PATH 第一位交给它；宿主里 `sessionEnvironment` 又做一遍 `servicePath(...)`，按设计去掉所有 `.sessions/<id>` 条目（长期进程不该带会话目录），再用 `sessionToolsFolder(id)` 加回来——但这张表只在 Worker 进程里有，宿主里是空的，于是改用 `managedToolsBin()`，而它按 `homedir()` 算，宿主的 HOME 是私有 scratch，得到一个不存在的 `scratch/.foundry-tools/bin`。两个目录都没了，olk 自然找不到。Claude 和 Codex 走同一个 `sessionEnvironment`，两种 runtime 都受影响。
2. **byte-dev 的家目录是链接**：`/home/dengcanwen -> /data00/home/dengcanwen`。Worker 用 `/home/dengcanwen/...` 命名工具目录和链接（olk 的链接目标是 `/home/dengcanwen/.foundry-tools/olk/<hash>/olk`），沙箱只按真实路径挂载 `/data00/...`，所以即使 PATH 对了，经 `/home/dengcanwen` 的路径在沙箱里也不存在。bytedcli 的“坏链接”就是这个：`.sessions/<会话>/bytedcli -> /home/dengcanwen/.local/bin/bytedcli`。
3. **bytedcli 怎么拿到凭据**：bytedcli 是设备持有型连接器（扩展 `bytedance`，描述符写明 “Sessions on a device run bytedcli with that device's own ByteCloud login”），ByteWork 的权限包对 byte-dev 的 bytedcli 给了 write。但它的登录就是设备上 `~/.local/share/bytedcli/profiles` 里的文件，Foundry 只是把程序链接进会话 PATH，不经过任何 Foundry 网关。也就是 brief 里的“只是本机登录”这一支：通道会话处理别人的消息，按设计不该拿到它，要用的时候派 helper（DEV-229 修派发）。
4. **家目录其实没有隔离（比报告更严重）。** 通道会话沿用 verifier 的沙箱，`userFiles: "readable"`：HOME 换成了 scratch，但整个家目录按真实路径只读挂载，Agent 用绝对路径就能读 `~/.ssh`、`~/.config`、`~/.local/share/bytedcli`。另外 byte-dev 上 `/opt -> /data00`，而 `/opt` 是沙箱一律挂载的“设备软件目录”，`/data00` 又包含家目录——所以在 byte-dev 上，**即使是 `userFiles: "hidden"` 的沙箱（Issue 执行、澄清）也能读到整个家目录**。测试在修复前实测打印出了 `visible /data00/home/dengcanwen/.ssh`、`.config`、`.local`、`.gitconfig`。
5. 服务端持有的 Feishu 账号（feishu-cli）把会话的 profile 写在 Worker 的 `~/.feishu-cli/profiles/<名字>`，而通道会话里 feishu-cli 按 HOME（scratch）找，同样找不到。实测没有用到，但权限包和通道范围都授予了 Feishu 账号，属于同一类问题。

## 修复

原则：保留隔离 HOME；通道会话能用的只有经 Foundry 提供的工具和连接器，本人家目录里的东西一律看不到。全部是通用改动，没有 olk / bytedcli 的特判。

Worker：

- `skills/session-tools.ts` 新增 `adoptSessionToolsFolder`；`session/workspace.ts` 启动沙箱宿主时把会话的工具目录一并交过去，`session/host-child.ts` 先登记再跑。宿主里的 `sessionEnvironment` 于是和 Worker 一样把它放在 PATH 第一位（Claude、Codex、profile command 共用）。
- `session/verification-session.ts`：沙箱环境带上 `FOUNDRY_TOOLS_ROOT`（Worker 的真实工具目录），宿主不再按 scratch HOME 去找；`readOnlyWorkspaceExecution` 增加 `userFiles` 参数，verifier 仍是 `readable`（要跑本人装的工具链），通道会话（`read-only-workspace-session.ts`）改为 `hidden`。
- `sandbox/linux.ts`：
  - 经链接父目录到达的系统根（`/home/me -> /data/home/me` 下的工具目录）同时挂到 Worker 用的那个名字上，PATH 和工具链接都能解析；
  - 隐藏家目录时，若某个系统根包含家目录（`/opt -> /data00`），先挂这些根，再在家目录上盖一层空 tmpfs（并封为只读），之后才挂家目录里需要的根（工具目录、runtime）。这同样修了 byte-dev 上 Issue 执行/澄清沙箱的泄漏。
- `daemon/session-run.ts`：只读会话的连接器 profile（feishu-cli 读的 `~/.feishu-cli/profiles`）写到该会话沙箱里的 HOME（`readOnlySessionHome`），而不是 Worker 的家目录。

Server：

- `internal/connectors/deviceheld.go` `SessionUses`：`workspaceAccess: "read"` 的会话对设备上每个设备持有型连接器一律 `access: "none"` 并带隔离变量（bytedcli 是 `BYTEDCLI_PROFILE=foundry-no-login`）。这样它不再收到这些连接器的 Skill（bytedcli / codebase / meego 等，`connectorKinds` 只认 `device_login`），沙箱里也没有这个程序可运行，`bytedcli auth login` 根本跑不起来，Agent 不会以为能在通道里登录。与 DEV-229 不改同一文件。

## 验证

byte-dev（Linux，bwrap，家目录是链接，`/opt -> /data00`，正是出问题的那台设备）经 `scripts/remote-check.sh`：

- Worker `read-only-workspace-session.test.mjs` 新增 3 个用例，11/11 通过：
  - 只读会话 `userFiles: hidden`、带 `FOUNDRY_TOOLS_ROOT`、HOME 不是本人家目录、Feishu profile 的 HOME 与沙箱 HOME 一致；verifier 仍 `readable`；
  - 模拟沙箱宿主：登记前 `sessionEnvironment` 的 PATH 里没有会话工具目录（复现根因 1），登记后它在第一位；Claude 和 Codex 的 SDK 启动参数 `env.PATH` 第一位都是它；
  - 真沙箱端到端（stand-in Agent，工具目录放在链接父目录下，复现根因 2）：`command -v olk-like && olk-like` 输出 `olk-like ok`；`touch probe` 被拒、工作区里没有文件；本人家目录下的 `.ssh`、`.config`、`.local`、`.gitconfig`（链接名和真实路径两种）都读不到。
  - **修复前同一测试失败**：`missing; workspace refused; visible /data00/home/dengcanwen/.ssh; visible …/.config; visible …/.local; visible …/.gitconfig`。
- 同时跑 `sandbox`、`verification-session`、`bundle-rollout-tools`、`issue-clarification`、`issue-environments`、`evidence-agent-sandbox`：全部通过（63 个，4 个 macOS 专用跳过）。DEV-203 phase 2 的写拒绝用例（`a read-only session's sandbox refuses writes …`）不变、通过。
- Go：`./internal/connectors` 全部通过（新增“本人的只读会话对每个设备登录都是 none”）；`./internal/httpapi -run 'MessageChannel|DeviceConnector|ReadOnly|ConnectorSkill'` 通过。
- CanWendeMac-mini：Worker 编译通过；这几个需要启动 Agent 的用例在它的 compute 环境里因 `Cannot identify runtime lease owner`（读不到进程启动时间）失败，基线上原有用例同样失败，与本改动无关，所以 Linux 沙箱部分放在 byte-dev 跑。
- 没有在本人账号里建任何数据；byte-dev 上只做了只读查看和测试 job（已清理，见下）。

## 限制与后续

- **bytedcli 在通道会话里不可用是设计结果**：它的登录在本人家目录里。要在通道里查 Codebase / MR，助理派 helper 到普通工作区（DEV-229 修好派发后可用）。如果本人希望设备登录也能在通道里用，需要另做一个 Worker 侧代理（在沙箱外替会话运行这个工具），这是产品决定，本次没做。
- 依赖 DEV-229 的提醒：如果 DEV-229 把只读 helper 也做成 `workspaceAccess: "read"` 会话，它们同样拿不到 bytedcli，查 MR 的主路径就断了；helper 应保持普通会话（这次已告知 conductor）。
- byte-dev 上的 Issue 执行/澄清沙箱现在真正看不到家目录了（原来经 `/opt -> /data00` 漏出来）。编排会话要求先排查会不会因此弄坏 Issue 运行（2026-11-14 只读核对）：线上库只读副本里 byte-dev 近两周 324 个会话全是 chat / agent / naming，没有 Issue 执行或澄清；全库只有 1 个 Issue（2026-11-03，在另一台设备上）。byte-dev 的 `~/.foundry/workspaces/*` 下也没有任何 issues / clarifications 执行目录，只有 verifier（verifier 仍是 readable，不受影响）和通道的 read-only-sessions。所以没有依赖家目录工具链的 Issue 运行，不需要额外挂载，byte-dev 的 Worker 可以照常发布。以后如果有 Issue 运行需要家目录里的工具链，按编排会话的意见单独只读挂载那一个工具链。
- verifier 仍可读本人家目录（按设计，要跑本人的工具链）。
- 真实 Agent 的端到端只能等部署后本人的下一条通道消息：byte-dev 的会话都走外部连接（limen），没有可在测试脚本里直接用的本机 Claude 登录，按规则也不在本人账号里发测试消息。

## 部署

conductor `sess_1794555762602239151` 随 train18-20261113 部署（补丁去掉 docs/ 后应用；本 devlog 与 README 行由本会话写入共享树）：

- Server：sha256 `36e580b1b1ecdae83eed388ce6338b82fe3139e6d04b21ff154081760b19a00b`，2026-11-13T18:28:41Z 起运行，healthz 200；替换 `380677b3…`（train17，DEV-229），回滚副本 `foundry-server.pre-train18-20261113`。
- Worker：`0.5.7-dev.357.g8f394c91.local.1794593951`。byte-dev 18:29:03Z 更新（原 `…1794586501`）；cottoncpp、byte-dev-sg、limen-canada、CanWendeMac-mini、sg-chaos 成功；macbook 离线。conductor 核对：包与上一版只差本次 7 个文件、另一事项的 worker_groups CLI/skill 文本和版本号。
- conductor 在 train 上复跑（byte-dev，Linux bwrap）：`read-only-workspace-session` 24/24；sandbox 等 6 个文件 35/39，0 失败（4 个跳过与本补丁无关）；Go connectors、httpapi 过滤用例、sqlitestore 全部通过。DEV-229 的 `readOnly` 只影响调度，不创建 `workspaceAccess:"read"` 会话，helper 仍拿得到 bytedcli。

部署后检查（2026-11-14，本会话，byte-dev compute lease，只读）：

- `~/.foundry/runtime/current` → `0.5.7-dev.357.g8f394c91.local.1794593951`；daemon（pid 2484852）和新执行宿主（pid 2484862，`…1794593951/execution-host/main.js`）都在 02:29 UTC+8 启动。新回合都进这个宿主；两个旧宿主（`…1794540840`、`…1794583663`）仍在为启动时就在跑的会话排空，没有强停。
- 新宿主的包里就是本次的代码：`host-child.js`、`session-tools.js` 有 `adoptSessionToolsFolder`，`read-only-workspace-session.js` 传 `"hidden"`，`sandbox/linux.js` 有 `holdsHome`，`verification-session.js` 设置 `FOUNDRY_TOOLS_ROOT`。
- 通道工作区部署后还没有新回合（通道会话最后活动 18:25:35Z，早于部署）。按规则不在本人账号里发测试消息，所以真实 Agent 的检查就是下面验收步骤 1–3，等本人下一条 `/ai`。

## 人工验收步骤

1. 在 openlark 自聊里发 `/ai 运行 command -v olk、olk --version 和 touch .dev228-probe，原样告诉我输出`。预期：`command -v olk` 直接给出路径（在 `.foundry-tools/.sessions/…` 下），`olk --version` 有版本号，`touch` 报 `Read-only file system`；回复比以前快（不再先找 olk）。
2. 发 `/ai 运行 command -v bytedcli; ls ~/.ssh /data00/home/dengcanwen/.ssh`。预期：`bytedcli` 找不到；两个 `.ssh` 都不存在或无法访问；助理不建议在通道里登录 bytedcli。
3. 发 `/ai 查一下 MR !618 是否合入`。预期：助理说明通道里没有 Codebase 权限，改为派 helper（需 DEV-229 已部署），不建议登录。
4. 在普通会话（例如 ccm-omh-integration）里 `bytedcli --version`、`olk --version`。预期：和以前一样能用（普通会话不受影响）。
