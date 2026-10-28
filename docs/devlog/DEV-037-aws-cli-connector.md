# DEV-037 AWS CLI 设备连接器

2026-10-23，用户要求「connector 添加 aws cli 支持」。沿用设备持有型连接器，不建立第二套 AWS 凭据存储。

## 实现范围

- 全局 Connectors 新增 AWS CLI 页，Workspace Connectors 可绑定本人的执行设备，沿用成员共享选项和设备所有权校验。
- 使用设备已有 `aws`，通过 `aws --version` 和限时 `aws sts get-caller-identity --output json` 检查。支持 AWS CLI v1/v2 的版本输出；使用 Worker 的原生凭据链（AWS_PROFILE/default、环境变量、SSO、设备角色）。只持久化账户/身份元数据；不读取、导出或上传密钥，不记录原始错误输出。
- 缺少/失效凭据显示未登录；网络、配置、未知 STS 失败显示检查失败，不把缓存身份当作当前可用，也不把 STS 成功解释为服务权限齐全。
- 安装、登录、续登和退出由用户在设备终端完成。目录增加 `source: device` 和 `authentication: local`，页面隐藏不支持的托管安装/登录/退出动作。未实现网页 SSO 授权或逐 Workspace profile 选择。
- 获授权的会话保留设备原生凭据链，并收到核验身份、不要擅自切换 profile 或修改登录的说明。其他成员未获授权的会话覆盖静态凭据、profile、配置文件、Web Identity、容器凭据及 EC2 metadata 来源；CLI 未安装时也应用隔离。沿用现有语义：设备所有者自己的未绑定会话不额外隔离；未沙箱进程仍可主动绕开环境隔离，这不是系统安全边界。

## 官方依据

[STS GetCallerIdentity](https://docs.aws.amazon.com/cli/latest/reference/sts/get-caller-identity.html) 返回当前 IAM 用户/角色，不证明业务服务权限。[凭据优先级](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-authentication.html) 和 [环境变量](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html) 决定检测及隔离范围。[SSO 配置和登录](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html) 由设备原生 CLI 管理。

## 验证与交付

- Worker AWS 定向 4 项通过：严格身份解析、分区支持、错误脱敏、缺失/过期与网络失败区分、版本输出、超时、拒绝登录修改、真实假 CLI 子进程、会话隔离及未安装隔离。
- Server 目录、绑定资格和 HTTP 设备连接器定向测试通过；Web 设备连接器 9 项通过，包含 AWS 四种状态及检查操作。
- 完整相关检查、浏览器和部署结果在下方追加。当前设备未安装真实 AWS CLI，未验证真实 AWS 账户。
- 人工验收待确认：设备安装/配置 AWS CLI → Connectors/AWS CLI 重新检查 → Workspace Connectors 绑定 → 新会话运行只读 STS 身份检查。命名 profile 由 Worker 的 AWS_PROFILE 选择，终端临时 export 不会改变已经运行的 Worker。

## 2026-10-23 交付证据

浏览器发现 Workspace 复用按钮原本会启动 bytedcli 的登录流程，已修正：本地管理的 connector 重新检查 STS，只有成功才绑定；失败保留未绑定。新增回归覆盖成功、过期拒绝、不启动登录。通用成员共享文案改为当前服务的身份/权限，避免 AWS 页面出现字节跳动描述。

- `scripts/check-changed.sh --files` 首轮除 Web 翻译键类型检查外均通过（协议、Worker 四个相关测试文件、Server HTTP/Connector/Store、模块/契约/UI 审计）。翻译键修正后，最终 Web 子集检查全部通过：类型、两个相关测试文件、10 项 UI 审计与格式；记录 `/tmp/aws-connector-checks.log`、`/tmp/aws-connector-web-final.log`。AWS Web 专项两项另行通过。生产 Web、Server 和 Worker 包均构建成功，`git diff --check` 通过。
- 真实 Chromium 合成 fixture 检查浅色桌面、中文暗色390px、未安装/未登录/错误/离线、检查忙态、键盘 Enter 绑定、成员共享开关和解绑。未登录 AWS 不出现授权按钮；绑定成功无登录弹窗。截图 `.foundry/attachments/20261023/aws-connector/`。
- dev Server PID2998884，实际加载二进制 SHA256 `d71d81977b0460f4d57de141325ef54ccd0eb5cf238bc3b2079c30efa6ceab77`，本机 `/healthz` 为 ok、startedAt `2026-10-23T03:28:37Z`。Web `90f983216c5cc75a` 已部署，公网 version.json 与页面 meta 一致。
- 独立 e2e-alice 账号在真实公网 `/connectors/aws` 登录后，API200 返回 AWS 目录；桌面/暗色390px页面正常，无横向溢出和浏览器错误。测试账号的设备均未用真实 AWS 凭据；没有修改其绑定。
- Worker 包 `0.5.7-dev.57.gb316fc8.local.1792725931` 已发布并通过标准 update 安装，daemon PID3000334 已重启。安装产物直接调用 AWS adapter 实测本机为 `not_installed`。源码与部署清单在 `~/.foundry/server/releases/dev037-aws/`，旧 Server binary、Web index/version、Worker release pointer 均保留回滚副本。构建后磁盘余量约13GiB、使用率88%。

### 仍待完成

实际执行宿主 PID2144701 仍加载旧版 `0.5.7-dev.52.g7e5297f.local.1792605745`，因为本会话及两项既有持久合成服务仍在运行，标准更新有意保留它们；**不能声称新会话已加载 AWS 说明及隔离**。宿主会在完全空闲后自动切换；若需立即生效，须按 `AGENTS.md` 获准维护后暂停/恢复既有服务并重启宿主，再核验实际加载。未强停任何既有服务，也未创建自动维护计划。

真实 AWS CLI/账户核验与人工验收仍待完成。AWS CLI 的原生安装和登录不包含在本次 connector 代码接入内；用户可在已有 AWS CLI 的设备配置凭据后检查并绑定。代码保留在本地 main，未自动提交。

## 2026-10-24 合入前 review

- 还原 `catalog.json` 中被重新序列化成 `\u` 转义的 Meego 中文标签（语义不变，避免噪音 diff）。其余实现无需修改；合入前全量变更检查通过，随 DEV-036/039/040 一并合入主干。

## 2026-10-24 PR #144 CI 修复

- 现象：CI run 40103179806 / 40103175706 中 `connectors-aws.test.mjs:145` 期望 `ready`，实际 `signed_out`。
- 原因：测试问题，非产品缺陷。连接器按 node 所在目录 → PATH → Foundry 工具目录查找命令（设备自装优先，符合设计）；GitHub runner 镜像自带无凭据的 `aws`，于是先于测试假 CLI 被执行，正确返回未登录。本机未装 `aws`，所以本地通过。bytedcli 测试有同类隐患（主机装有 bytedcli 时 4 项失败）。
- 修复：新增 `packages/worker/test/fixtures/host-tools.mjs` 的 `hideHostTools`，在两个连接器测试文件内把 PATH 指向空目录并在结束后恢复；若命令与 node 同目录（无法隐藏）则明确失败。新增“PATH 上的 AWS CLI 优先于 Foundry 工具目录”回归测试，固定产品查找顺序。产品代码未改，无需重新部署。
- 验证（隔离 runner `scripts/run-worker-tests.mjs`）：两文件 19/19 通过；PATH 上放置返回 “Unable to locate credentials” 的假 `aws` 时，旧测试复现 CI 的 `signed_out`≠`ready`，新测试 19/19 通过；PATH 上放置假 `bytedcli` 时，旧文件 4 项失败，新文件 14/14 通过。
