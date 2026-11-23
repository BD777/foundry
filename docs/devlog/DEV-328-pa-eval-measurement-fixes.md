# DEV-328 PA 路由评测：把测量和产品分开（项目可打开、按生产方式构建夹具、隔离评测机、合成内容、默认判定）

[事项索引](README.md) · 承接 [DEV-321](DEV-321-pa-eval-online-fixtures.md) · 诊断 `.foundry/reports/routing-diagnosis-20261123.md` §4.4 · 基线报告 `.foundry/reports/eval-baseline-20261124.md`（`.foundry/` 不入库）

状态：**脚本已完成，本地提交在 `feat/pa-eval-fixes`；不涉及部署**（脚本不随部署发布）。新基线结果见基线报告。

## 问题

诊断发现，S6 的 47 个「产品失败」里约 32 个是测量造成的：

- **M1**：夹具项目文件夹在夹具 Worker 的沙箱外，18 个已有项目全部打不开。
- **M2**：请求里有脱敏占位，而且截在 400 字。
- **M5**：帮手在助理回合中途被取消，状态跨用例残留。
- **M6**：回复里有问号就记为提问。
- **M8**：助理看得到真实评测机，读到真实服务账号并写进了 rows 文件。
- **夹具 digest**：不按生产方式构建，只有一周的 5 个标题。

## 改动

- **项目打得开**：
  - 项目文件夹放在运行目录 `<stack>/pa-eval/computers/…` 下，带顶层文件、说明文件（生产 digest 的 intro）和 `.foundry/workspace.json`。
  - 每台夹具电脑的 Worker 登记它的项目（`workspaces.json`，与 `foundry-worker init` 相同）。
  - 开跑前预检：任一项目不在线、`unavailableOnDevice` 或未列出，setup 就失败（`preflightProjects`）。
  - 见 `scripts/pa-eval-fixture.mjs`、`scripts/pa-eval-seed.mjs`、`scripts/pa-eval-run.mjs`。
- **夹具按生产方式构建，只用用例日期之前的数据**：
  - 评测集为每个项目带上本人在那里的全部对话（时间、标题、首条消息，合成化后，评测用例自身除外）和 intro（`pa-eval-build.mjs`）。
  - 运行时按用例所在周的周一截断，写入最近 80 条（`applyHistory`）。
  - 用例按截止周分组（小周并入更早一组，只会更严），组间停服、改写历史、同端口重启。
  - 历史变了的项目删除 digest，由服务端在电脑重连时重建并立即概括，与生产首次概括相同。
  - 每个截止点助理读到的项目文件存到报告旁 `<report>.fixture/<cutoff>/`。
- **夹具电脑的模型配置与生产一致**：
  - 评测集记录每台电脑在 dev 库里健康的 `agent_profiles`（`index.computers`）。
  - 夹具电脑提供同 id、同 identity 的连接器配置（helper 是存根，CLI 仍是假 CLI），并做连接检查。
  - 生产里没有 `limen_default` 的电脑（work-dev-sg、vm-debian），夹具里同样没有。
- **帮手与状态**：
  - 假 CLI 在 `FAKE_CLAUDE_HOLD=1` 下不回答，帮手在助理这一轮里保持运行，回合结束后才取消。连接检查的提示仍会回答。
  - 取消后归档帮手会话，不留在项目、digest 和助理视图里。
  - 每例结束后撤销：新建项目（删除失败即该例 `error`）、会话的定时任务（先 `stop_all` 再删）、清单、记忆、规则，以及助理自己的文件（`.foundry/` 由服务端每轮重写，保留）。
  - 有回合仍在运行或排队的话先取消，再开始下一例。
- **隔离评测机（M8）**：
  - 每台评测电脑（助理和夹具）在自己的最小根文件系统里运行（`scripts/pa-eval-sandbox.mjs`）：只读的 `/usr` 和少量 `/etc` 文件；`/opt` 下的 Node、Worker、Claude CLI；合成的 passwd、hosts 和主机名。只有运行目录可写，没有 `/home`、`/var`、`/run`。
  - 每台电脑有独立网络（`--unshare-net`）。只桥接评测服务端口和连接 helper 回复里点名的本机代理端口（`pa-eval-connection-relay.mjs` 读回复、建桥、原样转交，不记录内容）。
  - Worker 的配对也在沙箱里做，设备名是合成的（助理一侧为 `home-server`）。
  - `--sandbox-check` 共 8 项：运行目录可写；`/etc` 和 `/var/tmp` 不可写；宿主家目录不可见；`/home` 为空；主机名是合成的；宿主端口不可达；桥接端口可达；进程视图独立。
- **合成内容（M2）**：`pa-eval-build.mjs` 不再输出占位，改成同类的合成内容：
  - 飞书链接保留类型，放在 `example.feishu.cn` 下；
  - 内部链接保留通用路径词；
  - 公开站点链接只在含私人模式时改写路径；
  - IP 用 `192.0.2.x`；人名和群名用合成名；
  - 密钥和 id 换成同形的合成值；
  - 粘贴内容保留正文；
  - 上限 4096 字，截断时不切开单词。

  `--pin` 时，原始消息与冻结请求一致的就从原始消息重新生成，不一致的把占位换成通用合成内容。5 个图片用例附一张合成图（集内 `images/`，由 `images/make.py` 生成），通过 `POST /api/attachments` 上传，作为收件箱附件发送。泄漏检查会跳过合成内容本身。

- **判定（M6）**：`--judge` 默认开启（`--no-judge` 关闭）。repeat 时判定按「用例#遍次」对应，此前按 id，会串遍。
- **清理现有报告**：
  - 12 个报告 / rows 文件里的真实账号标识（2 个）、公网 IP 和评测机主机名已替换。
  - `pa1f-base4-rep1.db` 中 115 个单元格同样替换，然后 `VACUUM`。

## 检查

| 检查                                                                                                                                                     | 结果                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `node --test scripts/pa-eval-fixture.test.mjs scripts/pa-eval-connection-relay.test.mjs scripts/pa-eval-score.test.mjs scripts/pa-eval-journal.test.mjs` | 12/12 通过                                                                                                         |
| `node scripts/pa-eval-run.mjs --sandbox-check`（本机）                                                                                                   | 8/8 PASS                                                                                                           |
| `node --check` 全部 `scripts/pa-eval-*.mjs`；`bash -n scripts/pa-eval-stack.sh`；prettier                                                                | 通过                                                                                                               |
| `pa-eval-build.mjs --pin set --out set-v2`                                                                                                               | 117 例，金标与 set 相同；泄漏检查 0；67 例从原始消息重生成，4 例替换占位，9 例无占位                               |
| 冒烟 1（10 例 ×1，main `190f88e0` 的 Server，limen_default/opus/high，$2.54）                                                                            | 预检「18 个项目全部可打开」；3 次历史推进；暴露夹具缺 `limen_default`，派发被拒 → 补连接器配置                     |
| 冒烟 2（同 10 例，$2.68）                                                                                                                                | 0 失败；派发真实到达项目（6 个帮手在回合后取消）；没有回复说「打不开 / 没传过来」；`hw-named-cpa` 没有接触真实服务 |
| 归档帮手（对冒烟栈调用 API）                                                                                                                             | `/api/chats/archive` 后，项目会话列表不再含该帮手                                                                  |

## 验收步骤

1. `node --test scripts/pa-eval-fixture.test.mjs scripts/pa-eval-connection-relay.test.mjs scripts/pa-eval-score.test.mjs scripts/pa-eval-journal.test.mjs`，预期全部通过。
2. `node scripts/pa-eval-run.mjs --sandbox-check`，预期 8 项 PASS。
3. `PA_EVAL_SET=~/.foundry/pa-eval/set-v2 scripts/pa-eval-stack.sh /tmp/x <server> limen_default haiku high environment`。然后运行 `node scripts/pa-eval-run.mjs --e2e --stack-dir /tmp/x --eval ~/.foundry/pa-eval/set-v2 --profile limen_default,opus,high --only <几例>`。预期日志出现「preflight: all 18 fixture projects open」，回复不说项目打不开。

## 限制

- intro、顶层文件和电脑的模型配置取自今天的 dev 库，不是用例当时的状态（只有对话历史按日期截断）。原生对话只有标题和首条消息，没有回答正文（生产 digest 的 Work 摘要读的是会话回答）。
- 飞书在评测里仍是关的（M4）。「这里 / 这台机器」类回放用例（M3）和可争议金标（M7）没有改金标，在基线报告里单独归类。
- 图片是合成的同类图，不是原图。
