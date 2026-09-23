# Foundry Docker 部署指南

用 Docker / Docker Compose 把 Foundry 全栈（控制面服务端 + 网页 + worker
守护进程）部署到一台 Linux 主机，例如家用服务器、云主机或支持 Docker 的
NAS；其他机器（macOS / Linux）可以作为额外 worker 接入。

- 镜像架构：`linux/amd64` 或 `linux/arm64`（按构建平台）
- 服务端口：`31982`（API 与网页同源，一个端口）
- 下文 `<server-host>` 指浏览器和其他 worker 访问部署主机时使用的地址
  （IP 或域名）

## 架构

```
浏览器 ──HTTP──> <server-host>:31982
                ├─ foundry-server 容器  (Go API + 网页静态文件 + SQLite)
                └─ foundry-worker 容器  (Node + git + claude CLI)
                       └─ 处理宿主机工作区目录中的 git 仓库
其他机器（可选）
  └─ foundry-worker (launchd / systemd) ──WS──> <server-host>:31982，处理本机仓库
```

两个容器把**同一个宿主机目录**挂到**同一个容器内路径** `/workspace`，
所以 worker 注册的工作区路径与服务端视角一致。服务端会直接读写工作区下的
`.foundry/attachments`，附件上传、图片预览等文件功能依赖这一点。

相关文件：

| 文件                   | 作用                                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| `Dockerfile`           | 多阶段构建，产出 `foundry-server` 与 `foundry-worker` 两个 target    |
| `docker-compose.yml`   | 两个服务、两个命名卷，工作区目录由 `FOUNDRY_WORKSPACE_DIR` 指定      |
| `.env.example`         | 部署环境变量模板，复制为 `deploy/.env` 使用                          |
| `worker-entrypoint.sh` | worker 容器入口：`init` → `pair` → 前台 `daemon`，重启由 Docker 负责 |
| `build-images.sh`      | 在另一台机器上构建镜像并导出为 tar.gz（离线导入场景）                |

---

## 一、准备环境变量

```bash
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

编辑 `deploy/.env`：

- `FOUNDRY_WEB_ORIGIN`：浏览器实际访问的地址，如 `http://<server-host>:31982`。
  **用哪个地址打开网页就必须填哪个**（协议、主机、端口完全一致），否则会被
  CORS 拦截；不要混用 IP 和主机名。
- `FOUNDRY_WORKSPACE_DIR`：宿主机上的工作区根目录，两个容器共同挂载到 `/workspace`。
- `ANTHROPIC_API_KEY`：容器内 worker 调用 Claude 使用的 key。
- `FOUNDRY_PAIRING_TOKEN`：先留空，见第四节。

---

## 二、构建镜像

构建上下文必须是仓库根目录。

### 在部署主机上直接构建

```bash
docker build -f deploy/Dockerfile --target foundry-server -t foundry-server:local .
docker build -f deploy/Dockerfile --target foundry-worker -t foundry-worker:local .
```

默认从官方源（proxy.golang.org、registry.npmjs.org）下载依赖。需要镜像源时
通过构建参数覆盖，例如：

```bash
docker build -f deploy/Dockerfile --target foundry-server -t foundry-server:local \
  --build-arg GOPROXY=https://goproxy.cn,direct \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com .
```

Compose 默认使用 `local` 标签；用其他标签时在 `deploy/.env` 中设置
`FOUNDRY_IMAGE_TAG`。

### 在另一台机器上构建后导入（适合不便构建的主机）

需要 `docker buildx`。在仓库根目录运行：

```bash
./deploy/build-images.sh
```

脚本会：

1. 用 buildx 构建两个镜像，平台默认 `linux/amd64`，可用 `PLATFORM=linux/arm64`
   覆盖；标签默认 `local`，可用 `TAG=...` 覆盖；设置了 `GOPROXY` /
   `NPM_REGISTRY` 时作为构建参数传入；
2. 导出为 `artifacts/images/foundry-images-<标签>-<时间戳>.tar.gz`。

把该文件拷到部署主机后导入：

```bash
docker load -i foundry-images-<时间戳>.tar.gz
docker images | grep foundry
```

在 Apple Silicon 上交叉构建时，Node 22 在纯 QEMU 模拟下可能触发 libuv
崩溃；跨架构构建时脚本会传入 `NPM_NETWORK_CONCURRENCY=1` 串行化 npm 请求来缓解。推荐让 Docker 运行时用
Rosetta 执行 amd64，例如 Colima：在 `~/.colima/default/colima.yaml` 中设置
`rosetta: true` 后重启，并用
`docker run --rm --platform linux/amd64 alpine uname -m` 确认输出 `x86_64`。

---

## 三、启动容器

### 方式 1：Docker Compose（推荐）

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
```

`docker-compose.yml` 字段保持精简，便于导入各类容器管理界面（例如 NAS
的「容器编排 / Compose」）。在这类界面中使用时，把文件内容粘进去，并提供与
`deploy/.env` 等价的环境变量（或直接把 `${...}` 替换成实际值）。

### 方式 2：手动创建两个容器

适用于只提供图形界面、不支持 Compose 的环境。

**容器 1：foundry-server**

| 项目     | 值                                                                      |
| -------- | ----------------------------------------------------------------------- |
| 镜像     | `foundry-server:local`                                                  |
| 端口     | 宿主机 `31982` → 容器 `31982`                                           |
| 环境变量 | `FOUNDRY_HOST=0.0.0.0`、`FOUNDRY_WEB_ORIGIN=http://<server-host>:31982` |
| 存储 1   | docker 卷 → `/data`（SQLite 数据库，**务必备份**）                      |
| 存储 2   | 工作区根目录 → `/workspace`                                             |
| 重启策略 | 总是重启                                                                |

**容器 2：foundry-worker**

| 项目     | 值                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 镜像     | `foundry-worker:local`                                                                                                                                          |
| 环境变量 | `FOUNDRY_SERVER_URL=http://foundry-server:31982`、`FOUNDRY_WORKSPACE=/workspace/default`、`FOUNDRY_PAIRING_TOKEN=<一次性配对 token>`、`ANTHROPIC_API_KEY=<key>` |
| 存储 1   | docker 卷 → `/home/foundry`（设备凭证与本地状态）                                                                                                               |
| 存储 2   | **与 server 相同的工作区根目录** → `/workspace`                                                                                                                 |
| 网络     | 与 server 在同一用户自定义网络中以容器名互通；做不到时把 `FOUNDRY_SERVER_URL` 改成宿主机可达地址，如 `http://<server-host>:31982`                               |
| 重启策略 | 总是重启                                                                                                                                                        |

---

## 四、创建账号并配对 worker

1. 查看服务端日志（`docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs foundry-server`）。
   尚无账号时会打印一次性启动码；打开 `http://<server-host>:31982`，用它创建
   第一个 Admin。之后在 Members 页邀请成员（账号模型见
   [安全说明](../docs/security.md#accounts)）。
2. 在网页 Devices → Add device 生成一次性配对 token，或在 server 容器内运行：
   ```bash
   docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
     exec foundry-server \
       /app/foundry-server devices pairing-token --username <用户名>
   ```
3. 把 token 填入 `deploy/.env` 的 `FOUNDRY_PAIRING_TOKEN`，重建 worker：
   ```bash
   docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d foundry-worker
   ```
   worker 只在尚未配对时兑换该 token，得到的设备凭证保存在
   `/home/foundry` 卷里；配对成功后可以把这个变量清空。

---

## 五、验证

1. `curl http://<server-host>:31982/healthz` 返回正常（镜像也内置了同一路径的
   `HEALTHCHECK`）；
2. 网页登录后，Devices 中出现容器 worker 且在线，并能看到它注册的
   `/workspace/default` 工作区；
3. 在该工作区配置 Claude Profile，发起一个 Chat，确认容器内 claude CLI 与
   API key 可用。

排查时先看 `foundry-worker` 容器日志。

**已知边界**：worker 镜像未安装 bubblewrap，而 Linux 上的 Issue 执行要求
bubblewrap 与可用的 user namespace，缺失时按设计拒绝执行。因此容器内 worker
目前适合 Chat；需要 Issue 执行时，使用满足条件的主机 worker（见
[开发指南](../docs/development.md)）。

---

## 六、其他机器作为额外 worker 接入

在 macOS 或 Linux 机器上处理本机仓库（使用本机已登录的 CLI 凭证）：

```bash
pnpm install --frozen-lockfile
pnpm --filter @foundry/protocol build
pnpm --filter @foundry/worker build

node packages/worker/dist/cli.js setup \
  --server http://<server-host>:31982 \
  --workspace <本机仓库绝对路径> \
  --token <Devices → Add device 生成的一次性 token>
```

`setup` 默认安装用户服务（macOS launchd / Linux systemd user）常驻运行；
`--no-service` 只做前台配置。管理命令：
`foundry-worker status|logs|uninstall-service`。

**已知边界**：这类 worker 注册的路径在它自己的机器上，服务端读不到这些
文件，因此这些工作区的附件上传、图片预览不可用；需要文件功能时，把仓库放在
服务端也能以相同路径访问的目录中，交给容器内 worker 处理。

---

## 七、安全与运维

- 只在**可信网络**中暴露该服务，不要直接做公网端口转发；需要外网访问时使用
  VPN（如 Tailscale / WireGuard）或带 TLS 的反向代理。更多见
  [安全说明](../docs/security.md)。
- SQLite 数据全部在 foundry-server 的 `/data` 卷中，定期备份该卷即可。
- 升级：拉取新代码后重新构建（或重新 `build-images.sh` + `docker load`），再
  `docker compose ... up -d` 重建容器；数据库与工作区在卷/宿主机目录中，不受影响。
- 忘记密码：在 server 容器内运行
  `/app/foundry-server users reset-password --username <用户名>`（数据库路径取自
  容器的 `FOUNDRY_DB_PATH`）。
- 重新配对某个 worker：在 Devices 页移除该设备，生成新 token 后重新
  `setup` / `pair`。
