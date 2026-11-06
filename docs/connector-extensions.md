# 连接器扩展

[连接器](connectors.md) · [文档索引](README.md)

Foundry 内置的连接器只有公开服务：飞书、Cloudflare（Server 持有）和 AWS CLI、GitHub CLI（设备持有）。公司内部工具、私有模型网关这类连接器不进公开仓库，而是以**连接器扩展**的形式由设备所有者装在自己的设备上。扩展是一个文件夹：一份 `foundry-extension.json` 加一个程序；Worker 按需启动这个程序，用一个小协议和它对话。Server 和 Web 不加载任何扩展代码，只按扩展声明的数据（描述符）渲染和校验。调研与取舍见 [research/connector-extensions.md](research/connector-extensions.md)。

## 边界

- **只做外层转换。** 扩展（程序或声明式）只调用工具公开的命令行，不要求工具实现 Foundry 的协议，也不把 Foundry 的东西放进工具自己的仓库。
- **只扩展设备持有型。** 私有服务一般在内网、用公司 SSO，本来就不该把凭据放到 Server（bytedcli 当初就这么判断）。Server 持有型（网关、逐请求检查、刷新）需要代码跑在 Server 上，只有内置的公开服务才这样做。以后要接私有 SaaS 的 Server 持有型连接器，只做纯数据（声明式 OAuth / API key + 注入模板），Server 永远不跑扩展代码。
- **只由设备所有者安装，到自己的设备上。** 在设备的终端里 `foundry-worker extension add`，或在 Connectors 页上点击（从扩展发布的 git 文件夹，见“来源”）。代码由设备自己用它的 git 凭据拉取，Server 从不经手扩展代码；会话、Workspace 和 Server 都不能自行安装、更新或移除扩展。2026-11-04 本人决定取消原先“只能在本机用命令装”的限制：页面上的安装和 Install bytedcli 一样，是设备所有者明确点击、在自己设备上以自己身份运行的代码，安全边界不变，易用性高得多。
- **扩展以设备用户身份运行，不是沙箱。** 和会话本身一样信任设备所有者装的东西；Worker 只给它普通环境（`HOME`、`PATH`、语言、代理与 CA 变量），从不给 Worker 自己的凭据，也不读它的 stderr。

## 安装与登记

```sh
foundry-worker extension add ./my-company-connector   # 从本地文件夹安装或更新，打印一行 JSON
foundry-worker extension add https://github.com/acme/tools.git --path foundry-extension [--ref main]
foundry-worker extension update my-company            # 从安装时的仓库取最新提交
foundry-worker extension list [--json]
foundry-worker extension remove my-company
```

- `add` 把文件夹复制到 `~/.foundry/extensions/<id>/current/`，记录文件内容的 SHA-256（`~/.foundry/extensions/registry.json`）。每次启动扩展前核对一次，文件被改过就拒绝启动，提示重新 `add`。同样的文件夹再 `add` 是 `unchanged`；内容变了是 `updated`，原子替换。
- 拒绝：协议版本不匹配、id/manifest 不合法、含符号链接、超过 4000 个文件或 256 MiB、连接器 kind 与内置连接器或其他扩展重名。退出码：2 不合法，3 kind 冲突，4 未安装，5 仓库拉取失败。
- 扩展自己的私有目录 `~/.foundry/extensions/<id>/data/`，更新时保留，卸载时删除；卸载同时删掉它提供的模型服务。
- 运行中的 Worker 在一次心跳（约 25 秒）内上报变化，从页面装的立即上报；Server 校验每个描述符（`internal/connectors/extensions.go`、`descriptor_checks.go`）后存到设备记录上，只给设备所有者看，只在那台设备上提供。

## Manifest

```json
{
  "manifestVersion": 1,
  "id": "my-company",
  "name": "My Company tools",
  "version": "1.0.0",
  "protocol": 1,
  "entry": { "command": "node", "args": ["${extensionDir}/connector.mjs"] },
  "connectors": [ { "kind": "corpcli", "label": "corpcli", "tool": { "command": "corpcli", "source": "npm", "package": "@corp/cli", "registry": "device" }, "signIn": { "methods": [ … ] } } ],
  "source": { "git": "https://github.com/acme/tools.git", "path": "foundry-extension" },
  "setup": { "command": "npx @corp/foundry-extension install" }
}
```

- `entry.command`：绝对路径、`${extensionDir}/…`、`node`（Worker 自己的 Node.js）或设备 PATH 上的命令名（另查 `~/.local/bin`、`~/.npm-global/bin`、`~/.bun/bin`、`/opt/homebrew/bin`、`/usr/local/bin`）。`args` 里的 `${extensionDir}`、`${dataDir}` 会被替换。
- `connectors[]`：连接器描述符（`packages/protocol/src/connectors.ts` `ConnectorDescriptor`），与内置目录 `catalog.json` 同一份结构。Worker 把它们设为设备持有型、`adapter: "extension:<id>"`，并附上 `extension`（id、名称、版本）与 `setup`。
- `source`：扩展发布所在的 git 文件夹（见“来源”）。有了它，其他设备在页面上一键安装、更新。
- `setup`：没有 `source` 时，在其他设备上安装它的一行命令（或说明页），连接器页面对没装它的设备显示并可复制。

## 来源

`source` 是 `{ "git": 远程地址, "path": 仓库里的文件夹, "ref": 分支或标签 }`，`path` 缺省为仓库根，`ref` 缺省为默认分支。远程地址只接受 https（地址里不能带用户名或令牌）、`ssh://` 和 `host:path` 形式；Server 与 Worker 都检查（`descriptor_checks.go` `CheckExtensionRepository`、`manifest.ts` `parseExtensionRepository`）。

- **怎么拉取。** 设备用自己的 git（`skills/skill-repository-fetch.ts` `withRepositoryFolder`，浅克隆到 Worker 的缓存）拉取，git 用设备自己的凭据：SSH 密钥、凭据助手。私有 GitHub 仓库靠 GitHub CLI 连接器：在 Connectors 页登录 GitHub CLI 后，这次拉取的 git 命令行里带上 gh 的凭据助手（`sources.ts` 的 `gitConfigFor`），用这份登录；Foundry 不改本人的全局 git 配置（DEV-128 起登录不再运行 `gh auth setup-git`）。没有权限时报 git 自己的话（例如 repository not found）。
- **装了什么。** 只复制 `path` 那个文件夹（不含 `.git` 和仓库其他文件），之后和本地文件夹一样校验、记录摘要；注册表额外记 `source`、安装的 `commit`。
- **更新。** Worker 每 6 小时用 `git ls-remote` 看一次 `ref` 现在的提交（`latestCommit`），和安装的不同时，设备行显示“仓库有更新的提交”和“Update”按钮；更新就是从同一来源再装一次。
- **页面上。** 没装的设备在连接器标签下各有“Install <扩展>”；“Add a connector”可以填仓库地址装第一个；设备行菜单里有“从这台设备移除”。都先弹确认，写明拉什么、装到哪、以你的身份运行。接口：`POST /api/devices/{deviceId}/extensions`（`{source}`）、`DELETE /api/devices/{deviceId}/extensions/{id}`，只有设备所有者能调用，经守护连接的 `extension_request` 交给设备。

## 描述符：一份数据描述所有差异

| 维度       | 字段                                             | 说明                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 名称与说明 | `label`/`labels`、`description`/`descriptions`   | 多语言（`en`、`zh-CN`…）；Web 不再为每种连接器写文案                                                                                                                                                                                                                             |
| 工具       | `tool`                                           | 会话用的命令；`source`：`npm`（Foundry 管理安装与升级）、`installer`（适配器或扩展的 `connector.install`）、`device`（设备自带）                                                                                                                                                 |
| 登录方式   | `signIn.methods[]`                               | 每种 `guided`（Foundry 在设备上启动工具自己的登录并转达链接、码、二维码、需粘贴回的码）或 `terminal`（给出终端命令，Foundry 只检查）。`signIn.signOut: false`：只能在终端登出；`signIn.repeat`：再次登录是新增一份登录（另一个 Limen profile），已登录的设备在菜单里给出它的标签 |
| 表单       | `methods[].fields[]`                             | `text`/`secret`/`url`/`select`，`required`、`default`、`pattern`、`placeholder`、`help`、`showWhen`；值作为 `signInOptions` 交给设备，`secret` 用密码框、不落盘不入日志                                                                                                          |
| 附加授权   | `authorizationGroups[]`                          | 同一登录下单独发起、单独显示状态的授权（例如网页会话）                                                                                                                                                                                                                           |
| 前提       | `requires[]`                                     | `tcp_reachable`：设备连不上就不提供，只显示原因                                                                                                                                                                                                                                  |
| 到期       | `expiryReminderDays`                             | 进入窗口后提醒                                                                                                                                                                                                                                                                   |
| 隔离       | `isolationEnv`                                   | 不能用这份登录的会话拿到的变量                                                                                                                                                                                                                                                   |
| 提供什么   | `provides.tool`、`provides.modelAccess.runtimes` | 后者见“模型接入”                                                                                                                                                                                                                                                                 |

只有一种 `guided` 方式且不需要填写时，点“登录”直接开始；否则先选方式、填字段。描述符的长度与形状由 Server 统一校验，扩展上报的不合法描述符直接丢弃。

## 协议（`protocol: 1`）

stdin/stdout 上的 JSON-RPC 2.0，每行一条消息；stdout 只走协议，stderr 不被读取。每个扩展在 Worker 里只有一个进程：第一次需要时启动，空闲 10 分钟后结束；崩溃后下次请求重新启动；stdin 关闭即应退出。类型在 `packages/protocol/src/connector-extensions.ts`。

| 方法（Worker → 扩展）                          | 参数                                                                          | 结果                                                                                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize`                                   | `protocolVersion`、`extensionId`、`extensionDir`、`dataDir`、`worker.version` | `{ protocolVersion }`，不一致则不使用                                                                                                                              |
| `connector.status`                             | `kind`                                                                        | `installed`、`installSource`（`foundry`：`$FOUNDRY_TOOLS_BIN` 里由 Foundry 装的）、`version`、`signedIn`、`identity`、`sites`、`expiresAt`、`authorizations`       |
| `connector.signIn.begin`                       | `kind`、`scratch`、`options`（`method` 与字段值）                             | 登录步骤：`status` `pending`/`complete`/`expired`/`denied`/`failed`，`verificationUrl`、`userCode`、`codeEntry`、`challenge`（二维码写到 `<scratch>/sign-in.png`） |
| `connector.signIn.poll` / `.input` / `.cancel` | `kind`（`input`：粘贴的码）                                                   | 步骤 / `{}`                                                                                                                                                        |
| `connector.signOut`、`connector.install`       | `kind`                                                                        | `{}`；安装期间可发 `connector.progress` 通知                                                                                                                       |
| `connector.authorization.begin` / `.poll`      | `kind`、`group`、`revision`、`continuation`                                   | 步骤；`continuation` 只留在设备上                                                                                                                                  |
| `modelAccess.list`                             | `kind`                                                                        | `{ profiles: [...] }`                                                                                                                                              |
| `shutdown`                                     | —                                                                             | `{}` 后退出                                                                                                                                                        |

扩展可主动发 `connector.changed`（登录在请求之外变了，Worker 重新读取）。超时：读状态 90 秒，登录 120 秒，安装 15 分钟，其余 30 秒。错误消息截断到 300 字符且只是扩展自己的句子，不应包含上游输出。

## 声明式扩展

工具本身有带 JSON 输出的命令行时，扩展可以不写程序：manifest 不写 `entry`，每个连接器写一段 `cli`，说明用哪些参数调用 `tool.command`、从它的 JSON 回答里哪里读什么。Worker 自己按这段数据回答协议里的方法（`extensions/declarative.ts`），上层（设备持有型运行时、模型接入、页面）和程序扩展完全一样。`cli` 只留在设备上，上报给 Server 的描述符里没有它。一个扩展要么是程序（`entry`），要么是声明式（每个连接器都有 `cli`），不能混用。

| 键                 | 作用                                                                                                                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`           | 读登录：`args`，成功条件 `ok`（JSON pointer，值为 true；缺省只看退出码 0），失败时显示的 `error`/`hint`（工具自己的话）；`signedIn`（全部成立才算已登录）、`identity`/`expiresAt`（一个 pointer，或 `items` 数组里每项的 pointer，用“, ”连接）、`problems`（已登录但不可用时显示的句子） |
| `version`          | `args` 和带一个分组的正则                                                                                                                                                                                                                                                                |
| `signIn.<方法 id>` | 一个 `guided` 登录方式要运行的命令：参数里可写该方式的字段 `{字段 id}`，秘密字段写进 `stdin`，不进参数                                                                                                                                                                                   |
| `signOut`          | 登出命令；`forEach` 指向状态回答里的数组时，每项运行一次，`{/name}` 读该项                                                                                                                                                                                                               |
| `modelAccess`      | 模型服务：`items` 数组里每项（`where` 过滤）一个，`id`/`label` 模板、`model`/`models`、会话助手 `session.command`/`args`，以及读已验证身份的 `identity`（用会话助手加这些参数运行，读 `pointer`）                                                                                        |

模板只能写 `{home}`、该处允许的字段名和 `{/JSON pointer}`；以 `~/` 开头的值展开为家目录。不经过 shell，参数原样传给工具。Limen 的扩展就是这样写的：[extensions/limen/foundry-extension.json](../extensions/limen/foundry-extension.json)，只用 `limen status/join/remove --json` 这些公开命令。

## 最小示例

一个只读登录状态、登录交给终端的扩展（假想的 `acmecli`，`acmecli whoami --json` 输出 `user`、`version`、`expiresAt`）。两个文件放进同一个文件夹，`foundry-worker extension add <文件夹>` 即可；它不实现登出，所以声明 `"signOut": false`，页面只提示在终端登出。

`foundry-extension.json`：

```json
{
  "manifestVersion": 1,
  "id": "acme",
  "name": "Acme tools",
  "version": "1.0.0",
  "protocol": 1,
  "entry": {
    "command": "node",
    "args": ["${extensionDir}/connector.mjs"]
  },
  "connectors": [
    {
      "kind": "acmecli",
      "label": "acmecli",
      "description": "Sessions on a device run acmecli with that device's own Acme login.",
      "tool": {
        "command": "acmecli",
        "source": "device"
      },
      "provides": {
        "tool": true
      },
      "signIn": {
        "signOut": false,
        "methods": [
          {
            "id": "terminal",
            "kind": "terminal",
            "label": "In a terminal on the device",
            "commands": ["acmecli login"]
          }
        ]
      }
    }
  ],
  "setup": {
    "command": "npx @acme/foundry-extension install"
  }
}
```

`connector.mjs`：

```js
// Minimal connector extension: reads the login with `acmecli whoami --json`
// and leaves signing in to the terminal method declared in the manifest.
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";

const whoami = () =>
  new Promise((resolve) =>
    execFile(
      "acmecli",
      ["whoami", "--json"],
      { timeout: 20_000 },
      (error, stdout) =>
        resolve(
          error?.code === "ENOENT"
            ? { installed: false }
            : { installed: true, error, stdout },
        ),
    ),
  );

const methods = {
  initialize: () => ({ protocolVersion: 1 }),
  "connector.status": async () => {
    const run = await whoami();
    if (!run.installed) return { installed: false, signedIn: false };
    if (run.error) return { installed: true, signedIn: false };
    const me = JSON.parse(run.stdout);
    return {
      installed: true,
      version: me.version,
      signedIn: true,
      identity: me.user,
      expiresAt: me.expiresAt,
    };
  },
  shutdown: () => {
    setImmediate(() => process.exit(0));
    return {};
  },
};

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
createInterface({ input: process.stdin }).on("line", async (line) => {
  const { id, method, params } = JSON.parse(line);
  const handler = methods[method];
  if (!handler)
    return send({
      id,
      error: { code: -32601, message: `${method} is not supported` },
    });
  try {
    send({ id, result: await handler(params) });
  } catch (error) {
    send({
      id,
      error: { code: -32000, message: String(error.message).slice(0, 300) },
    });
  }
});
process.stdin.on("end", () => process.exit(0));
```

只需实现描述符声明的能力所对应的方法：声明 `guided` 登录才需要 `connector.signIn.*`，`tool.source: "installer"` 才需要 `connector.install`，`provides.modelAccess` 才需要 `modelAccess.list`。收到不支持的方法时回 `-32601`，其错误消息会原样显示在页面上。要加 Foundry 引导的登录（链接、码、二维码、粘贴回的码）、附加授权或模型接入，再实现对应方法；完整的行为可参考测试用扩展 `packages/worker/test/fixtures/fake-extension/`。

## 模型接入

声明 `provides.modelAccess` 的连接器（例如私有 Claude 网关）通过 `modelAccess.list` 列出它的登录给这台设备的模型服务：`id`、`label`、`runtime: "claude"`、`model`/`models`、经验证的非秘密 `identity`，以及会话助手 `session.command`/`args`。每一条成为一个设备 profile（`connectionType: "external"`，`connector` 字段标明来源），列表存在 `~/.foundry/extension-model-providers.json`，Worker 启动时与每 5 分钟、以及每次读该连接器状态后刷新。

已加入但此刻用不了的服务（客户端服务没在运行、会话助手不在、读身份失败或超时）仍要列出，带 `problem`（扩展自己的一句话，`identity` 可为空）：设备保留它，状态为不可用并显示这句话，身份、检查结果与对话沿用上次验证的；此后每分钟重读一次，直到恢复。只有连接器的回答里不再有它（如已退出该 profile），它才从设备上消失。声明式扩展按此处理 `problems`、找不到的 `session.command` 和失败的 `identity` 命令。

新会话的默认值（模型、effort、权限模式等）由本人在「模型服务 › 启动环境」设置，控件与订阅登录相同。它们属于本人而不是连接器：设备按 profile id 另存在 `~/.foundry/external-profile-defaults.json`，每次重列时叠加在连接器给的服务上，所以重列、暂时不可用、退出再登录都不会丢。连接本身（helper、参数、身份、检查指纹）不受影响：验证按连接器给的样子运行和记录（默认模型不算进检查指纹），所以保存默认值后已有的“验证通过”仍然有效；保存的模型必须是服务列出的，且只在服务仍提供它时生效，否则用服务自己的默认模型。验证时服务回答额度已用完（如 “You've hit your weekly limit · resets …”），记为 `reason: "quota_exhausted"`，页面显示“额度已用完”而不是验证失败；重试仍只有“验证”。

会话启动时仍走原有的 `foundry.connection.v1` 会话助手协议（[external-connections.md](external-connections.md#private-process-protocol-v1)）：每个原生进程一个助手，一行请求、一行环境变量、stdin 关闭即释放。同样的助手和身份得到同样的检查指纹，所以从旧的 `foundry-worker connection add` 迁移过来时已有的“验证通过”保持有效；同 id 时扩展提供的条目覆盖手工登记的那条。模型服务出现在设备页“这台设备上配置的”里，标明“来自某连接器”，“验证”仍是一次显式的短对话。

## 兼容

- 内置的 AWS CLI 与扩展走同一个设备持有型运行时（`packages/worker/src/connectors/device-held.ts`），内置适配器在进程内实现同一接口，扩展适配器（`connectors/extensions/adapter.ts`）把调用转成协议请求。
- 旧的外部连接登记（`foundry-worker connection add/list/remove/check/progress`）保留可用，供尚未发布扩展的网关；Devices 页把它们标为“由旧版网关安装程序登记”，仍可移除。
- 原先内置的 bytedcli 改为仓库外的扩展，kind 仍为 `bytedcli`，已有的工作区共享绑定与到期记录不需要迁移。
