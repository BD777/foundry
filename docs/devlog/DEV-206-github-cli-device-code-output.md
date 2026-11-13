# DEV-206 GitHub CLI 2.103.3 设备码文案变化导致登录超时

## 状态

已修复并部署 dev，未提交。最终 Worker `0.5.7-dev.357.g8f394c91.local.1794544799` 已通过 `update_worker` 更新到 7 台在线设备；CanWendeMac-mini 的执行宿主也已确认加载该版本，并已用部署后的解析器接住真实的 `gh 2.103.3` 设备码输出。等待本人在 CanWendeMac-mini 的 Connectors 中完成 GitHub 设备授权。

## 问题

在 Connectors → GitHub CLI → CanWendeMac-mini → “使用代码登录”中，页面约 30 秒后报错：

> The sign-in did not finish: GitHub CLI did not show a sign-in code in time.

设备上的 GitHub CLI 为 Foundry 安装的 2.103.3，状态是未登录。

## 复现与根因

在 CanWendeMac-mini 上用 Worker 相同的 argv、非 TTY stdio 和环境复现：

```text
gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key
GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 GH_SPINNER_DISABLED=1
NO_COLOR=1 GH_BROWSER=true BROWSER=true
```

`gh 2.103.3` 在约 0.6 秒内把设备码写到 stderr，但文案已经改变：

```text
! One-time code (XXXX-XXXX) copied to clipboard
Open this URL to continue in your web browser: https://github.com/login/device
```

旧版本是 `First copy your one-time code: XXXX-XXXX`。Foundry 的解析器只接受冒号后的代码，因此把 2.103.3 的有效代码丢掉，直到超时。

## 修复

- `parseGhDeviceCode` 同时接受旧版 `one-time code: XXXX-XXXX` 和新版 `one-time code (XXXX-XXXX)`，继续要求代码和固定的 `https://github.com/login/device` 页面同时存在。
- 如果文案再次变化，但输出中同时有设备 URL 和恰好一个 `[A-Z0-9]{4}-[A-Z0-9]{4}`，直接按形状接住；纯数字日期/版本形状和多个候选都会拒绝，避免猜错。
- 30 秒内没有解析到代码时，错误里附带 gh 最近 4 行输出，并用通用 secret redaction 和设备码形状替换敏感值。
- 回归测试覆盖旧文案、gh 2.103.3 文案、重新措辞的单一代码形状、日期/多候选拒绝，以及超时输出的脱敏尾部。
- 检查：`check-changed.sh` 的 Prettier、Worker build/typecheck、27 个相关测试文件和模块审计全部通过；GitHub connector 定向测试 20/20 通过。

## 部署

- 在 `/tmp/fdy-deploy.lock` 下把共享树打包到 `~/.foundry/server/worker-packages`；最终发布版本为 `0.5.7-dev.357.g8f394c91.local.1794544799`。回滚副本在 `~/.foundry/server/worker-packages-rollback/before-dev206-hardening/`；首次文案修复前的版本另存于 `before-dev206/`。
- `GET https://dev.foundryapp.app/api/worker/release` 已返回该版本，包内 `dist/connectors/github.js` 已确认包含新解析器。
- 同一包也带上已通过独立检查的 DEV-207 external-connection 短暂失败重试；两边没有做重复发布。
- `update_worker` 更新了 CanWendeMac-mini、byte-dev、byte-dev-sg、cottoncpp、limen-canada、macbook、sg-chaos；7 台均报告 daemon 版本与新发布一致。CanWendeMac-mini 的执行宿主入口和 `identity.json` 都已指向该版本。

## 部署后设备验证

在 CanWendeMac-mini 上从部署后的 `runtime/current` 导入 `parseGhDeviceCode`，以与 Connectors 相同的 argv、非 TTY stdio 和环境启动一次真实的 `gh 2.103.3` 登录：

- 新解析器导入成功。
- 最终发布版约 2.5 秒后从合并的 stdout/stderr 中解析到设备码和 `https://github.com/login/device`；首次版本检查耗时约 805 ms。
- 读取完后立即终止整个进程组，没有在 github.com 输入代码或完成授权。
- 一次性代码没有写入日志或回答。
- 超时错误助手在同一设备上返回最近输出行，并确认 token-like 文本已被脱敏。

## 验收步骤

1. 打开 Connectors → GitHub CLI，选择 CanWendeMac-mini。
2. 点击“使用代码登录”。
3. 页面应直接显示一次性代码和 `https://github.com/login/device`，不再等待 30 秒后报错。
4. 复制代码，打开链接，粘贴代码并授权；这一步由本人完成。

预期结果：Foundry 页面在 GitHub 授权完成前保持等待；完成后 Connectors 显示 GitHub 账号和可用权限。

## 限制

- 本次没有代本人完成 GitHub 授权，也没有读取或输出设备码、token 或浏览器凭据。
- 验证时 CanWendeMac-mini 处于锁屏状态，macOS 同时拒绝屏幕控制和 Edge 浏览器资料访问，因此没能自动点击 Connectors 产品页；部署后真实设备检查走的是产品页同一个 Worker adapter/parser。
- 产品页的最终授权仍由本人完成。

## 追加：权限卡布局与“除删除外全部”预设

2026-11-13 追加修复 GitHub CLI 设备卡的两个问题，并增加一个权限预设。

### 问题与根因

- “GitHub 权限”能力行的状态和操作列在长文案旁被压缩：操作列本身允许收缩，按钮基类又带 `min-w-0`，于是“本地凭据就绪”越出卡片右缘，“更改权限”的文字溢出按钮。
- “Changed in Foundry …” 把 34 个 scope 全量塞进一行，既撑宽卡片，也无法快速看出改了多少项。

### 修复

- 按钮基类改为不收缩，能力行允许整体换行；说明列使用可收缩 basis，状态与操作列作为不可收缩的右对齐单元。三个能力行现在共享同一条右边缘，空间不足时操作区整体落到说明下方。
- scope 变更摘要只显示新增/移除数量，例如“新增 34 项”；完整、带正负号的 scope 列表放进原生 details，以可换行 chips 展示。`34 of 34 listed scopes granted` 保持独立显示。
- 新增数据驱动的 authorization preset：`all-except-delete`，本地化名为「除删除外全部（34 项）」。它从 Foundry 已列出的 34 个 scope 中排除 `delete_repo` 与 `delete:packages`，选择后仍走原有 `gh auth refresh` 变更流程；推荐默认集未改。
- preset 的提示明确说明 OAuth scope 粒度很粗：`repo` 仍可删除分支、issue 和评论，`admin:*` 仍可移除密钥和 hook。UI 同时列出两个被排除的 scope，不宣称比已列清单更完整。

### GitHub 文档差异

按 GitHub 当前 OAuth scope 文档的通用页面核对：文档列出 40 个名称，Foundry 列出 34 个。未静默补入的 6 个是：

- GHES：`site_admin`
- GHEC/GHES：`admin:enterprise`、`manage_runners:enterprise`、`manage_billing:enterprise`、`read:enterprise`
- 受特性开关控制且 Foundry 有意不申请：`offline_access`

两个删除 scope 只有 `delete_repo` 和 `delete:packages`。

### 验证

- Web：`pnpm typecheck` 通过；`pnpm audit:ui` 全部通过；相关 Web 测试 36/36 通过，覆盖 preset 内容、排除项、选择后的 scope 集合与详情折叠。
- Server：connector catalog 定向 Go 测试和 `go build ./...` 通过；OpenAPI 生成审计通过，无 breaking change。
- 最终浏览器构建 `0b8dc4951945d2a1`，用 e2e-alice 登录、只在浏览器内替换 `GET /api/connectors` 和 `GET /api/connectors/devices` 的合成卡片数据。实测 1280px 和 900px 下三条能力行右缘分别为 `1206/1206/1206` 与 `826/826/826`，卡片 `scrollWidth == clientWidth`，按钮 `clientWidth == scrollWidth`。在 520px 视口下卡片的 GitHub permissions 操作区会换到说明下方，三条操作区仍右对齐到 475px，卡片为 `440/440` 且按钮不裁字。折叠摘要为“新增 34 项”，展开后有 34 个 chips。
- 实际（未 mock）认证 `GET /api/connectors` 返回 200，GitHub permissions 的 preset 为 `all-except-delete`，排除项正好是 `delete_repo`、`delete:packages`。
- 截图：`.foundry/attachments/20261113/dev206-card-{light,dark}-{collapsed,expanded}.png`、`dev206-card-dark-900.png`、`dev206-preset-zh-dark-1280.png`。

### 部署

- Server 使用 DEV203H 的隔离快照 `/home/windeng/workspace/foundry-deploy203`（HEAD `8f394c91` + 合并时共享树改动，DEV-209 文件已还原），其中已包含本 preset。线上 Server child SHA-256 为 `d7b03105359d562aeb422c2f52ba796ff39b0fc1ce226fd8c838fe51d53ff8f9`，`/healthz` 的 `startedAt` 为 `2026-11-13T08:58:01Z`；`/proc/1470734/exe` 哈希与发布文件一致。
- Web build `0b8dc4951945d2a1` 在 `/tmp/fdy-deploy.lock` 下发布，脚本确认入口资源一致、同源 API 返回 JSON；前一版入口保存在 `~/.foundry/server/web-releases/dev206-github-permissions/previous-20261113T085925Z/`。
- preset 位于 Server 的 connector catalog/contract；Worker 只是继续按现有 options 执行 `gh auth refresh`，因此本次没有 Worker 发布或 `update_worker`。
- 首次独立 Mac mini remote-build 尝试遇到设备短暂 `device_offline` 后释放了 lease；最终使用 DEV203H 已从同一快照构建并验证过的 artifact，没有使用 byte-dev，也没有重新引入 DEV-209。
- 未提交。
