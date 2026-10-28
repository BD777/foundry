# DEV-070 公开仓库代码隐私清理

状态：已完成（代码注释、测试夹具与 Personal Agent 提示词）。来源：协调会话 2026-10-28 夜间发布窗口，接续 [DEV-069](DEV-069-privacy-scrub.md) 留下的代码部分。Git 历史不改写，产品行为不变，无需部署。

## 处理

只改名字，不改含义。映射与 DEV-069 一致：

| 原内容                              | 替换为                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------ |
| 真实设备名                          | `dev-server`、`linux-dev`、`linux-dev-2..4`、`mac-laptop`、`mac-desktop` |
| 用户名 / 数据盘 home 路径           | `alice`、`$HOME`；`/home -> /data/home`                                  |
| 内部项目与 Skill 名（含缩写目录名） | `Atlas`、`crm-sync-v2`、`team-domain-mapping`、`atlas`、`team`           |
| 同事姓名（提示词示例与评测语料）    | `小林`                                                                   |
| 第三方网关域名                      | `gateway.example.com`                                                    |
| redact 测试中的业务名               | `renderkit`                                                              |

- 源码注释：`daemon_conn.go`、`skills.go`、`transport.ts`、`control-connection.ts`、`repository-source.tsx`、`worker-install.ts`。
- Personal Agent 提示词 `system.md`：项目示例、文件夹式项目名、主机名示例和对话示例中的人名换成中性名字，指令含义不变。按仓库规则，提示词文本变化必须换版本：`prompt.Version` 从 `2026-10-21.1` 升为 `2026-10-28.1`，`promptVersions` 记录新 hash；golden 用 `go test ./internal/personalagent/prompt -update` 重新生成，diff 只有上述名字。
- 测试夹具约 50 个文件（Go、Web、Worker、protocol、`scripts/pa-eval-run.mjs` 评测语料）同名替换。`native-*-work-compat` 测试的 Claude 默认路径由写死的个人 home 改为 `${HOME}/.local/bin/claude`，在原设备上解析结果相同。
- 保留：`MacBook Pro M4`、`Alice's MacBook Pro`、`Mac mini` 等通用产品名，以及连接器目录中的产品名。没有依赖原始字节的录制载荷或 hash 夹具需要跳过。

## 验证

- `go test ./internal/personalagent/...`（含 golden 与版本 hash）通过；全量 Go、JS 测试与 CI 结果见 PR。
- `git grep` 复查仓库中不再出现原设备名、用户名、内部项目名、同事姓名和网关域名（Git 历史除外）。

## 限制

- Git 历史未改写，旧提交仍可见原内容。
- 线上 Personal Agent 下次部署 Server 后使用新提示词版本 `2026-10-28.1`；只换示例名字，行为预期不变，本项不单独部署。
