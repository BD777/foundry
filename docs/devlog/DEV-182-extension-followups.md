# DEV-182 连接器扩展后续：bytedcli 纯数据、接管本地旧版、公开示例、Access 字段、测试卡死与回环地址

## 问题

DEV-174/175 合入后又陆续部署了几项改动，这次一起合入：

1. bytedcli 还是 551 行的程序适配器，私有连接器没有统一用纯数据描述。
2. 设备上从本地文件夹安装的扩展（没有 source），一直不会被随 Worker 发布的同 id 版本接管：sg-chaos 上的 Limen 停在 0.2.0；程序版 bytedcli 和纯数据版 id 冲突。
3. 公开仓库里没有可以照着改的扩展示例。
4. NAS 上的 OpenLark 部署在 Cloudflare Access 后面，Foundry 的请求需要带 Access 服务令牌。
5. Web 测试里断言拿 DOM 节点做比较，失败时 Node 的断言格式化会展开 happy-dom 的整张对象图，表现为测试卡死、看不到失败原因。
6. 「经设备连接」的地址如果是 127.0.0.1 或 localhost，可用设备检查会到其他设备上连它们自己的本机，结果不可信。

## 修复

1. 声明式引擎补齐：envelope、两步登录（begin/poll/state）、带 continuation 的授权组、`minVersion`、错误码文案；`extensions/bytedcli/` 改为纯数据，`requires: tcp_reachable` 作为公司网络门槛（设计见 docs/research/declarative-v2.md）。
2. `syncBundledExtensions`：已安装扩展与 bundled 同 id、没有 source、版本不高于 bundled 时原地接管，保留 data/ 和模型服务；本机版本更高时不降级，页面上提示。
3. `extensions/examples/`：三个虚构服务的示例（程序版设备持有、声明式设备持有、声明式服务器保管）。Go 测试会用 Server 规则校验 `extensions/*` 和 `extensions/examples/*`。
4. OpenLark 描述符新增两个可选的秘密字段：Cloudflare Access Client ID 和 Secret，作为 `Cf-Access-Client-*` 请求头发给上游，字段为空时不发。
5. 测试环境给 DOM 节点注册简短的 `util.inspect` 摘要；Web 测试统一加 `--test-timeout=120000`。没有改动 node:assert。
6. 回环或 localhost 地址只认做校验的那台设备。

## 部署与验证

- 部署：Server/Web 80140d7a974f1926（加回环修复后重启 Server）；Worker …1794413999，除离线的 Mac mini 外全部设备已更新。
- 设备核对：macbook 与 byte-dev-sg 上 bytedcli 为 2.0.0 纯数据版，无报错；sg-chaos、cottoncpp、macbook 上 Limen 为 0.2.1，sg-chaos 上的 `Limen · default` 模型服务完好。
- 检查：批量检查全部通过（prettier、protocol、web tsc 与测试、worker 构建与测试 26 个文件、UI/契约/OpenAPI/模块审计）；Worker 扩展测试 36 项；新增的回环测试通过。

## 限制

- 声明式 bytedcli 的真实扫码登录和 Meego 授权，需要人在 byte-dev 上用一次确认。
- Mac mini 当时离线，还在旧版 Worker。

## 验收

1. 连接器页：bytedcli 在 macbook 和 byte-dev-sg 上显示为已安装 2.0.0，登录状态与之前一致。
2. 设备页的扩展行：本机安装了更高版本的扩展时，会出现「本机安装的版本较新」的提示。
3. OpenLark 添加实例时，表单里有两个可选的 Cloudflare Access 字段。
