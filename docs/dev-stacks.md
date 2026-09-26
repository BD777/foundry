# 并行开发栈（N 套 Foundry 同时跑）

两个方向同时推进时，不要共用一套服务：Issue 的执行、取证和验收都会写进
本机私有状态，两个 daemon 抢同一份状态一定互相破坏。每个方向用一个 Git
worktree，配一套自己的 server / worker / web。

`scripts/dev-stack.mjs` 目前只支持 macOS：服务由 launchd 托管（LaunchAgents
plist + `launchctl`），Linux 上请按[开发指南](development.md)手动为每套栈指定
端口、数据库和状态根。

## 快速使用

一条命令从「什么都没有」到「已验证可用」：新建 worktree 和分支、安装依赖、
构建、装 launchd 服务、起服务、体检，最后真跑一次模型会话。

```bash
node scripts/dev-stack.mjs create lab \
  --worktree ../foundry-lab --branch lab \
  --provider-env ~/.foundry-stacks/main/provider-env   # 可选，见下
```

```bash
# 已有 worktree 就不用 --branch
node scripts/dev-stack.mjs create lab --worktree ../foundry-lab

# 出问题先体检：每项都给出可执行的修法，退出码非 0 表示这套栈不能干活
node scripts/dev-stack.mjs doctor lab

# 让工具自己修：重建、重建工作区身份、修权限、重写 plist、重启，按依赖顺序执行
node scripts/dev-stack.mjs fix lab

# 给 Agent / CI 的结构化结果
node scripts/dev-stack.mjs doctor lab --json

# 只跑真实模型闭环（server → daemon → provider，断言模型自己说出的口令）
node scripts/dev-stack.mjs smoke lab

# 看全部栈（含默认栈）的端口和进程
node scripts/dev-stack.mjs list

# 控制
node scripts/dev-stack.mjs restart lab
node scripts/dev-stack.mjs stop lab
node scripts/dev-stack.mjs remove lab            # 保留状态目录
node scripts/dev-stack.mjs remove lab --purge-state
```

也可以走 `pnpm stack <command>`。脚本本体拆成三块：
`scripts/dev-stack/stack.mjs`（注册表、plist、构建、生命周期）、
`scripts/dev-stack/doctor.mjs`（检查与自动修复目录）、
`scripts/dev-stack/create.mjs`（建栈流程），`scripts/dev-stack.mjs` 只做分发。

`create` 默认在起服务后执行 `doctor` + `smoke`；只想要服务加 `--no-smoke`。
`start` / `restart` 每次都按当前生成器重写 plist，所以脚本里修好的 PATH、
凭据注入这类问题，老栈重启一次就自动获得，不用手改 `~/Library/LaunchAgents`。

端口由 base 派生：`server = base + 982`，`web = base + 983`。默认栈是
base `31000`（31982 / 31983），新栈默认从 `41000` 起、每套 +1000，也可以
`--port-base 43000` 自己指定。

## 体检目录：每一条都带修法

`doctor` 把「这套栈能不能干活」拆成固定的检查项，轮询到稳定态（服务注册、
daemon 连上、profile 上报健康要几秒）再下结论。只有 `FAIL` 影响判定，
`warn` 是提示。带 ✅ 的项 `fix` 能自己修好。

| 分组     | 检查                                                                       | 自动修              |
| -------- | -------------------------------------------------------------------------- | ------------------- |
| 工作区   | 是不是 Foundry worktree、pnpm/go/git 在不在、`node_modules` 有没有         | ✅（装依赖并重建）  |
| 构建     | protocol / worker / server 产物存在且不比源码旧、worker 认 `FOUNDRY_STACK` | ✅（重建）          |
| 身份     | `.foundry/workspace.json` 存在且指向本 worktree（拷贝来的会去动别的仓库）  | ✅（重建身份）      |
| 权限     | 状态根 0700、`provider-env` 0600                                           | ✅（chmod）         |
| 注册     | 在 `stacks.json` 里、worktree 与端口不与别的栈重合                         | ❌（要人判断）      |
| 启动项   | 三个 plist 与当前生成器一致（手改或过时会漂移）                            | ✅（重写＋重启）    |
| 进程     | server/web/worker 各自的 pid、是否在 KeepAlive 里反复重启                  | ✅（重建＋重启）    |
| 端点     | `/healthz`、web、控制面 API 是否应答                                       | ✅（重启）          |
| 运行时   | 工作区是否注册、daemon 是否在线                                            | ✅（重启/重建身份） |
| 日志     | 协议不匹配、找不到工作区、CLI 缺失、server 断连等已知信号的含义            | ❌（只解释）        |
| provider | 每个 profile 的健康度、密钥可能来自哪里、哪份备份里还有                    | ❌（不碰密钥）      |
| 可运行   | healthy profile 对应的 CLI 是否在**服务的** PATH 上、至少一个能跑          | ✅（重写 plist）    |

密钥缺失时不会瞎猜，而是把候选来源全列出来，例如：设备文件里这条 profile 的
`apiKey` 是空的、`agent-profiles.local.json.bak-server-credential` 里还有一份、
本栈 `provider-env` 没导出任何一个候选变量，然后给出两条具体写法。

`smoke` 用健康的 profile 建一个真实会话，要求模型只回 `FOUNDRY-<NAME>-OK`，
再从 `.foundry/sessions/<id>/result.md` 里校验这串字。它证明的是整条链路，
不是某个接口返回 200。

## 给 Agent 的用法

先 `fix`，再看退出码，只有剩下的边界问题才需要人/Agent 介入：

```bash
node scripts/dev-stack.mjs fix lab --json   # 0 = 可用；非 0 = 还有 FAIL
```

`--json` 输出 `{ stack, ready, applied, checks[] }`，`checks[]` 每项是
`{ id, level, text, detail?, fix?, repair? }`：`id` 稳定可断言，`fix` 是给人看的
下一步，`repair` 是工具自己能跑的动作。日志类结论永远是 `warn`，因为日志留着
历史，判定只看当前实测状态。

## 凭据不在设备文件里时

provider 的密钥正常放在共享的 `~/.foundry/agent-profiles.local.json`。如果某套
栈要用一份不在那里的密钥，把它写进该栈状态根的 `provider-env`（`KEY=value`
一行一个，权限 0600），worker 启动时会 source 它：

```bash
printf 'ANTHROPIC_AUTH_TOKEN=%s\n' "$TOKEN" > ~/.foundry-stacks/lab/provider-env
chmod 600 ~/.foundry-stacks/lab/provider-env
node scripts/dev-stack.mjs restart lab
```

`create --provider-env FILE` 会把现成的文件复制进去。密钥只留在这个 0600 文件里，
plist 里出现的只有路径。

## 每套栈独占什么

| 资源     | 位置                                                   | 说明                                                                                      |
| -------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 数据库   | `<私有状态>/server/foundry.db`                         | 随栈的私有状态隔离，不在 worktree 里；旧栈的 `apps/server/.data` 需按 Server 启动提示迁移 |
| 私有状态 | 默认栈 `~/.foundry`；命名栈 `~/.foundry-stacks/<name>` | 设备身份与凭证、工作区注册表、Issue 执行环境、锁、日志                                    |
| 账号     | 每套栈自己的 `stack-admin`                             | `start` 首次自动创建并配对 worker；网页登录密码在私有状态里的 `admin-password`（0600）    |
| 服务     | `dev.foundry.<name>.{server,web,worker}`               | 默认栈保持 `dev.foundry.*` 不变                                                           |
| 端口     | base+982 / base+983                                    | `create` 会先检查端口空闲                                                                 |

Issue 执行器的沙箱会拒绝读取**所有**栈的私有状态（`~/.foundry` 与
`~/.foundry-stacks` 两个父目录一起禁），所以一套栈里跑的 Agent 读不到另一套
的证据。

## 每套栈共享什么（隔离不了，要心里有数）

- **模型凭据与网关**：`~/.claude`、`~/.codex` 是同一份。两套栈同时跑实现或
  验证会互相抢额度和速率，用设备的 `maxConcurrentTasks` 控制并发。
- **Agent profiles**：`~/.foundry/agent-profiles.local.json` 仍是共享的，这是
  故意的——provider 配置不该按栈复制。
- **被 Issue 操作的目标工作区**：如果两套栈注册了同一个目录，它们会对同一份
  代码开 worktree。想彻底隔离就给每套栈用不同的测试工作区。

## 已知陷阱

1. **worktree 落后于状态根改造**：旧代码没有 `FOUNDRY_STACK`，它的 worker 会
   直接写 `~/.foundry`，和默认栈抢设备身份与注册表。`create` / `start` 现在
   会检查 `packages/worker/dist/state-root.js` 是否存在，缺了就拒绝启动。
2. **`.foundry/workspace.json` 带着绝对路径跟着 checkout 走**：第二个 worktree
   会声称自己是主 checkout（同一个 workspace id 和 path），于是 lab 栈可能对
   主目录动手。该文件因此不进 Git（见 `.gitignore`）；`readWorkspace()` 发现
   身份文件里的路径不是当前目录时，会就地换一个新 id 和正确路径。
3. **`~/.local/bin` 不在服务 PATH 上**：launchd 不读 shell 配置，而 `claude`
   装在 `~/.local/bin`。生成的 PATH 少了它，会话会在 50ms 内失败并报
   `Claude Code CLI is not available on PATH`，看起来像凭据问题。生成器已把
   这个目录写进 PATH，`doctor` 也会用服务 PATH 直接检查 `command -v claude`。
4. **`launchctl bootout` 是异步的**：紧接着 `bootstrap` 会拿到
   `Bootstrap failed: 5: Input/output error`，`restart` 随机失败。现在会等
   `launchctl print` 报不存在（最多 5 秒）再 bootstrap。

## 部署前的规矩仍然适用

重启任何一套栈之前：

```bash
node scripts/prepare-evidence-local-deployment.mjs --stack lab
```

它会在有活动 Run/Session 时拒绝继续，然后为该栈留一个还原点：数据库、服务定义、
server 二进制和工作区注册表。默认栈不加 `--stack` 即可。

还原点是 **copy-on-write 克隆，不是字节拷贝**。APFS 上克隆与实库共享数据块，所以
一个还原点的代价接近零字节、零秒，不随数据库变大而变贵。克隆有被并发写撕裂的风险，
因此每次都会 `PRAGMA quick_check` 验证，失败时自动退回 `sqlite3 .backup`（真拷贝，
但与写者串行）；文件系统不支持克隆时同样退回。

注意 `du` 会把克隆按完整大小重复计入，看起来远大于实际；以 `df` 为准。

保留策略：

- 普通还原点保留最近 `--keep` 份（默认 10），更旧的自动淘汰。
- **迁移边界**例外：某份快照之后 schema 变了，它就是旧 schema 最后的状态，无法再
  复现。脚本靠比对 `sqlite_master` 摘要识别出这种快照并永久保留。
- 早于 `manifest.json` 格式的旧目录一律不自动删除，需要显式 `--prune-legacy`。

删除任何一份快照之前，脚本会逐表按主键比对：快照里有、实库已经没有的行，先搬进
`~/.config/foundry/salvaged-<时间戳>.db` 再删目录。回收磁盘不能成为丢历史的途径。

## 后续（roadmap）

这套「验证用的本机资源」将来要变成 Foundry 产品里的[资源池](tool-use-and-resources.md#shared-resource-scheduling)：按需申请一套
隔离环境、用完回收，而不是靠开发者手工建栈。当前脚本是那条路的最小可用形态，
接口（名字、端口基址、状态根、服务标签）刻意保持显式，方便之后交给产品托管。
