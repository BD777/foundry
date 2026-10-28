# DEV-069 公开仓库文档隐私清理

状态：已完成（文档与 redact 测试）。来源：协调会话 2026-10-28 夜间发布窗口的跟进要求。Git 历史不改写。

## 问题

PR #154 发布时对新增文档做了隐私检查，但 main 上更早的文档仍含私有信息：用户名与 home 路径、真实设备名、登录邮箱、内部项目名、公网 IP。

## 处理

只改文字，不改含义。映射如下：

| 原内容                                          | 替换为                                                   |
| ----------------------------------------------- | -------------------------------------------------------- |
| 用户 home 路径（含数据盘下的 home）             | `~/`；数据盘软链写作 `<data-disk>/home/<user>`           |
| Foundry 用户名、配对令牌与 pm2 进程名中的用户名 | `<user>`                                                 |
| 登录邮箱                                        | `<user>@example.com`                                     |
| dev 服务器设备                                  | `dev-server`                                             |
| 用户的 Linux 开发机（三台）与另一台远程 Linux   | `linux-dev`、`linux-dev-2`、`linux-dev-3`、`linux-dev-4` |
| 用户的 Mac 笔记本 / Mac 台式机                  | `mac-laptop` / `mac-desktop`                             |
| 云主机主机名                                    | `VM-x-y-debian`                                          |
| 内部项目名与服务名                              | `<project>` / `<app>` 或删除                             |
| 公网 IP                                         | 文档地址 `203.0.113.x`                                   |

- 文件名含设备名的调研文档改名为 `docs/research/worker-update-recovery-linux-dev.md`（仓库内无引用）。
- 产品文案中的通用示例（如 “your MacBook”、调研中的 Mac mini 方案）和连接器目录中的产品名保留不改。
- `apps/server/internal/redact` 注释及三处测试（`redact`、`workspacedigest`、`sqlitestore` 的 workspace digest 测试）中的公网 IP 改为 `203.0.113.62`；redact 不区分地址段，测试语义不变。`10.0.3.17` 是通用私网地址，保留。

## 验证

- `go test ./internal/redact ./internal/workspacedigest ./internal/sqlitestore ./internal/personalagent/...` 通过。
- `git grep` 复查文档中不再出现原用户名、home 路径、邮箱、设备名和公网 IP；`pnpm format` 通过。
- CI 结果见 PR。

## 限制

- 代码与测试夹具中仍有真实设备名和用户名（设备名作为测试标签、Personal Agent 提示词示例、少量源码注释和一个 Worker 安装路径注释）。改动涉及产品提示词与 golden 文件，留待单独决定，本项未改。
- Git 历史未改写，旧提交中仍可见原内容。
