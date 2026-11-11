# 声明式扩展 v2：bytedcli 行为对照与字段设计

日期：2026-11-11

本文是实现切片 E2 前的行为盘点。只读来源：

- `~/workspace/foundry-private-connectors/bytedcli/adapter.ts`（私有程序扩展的适配器，含 lark 授权）
- `~/workspace/foundry-private-connectors/bytedcli/extension/`（`connector.mjs`、`adapter.mjs`、`foundry-extension.json`）
- `~/workspace/foundry-private-connectors/bytedcli/reference/`（`connectors-device-held.test.mjs`、`fake-bytedcli.mjs`、`bytedcli-outputs.json`、内置版 `bytedcli.ts`）

目标：把该适配器的每个行为写进 `foundry-extension.json` 的 `cli` 数据，Worker 用
`packages/worker/src/connectors/extensions/declarative.ts` 通用地执行，不在 Worker 里保留
bytedcli 分支。bytedcli 的 kind 仍为 `bytedcli`，扩展 id 仍为 `bytedance`。

## 1. 适配器行为 → 声明式表达

| #   | 适配器行为        | 原实现要点                                                                                                                                                                                                                                                       | 声明式表达                                                                                                                            |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 定位工具          | `$FOUNDRY_TOOLS_BIN/bytedcli` 优先，其次 PATH 与常见用户目录                                                                                                                                                                                                     | Worker 通用工具定位：托管 bin 优先，再 `findExtensionCommand`；来源记为 `foundry`/`device`                                            |
| 2   | 运行环境          | 设 `BYTEDCLI_NO_AUTO_UPGRADE=1`、`BYTEDCLI_OPEN_QR_IMAGE=0`；不继承 `BYTEDCLI_PROFILE`、Meego cookie 变量                                                                                                                                                        | `cli.env` 声明前两者；扩展基础环境本身只传白名单，`isolationEnv` 仍在隔离检查时覆盖                                                   |
| 3   | 读版本            | `--version`，正则取 `x.y.z`                                                                                                                                                                                                                                      | `cli.version = { args, pattern }`（已有）                                                                                             |
| 4   | 读登录            | `--json auth status`；`status === "success"` 才算成功                                                                                                                                                                                                            | `cli.envelope` 声明 `ok=/status`、`okValue="success"`、`error=/error/message`、`hint=/error/hint`、`data=/data`                       |
| 5   | 已登录条件        | `data.authenticated === true` 且（`bytecloud_auth.status` 缺省或 `"ready"`）                                                                                                                                                                                     | `status.signedIn` 条件数组；新增 `allowMissing` 让“缺省或等于”可表达                                                                  |
| 6   | 身份              | `bytecloud_auth.identity.username`，去掉 `@` 后的部分；绝不读 email                                                                                                                                                                                              | `status.identity = { pointer, stripAfter: "@" }`                                                                                      |
| 7   | 站点              | `bytecloud_auth.site` → `sites: [site]`                                                                                                                                                                                                                          | 新增 `status.sites`（`ExtensionCliValue`）                                                                                            |
| 8   | 到期              | `login_expires_at`，否则 `bytecloud_auth.refreshTokenExpiresAt`，规范成 ISO                                                                                                                                                                                      | `status.expiresAt = { firstOf: [...], asTimestamp: true }`                                                                            |
| 9   | 扫码登录 begin    | `--json auth login --begin --no-terminal-qr --qr-image <scratch>/sign-in.png`，45s                                                                                                                                                                               | 两步 guided 的 `begin` 调用；模板新增 `{scratch}`                                                                                     |
| 10  | 扫码登录 poll     | `--json auth login --complete`，45s                                                                                                                                                                                                                              | 两步 guided 的 `poll` 调用                                                                                                            |
| 11  | 登录状态映射      | `login_status`：`pending` / `success`+`completed`+`ready` / `expired`；未知状态失败                                                                                                                                                                              | `signIn.device.state = { pointer, map, otherwise }`                                                                                   |
| 12  | 登录页/二维码     | pending 时读 `verification_uri_complete`；begin 若没有可批准页面则失败                                                                                                                                                                                           | `state.verificationUrl`、`state.qrImage`；`requireChallenge` + `missingChallenge` 表达原失败句                                        |
| 13  | 登录错误码        | `BYTECLOUD_AUTH_LOGIN_DENIED` → denied；`...EXPIRED` → expired；其余 failed，带工具 message                                                                                                                                                                      | `signIn.device.errors[]` 错误码规则；未匹配时用 envelope 的 message/hint                                                              |
| 14  | 登出              | `--json auth logout`；envelope 非 success 报错                                                                                                                                                                                                                   | `cli.signOut` 调用，复用 envelope 成功判定                                                                                            |
| 15  | Meego 授权状态    | 版本 ≥ 0.174.0；`--json --site cn meego status`；`data.providers.goapi.state`：`ready`/`missing`/`bootstrap_available`/其它                                                                                                                                      | `authorizations[].read` + 有序 `rules`；`otherwise`、`onError`、`minVersion`、`minVersionState`                                       |
| 16  | Meego 版本门槛    | < 0.174.0 时状态 `unavailable`/`cli_upgrade`；begin 报升级文案                                                                                                                                                                                                   | `authorizations[].minVersion` + `minVersionState` + `upgradeMessage`                                                                  |
| 17  | Meego begin       | `--site cn auth login --begin --session --feishu --no-terminal-qr --qr-image <scratch>/sign-in.png`，30s                                                                                                                                                         | `authorize.begin` 调用；`{scratch}`                                                                                                   |
| 18  | Meego begin 回退  | 遇到 `FEISHU_WEB_SESSION_AUTHORIZE_PARSE_FAILED` 且还没有 continuation/二维码时，只重试一次并追加 `--session-method qr`（25s）                                                                                                                                   | `begin.fallbackWhen` + `begin.fallback`；引擎最多回退一次                                                                             |
| 19  | Meego poll        | `--site cn auth login --complete <continuation>`，45s；continuation 必须匹配 `[A-Za-z0-9._-]{16,128}`，否则 expired                                                                                                                                              | `authorize.poll` 参数模板 `{continuation}`；`state.continuation` / `continuationPattern`                                              |
| 20  | 授权状态映射      | `login_status`：pending；success/completed/ready 只有两个 ready 标志都为 true 才 complete；expired                                                                                                                                                               | `authorize.state.map` + `rules`（两个 ready 标志为 true 时覆盖为 complete）                                                           |
| 21  | continuation 保密 | `complete_token` 只留在设备，公开 step 只含 `challenge: qr_image`                                                                                                                                                                                                | 引擎把 continuation 作为单独返回值，不放进 `ExtensionSignInStep`                                                                      |
| 22  | 授权错误码文案    | `[CODE; phase; exit N] <人话>`；无 JSON 时 `[CLI_NO_JSON; phase; exit N]`；未知 code 归为 `AUTH_UNKNOWN_ERROR`                                                                                                                                                   | `authorize.errors[]`（exact / contains / regex）+ `defaultErrorMessage` + `noJsonMessage`；引擎自动加 `[code; phase; exit]` 前缀      |
| 23  | 授权错误多语言    | 原程序只有英文常量                                                                                                                                                                                                                                               | `message` 等文案字段接受字符串或 `{en, zh-CN}`；Worker 按 `LANGUAGE`/`LANG` 选择，回退 `en`                                           |
| 24  | Lark CLI 授权状态 | `--json lark --no-auto-install auth status`；stdout 优先、否则 stderr；从第一个 `{` 解析；`CLI_PARSE_ERROR` → cli_upgrade；`ok:false`+`error.type:"config"` → needs_auth；任一 identity `available` → ready；有 identities 但都不可用 → needs_auth；否则 unknown | `read.source="stdoutThenStderr"`、`firstObject`、`upgradeWhen`；规则支持 `anyItem` 对对象/数组做“任一子项满足”；`otherwise`/`onError` |
| 25  | Lark 终端授权     | 不能从页面发起，报一句终端命令提示；poll 直接 expired                                                                                                                                                                                                            | `authorize.terminalMessage`，不写 begin/poll；引擎 poll 返回 expired                                                                  |
| 26  | 状态里的授权列表  | `connector.status.authorizations` 返回 id/revision/status/reason；读取失败标 unknown/check_failed                                                                                                                                                                | 引擎按描述符 `authorizationGroups` 逐组读；每组缺失/失败走 `onError`                                                                  |
| 27  | 已安装状态        | 工具不存在：`installed:false, signedIn:false`；存在：`installSource`、`version`                                                                                                                                                                                  | 定位结果给 `installed`/`installSource`；版本调用给 `version`                                                                          |
| 28  | 会话隔离检查      | 隔离环境仍未读到登录                                                                                                                                                                                                                                             | 已有 `isolationEnv` + `declarativeCall(environment)` 叠加到每次工具运行；bytedcli 数据不变                                            |

## 2. 新增的声明式字段

### 2.1 `cli.envelope`

工具统一的 JSON 信封。声明后：

- 成功 = 进程退出码 0（普通调用）且 `pointer(ok) === okValue`（默认 `true`）。
- 失败文案优先读调用自己的 `error`/`hint`，否则读信封的 `error`/`hint`。
- `data` 指向信封里的业务对象；`status`、`signIn`、`authorizations` 的 JSON Pointer 都相对它。
- `code` 指向错误码，供 `errors[]` 规则和授权错误前缀使用。

```json
{
  "envelope": {
    "ok": "/status",
    "okValue": "success",
    "code": "/error/code",
    "error": "/error/message",
    "hint": "/error/hint",
    "data": "/data"
  }
}
```

### 2.2 `cli.env`

Foundry 自己运行工具时设置的变量。基础环境仍是白名单；会话隔离时 `isolationEnv`
叠加在后面并优先。

### 2.3 两步 guided 登录

`cli.signIn.<方法 id>` 仍可以是原来的一次调用；也可以写成：

```json
{
  "begin": { "args": ["login", "--begin"], "timeoutSeconds": 45 },
  "poll": { "args": ["login", "--complete"], "timeoutSeconds": 45 },
  "state": {
    "pointer": "/login_status",
    "map": {
      "pending": { "status": "pending" },
      "success": { "status": "complete" },
      "expired": { "status": "expired" }
    },
    "verificationUrl": "/verification_uri_complete",
    "qrImage": "/qr_image_path",
    "requireChallenge": true,
    "missingChallenge": "The tool started a sign-in without a page to approve it on."
  },
  "errors": [
    {
      "code": "LOGIN_DENIED",
      "step": { "status": "denied", "error": "The sign-in was denied." }
    }
  ]
}
```

`state.rules` 可在 map 之后按条件覆盖结果。

### 2.4 `cli.authorizations[]`

每个描述符 `authorizationGroups` 对应一项：

- `group` / `revision`：绑定描述符里的授权组。
- `minVersion` / `minVersionState` / `upgradeMessage`：版本门槛。
- `read`：状态读取命令、输出来源、`firstObject`、`upgradeWhen`、有序 `rules`、`otherwise`、`onError`。
- `authorize.begin` / `poll` / `state` / `errors`：页面发起授权与轮询。
- `begin.fallbackWhen` / `begin.fallback`：指定错误码后的一次回退。
- `authorize.terminalMessage`：不能从页面发起时给出的终端说明。

### 2.5 条件与值

条件新增：

- `anyItem`：数组元素或对象值里任一子项满足条件。
- `allowMissing`：缺失值也算满足 `equals`/`includes`/`nonEmpty`。
- `nonEmpty` 现在接受 `false`，表示缺失或空。

值新增：

- `firstOf`：按顺序取第一个有值的 pointer。
- `stripAfter`：截断（bytedcli 用户名在 `@` 前）。
- `asTimestamp`：规范成 ISO 时间。

### 2.6 错误码到文案

`errors[]` 规则按顺序匹配：

- `code`：精确匹配。
- `contains`：字符串或字符串数组，任一子串匹配。
- `regex`：正则。

每条规则给 `step`（登录）或 `step`/`step`（授权）。文案可以是字符串或
`{"en": "...", "zh-CN": "..."}`。授权错误自动加 `[CODE; phase; exit N]` 前缀，
使页面仍能看到安全、可诊断的 provider code。

## 3. bytedcli 数据与测试

- 数据放在 `extensions/bytedcli/foundry-extension.json`，无 `entry`，只声明 `cli`。
- 通用能力用合成 CLI `acmecli` 测：envelope、两步登录、状态映射、continuation、
  回退、minVersion、错误码与多语言文案、`anyItem`、`allowMissing`、环境变量。
- bytedcli 数据另做对照测试：用移植自 `reference/fake-bytedcli.mjs` 的夹具，
  对照 `reference/connectors-device-held.test.mjs` 的断言检查登录、扫码、授权、
  版本门槛、回退、状态映射与错误文案。
