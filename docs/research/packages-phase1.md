# 集成包阶段 1：服务端、Worker 与契约

状态（2026-11-11）：设计已与产品模型对齐；本切片只实现服务端、Worker 和契约，Web 交互另开切片。E1 继续负责 Worker 内置扩展、`visibleWhen` 与打包；E2 继续负责声明式引擎。

## 结论

一个包不是新的安装体系，而是现有 Connector + Skill bundle + managed tool 三个机制的关联：

- Connector 描述符上的 `package` 是包的静态定义：上游 GitHub 仓库、Skill 目录、工具声明。
- Skill 库里的 bundle 是包版本的唯一事实来源：commit、成员 Skill、工具版本、检查、rollout 和回滚都在这里。
- 设备上的 managed tool 与扩展描述是包的设备安装事实；人的启用记录只保存“包 kind + 已选择设备”。
- 会话只从“实际拿到的连接器”反推包。连接器没有出现时，不附带包的 Skill 或 CLI。

## 数据形状

`foundry-extension.json` 支持 manifest v1 兼容读取，并新增 v2 package 描述。v2 的连接器可声明：

```json
"package": {
  "upstream": {
    "via": "github",
    "repository": "https://github.com/nwverse/open-lark",
    "ref": "main"
  },
  "skills": {"path": "plugins/open-lark/skills"},
  "tools": [
    {
      "command": "olk",
      "source": "repository",
      "path": "plugins/open-lark",
      "bins": {"olk": "bin/olk", "olk-ctx": "bin/olk-ctx"}
    }
  ]
}
```

- `upstream.via` 必须对应一个声明了仓库读取能力的连接器；本阶段只有 `github`。
- `repository` 是规范化后的 GitHub HTTPS 地址；`ref` 是安全的分支或 tag。
- `skills.path`、工具 `path` 和每个 bin 都是仓库内相对路径，不得绝对、越界、带 `..` 或反斜杠。
- 工具 `command` 必须出现在 `bins` 中。`bins` 的键是会话 PATH 上的命令，值是工具 `path` 下的相对文件。
- `source: "repository"` 的 bundle 工具版本等于 bundle 版本的 commit；不另取 release tag，也不在设备上查询“最新版本”。

包启用记录只保存关联事实：

```text
owner_user_id, package_kind, extension_id, repository_id, devices_json, updated_at
```

其中 `package_kind` 就是连接器 kind。记录存在表示人在自己这一级启用了包；`devices_json` 是成功启用过的设备集合。连接的包描述与 bundle 内容不复制进该记录。

## 模块边界

- `contracts/models/connectors.yaml` 定义连接器 `package` 与包 API 类型；`contracts/models/skills.yaml` 扩展 bundle 工具来源。
- `apps/server/internal/connectors/descriptor_checks.go` 校验 manifest 中包声明和连接器 capability。
- `apps/server/internal/skilltools` 把包工具声明解析为带 commit、仓库、目录和 bins 的 `SkillBundleTool`。
- `apps/server/internal/httpapi/connector_packages.go` 负责人级启用记录、设备可用性、自动建立/复用 bundle、设备安装/卸载和包视图 API。
- API：`GET /api/connector-packages`、`GET /api/connector-packages/{kind}`、`PUT /api/connector-packages/{kind}/devices`、`DELETE /api/connector-packages/{kind}`。PUT 先预检所有设备，成功后才写启用记录；DELETE 先卸载设备工具再删记录。
- `apps/server/internal/httpapi/bundle_versions.go` 负责从已安装工具选出 bundle 版本；会话侧新增“由连接器引入的包 Skill/pins”解析。
- `packages/worker/src/skills/repository-tools.ts` 只负责 repository tool 的下载、目录安全、bins 链接和原子切换；`managed-tools.ts` 保持通用版本目录与 managed bin 语义。
- `packages/worker/src/skills/skill-repository-fetch.ts` 统一给 GitHub HTTPS 仓库拉取加 GitHub CLI credential helper；不写全局 git 配置。
- E1 的内置扩展安装通过一个窄回调接入包 API：服务器只发 bundled extension id，不复制打包或 `visibleWhen` 逻辑。

## 启用与设备选择的状态机

每台设备按以下顺序给出不可选原因：

1. 设备离线：不可选，原因“设备离线”。
2. 平台或 Worker 信息不支持：不可选，原因说明平台不受支持或 Node 缺失。
3. `upstream.via` 连接器未安装、未登录或检查失败：不可选，原因指向对应连接器。这里复用 E1 的 `repositoryAccess` 能力声明，本期只接受 GitHub CLI。
4. 读取上游失败或没有仓库权限：启用请求失败，保留原选择；错误说明需要哪个连接器能读取 `owner/repo`。
5. 以上通过：可选。选择后安装包的 repository tools，再安装/确认 E1 bundled extension；任一步失败则撤销本次工具安装并保留原启用集合。

选择集变更视为一次 desired-state 操作：

- 新集合中的设备先全部预检，有不可选设备则拒绝，不产生半配置。
- 已选设备保持；移除的设备卸载“由该包装的工具”，不卸载共享连接器或用户自己的同名程序。
- 集合变更成功后才更新 `devices_json`。空集合由显式删除启用记录表达。

新设备加入 owner 名下时不自动安装；GET 视图会列出 `eligible=true, selected=false`，供后续 Web 切片提示。

## Bundle 建立与复用

- 包第一次有设备成功启用时，按 `upstream.repository/ref + skills.path` 查找已有 bundle。完全匹配则复用。
- 复用 bundle 的工具声明必须与包声明一致；不一致时拒绝并在 `DeclaredTools/错误` 中明确冲突，不覆盖别人手工配置的 bundle。
- 不存在时创建 bundle 模式跟随，`DeclaredTools` 由包工具声明生成，reader 使用本次选择的设备之一。该设备同时提供 GitHub CLI 登录。
- 现有每日检查、自动/手动 rollout、检查回滚和 toolPins 不变。包版本前进后工具版本是目标 bundle commit，Skill 成员来自同一条 `SkillBundleVersion`。
- 包删除启用记录不删除 bundle；已有其它 Workspace/包继续使用它。工具只在设备选择移除时卸载。

## 会话组合规则

1. 先解析会话实际连接器：server-held account/instance material 的 provider，以及 `DeviceConnectorUse.access == "device_login"` 的 kind。
2. 用 `(owner, kind, session.deviceId)` 查选中的包。未选中的设备、没有该连接器的会话不产生包 Skill 或 pins。
3. 由设备已安装的工具找同版本 bundle，读取该 `SkillBundleVersion.members`；同时生成该版本工具的 `toolPins`。
4. 与 Workspace 已有 Skill 合并：Workspace 显式关闭的 Skill 不加入；同名由 Workspace 已有项优先；工作区 Skill 固定版本优先。
5. 包 bundle 的 Skill 带 bundle/version 标记，现有 `deviceSkillRefs` 会保持同版本并补齐旧版成员。pins 按工具名合并；同一工具同一版本只保留一项。

包不进入 Workspace bundle 选择列表；它由连接器出现而自动进入会话。因此“没有连接器就不附带”和“工作区明确关闭优先”都不依赖页面选择。

## 迁移

- SQLite 新增 `connector_package_enablements` 表，JSON 保存设备集合；启动迁移幂等创建，不复制旧数据。
- 现有 v1 manifest、公开 bundle、npm/uv 工具、扩展来源和 rollout 数据保持兼容。
- 旧设备不识别 `repository` tool 时，Server 的 Worker capability 检查会让启用失败并显示“更新 Worker”，不退回设备 git 或设备凭据。
- E1 的 bundled extension 安装已合入：启用设备时通过 `extension_request` 的 `bundledExtensionId` 安装官方扩展；已安装设备跳过。工具先装入当前 bundle commit，扩展失败时回滚本次工具安装。

## 验证边界

- 合成上游仓库和假 GitHub CLI；不访问真实 `nwverse/open-lark`。
- 覆盖 manifest/路径校验、自动建/复用 bundle、repository tool 安装与 bins、设备选择原因、会话同版本 Skill+pins、无连接器不加、现有更新/回滚路径。
