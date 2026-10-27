# Dev 验证环境登记

需要独立测试账号时，先查看本表并复用已有账号；没有时才创建。这里只保存非敏感身份和复用信息，密码、令牌及浏览器认证状态保存在仓库外，不写入文档、截图或测试日志。

| 环境                            | 测试账号标识     | 用途/合成数据范围                                                                                                                                | 凭据管理方式（不含秘密）                                             | 维护 session                                                            | 最近验证   |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------- |
| dev                             | 尚未登记独立账号 | 后续创建前先核对已有账号；本表不代表账号已创建                                                                                                   | 仓库外保存                                                           | —                                                                       | —          |
| 本机合成栈 isolation-dev006-007 | scratch-admin    | DEV-006/007 草稿与独立 Issue 验收；新 Workspace `ws_9a7f5fdc-72da-4599-a24a-782e59e1171e` 与无改动场景 `ws_d3f03f56-3125-4a8f-82f1-4e2c8618de09` | 实例 instance.env 与浏览器状态均在仓库外                             | [Astra 接续](https://dev.foundryapp.app/chats/sess_1792389911761860653) | 2026-10-19 |
| 日常 dev                        | e2e-alice        | 既有独立账号，本轮仅登录并核验部署页面；不修改旧 Workspace/Issue                                                                                 | `/home/windeng/.foundry/server/e2e-alice.password`，认证状态在仓库外 | [Astra 接续](https://dev.foundryapp.app/chats/sess_1792389911761860653) | 2026-10-19 |

用户已授权在其 dev 账号下验证。采用用户账号时使用明确标记的合成 Workspace/Issue，避免更改无关业务数据。采用独立账号时记录稳定账号标识，后续复用。清理只处理本次明确创建且不再需要的测试数据，验收证据需留存。

2026-10-20：DEV-025 复用 e2e-alice 完成日常 dev 登录与 build smoke，无新增业务对象；本轮隔离 HTTP/UI fixture 使用独立临时 DB，不连接 Worker。浏览器认证状态保留仓库外，本轮临时 vault 项已删除。

2026-10-27 DEV-048：复用 `e2e-alice` 验证 dev 会话归档。新增合成设备 `dev_1d7e8a04-44f5-4865-a650-c10939fd5c65`（DEV048 synthetic archive）与工作区 `ws_d4da0f57-8b07-40e2-b85d-54f813982f19`；所有新会话/定时工作限定在此工作区。独立 Worker 状态和原生 Codex/Claude 数据目录在仓库外 `~/.foundry/dev048-acceptance/`，认证 Cookie、配对凭据及检查状态均不入库。该合成 Worker 可单独停止做离线重连验证，不停止正在处理用户会话的 Worker。

2026-10-27 DEV-050：复用 e2e-alice 登录日常 dev；浏览器内仅对 `dev050-long` 的只读 API 请求注入 640 事件合成 transport，工作区沿用 DEV-048 的独立 `ws_d4da0f57-8b07-40e2-b85d-54f813982f19`。不创建持久会话、不发送消息、不运行模型；真实用户示例仅以数据库只读连接及 Foundry events 读取核对。认证 vault 临时项在验收后删除，未保存用户登录态或凭据到仓库。

2026-10-27 DEV-049：复用 `e2e-alice` 登录 dev 做部署后只读界面/菜单验证；浏览器使用本任务独立临时 profile。归档、Undo、错误、菜单与提示矩阵用本地合成 fixture（不写用户真实会话/配置），未新建业务对象。临时认证 vault 将在收尾删除，认证不写入仓库。

2026-10-27 DEV-051：复用 e2e-alice 登录真实 dev，仅对既有 DEV-048/023 合成工作区图片、文件预览/下载及未知路径发 GET，验证离线/缺失状态与缓存头；核对最终 Web build `72eeef927ba62eb0`，无新增业务对象、消息或模型请求。图片/文件加载、失败、键盘重试、下载取消与主题/宽度矩阵在独立浏览器 fixture 中验证；两种文件下载均逐字节比较合成原始 JSON。临时认证 vault 项已删除，浏览器已关闭；认证信息留在仓库外，不写入截图或测试日志。

2026-10-27 DEV-053：复用 e2e-alice，新建独立合成设备 `dev_2682e76d-069e-459b-88cc-697bf2c848fe`（DEV053 proxy synthetic）与工作区 `ws_f6059fa3-9711-4c02-95d8-8d4f09780e1b`。私有 Worker 状态、认证 Cookie 与原生 Codex 测试目录均在仓库外 `~/.foundry/dev053-proxy-acceptance/`；本地 auth.json 只链接已有 Codex 登录，不复制登录凭据进仓库。临时代理只监听 127.0.0.1，仅设置此合成设备；真实设备代理保持原样。测试使用真实 Codex CLI 会话与 256 KiB 合成文件，未创建 Git commit。

2026-10-27 DEV-051 第二轮：e2e-alice 的独立临时浏览器 profile 复验 Web `1792b54a13066032`，只读 GET 未知附件两种 variant 均 404/no-store。另用 localhost 合成 HTTP fixture 验证小图先显示、预览、缓存、1,000,000 B 原图流进度/完整下载、light/dark × 1280/390 及键盘；未创建真实会话或运行模型。安装校验通过 compute self-update entry，byte-dev 第一次因私有 registry 缺少 socks^2.8.10 在重启前失败；原 daemon/忙碌宿主保留，下载 manifest 已恢复前版。后续最终版本/清理回执记在 DEV-051 交付记录。

DEV-051 最终补验：经 DEV-053 协调，仅在其 e2e-alice 合成工作区 `ws_f6059fa3-9711-4c02-95d8-8d4f09780e1b` 上传一个 `DEV051-production-preview-synthetic.png`（1,057,794 B），通过真实公网 API 验证预览/缓存/原图流及 workspace-files/download 字节哈希，不创建会话、不运行模型。临时 DEV051 auth vault 项删除、浏览器关闭、fixture32051 关闭、远端 helper 目录清理且 compute lease 释放；DEV-053 独立测试服务由其所有者确认停止。最终 Worker `.1793104558` 的旧 ffmpeg 三文件 helper 在 byte-dev 实测并与打包 SHA 相同；真实用户公网请求仍交本人/协调者验收。
