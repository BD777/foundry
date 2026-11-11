# DEV-181 · 部署快照的收尾差异

## 问题

提交窗口按主题拆分后，部署快照里仍有少量文件无法自然归入前六个 PR：已有功能的补充测试、已使用依赖的声明与锁文件、共享审计配置，以及一条项目导航约定。如果遗漏，最终 main 会与已部署状态不一致；如果手工改写，又可能把测试或生成配置拆坏。

## 调查

从第七组分支与 `tmp/deployed-20261111` 逐文件比较，剩余差异只有：

- `apps/server/internal/sqlitestore/model_notes_test.go`：模型心得历史、所有权和执行模型回退测试；
- `apps/server/internal/sqlitestore/model_pools_test.go`：模型池游标与按提供方限定的用量测试；
- `apps/web/package.json`、`pnpm-lock.yaml`：统计图表已经使用的 `recharts` 及其锁定依赖；
- `apps/web/scripts/audit-inline-styles.mjs`：图表颜色通过限定 CSS 变量传递的审计例外；
- `apps/web/test/foundry-data-stream-order.test.mjs`：设备状态事件保留 `runtimeState` 的并发投影回归；
- `.prettierignore`：排除随用量统计发布的价格目录；
- `AGENTS.md`：把页面内导航统一到 `nav-list` 的 on-surface 变体。

这些文件的内容与 D 完全一致，没有为本 PR 改写产品语义。

## 修复

按终态快照逐文件恢复上述差异，只新增本 devlog 与索引行。模型与用量的测试跟随其已合入的服务端实现，前端依赖与审计配置跟随统计图表，设备投影测试跟随自适应并发，导航约定跟随设置页统一。

## 部署与版本证据

所有代码和配置均来自已部署状态快照 `tmp/deployed-20261111`（提交 `8941dbcb`）。提交窗口开始时的 dev 部署为 Server/Web `120fe737567f9e88`、Worker `…1794395454`。

## 检查

- `apps/server`：`go build ./...` 通过，`go vet ./internal/sqlitestore` 通过。
- `go test ./internal/sqlitestore -run 'Test(ModelNotesKeepHistoryAndStayWithTheirOwner|ExecutionDefaultsFallBackByScope|ModelPoolsKeepOwnerCursorAndProviderScopedUsage)$'` 通过。
- `apps/web`：`tsc --noEmit` 通过。
- `node --import ./test/register-bundler-resolve.mjs --test test/foundry-data-stream-order.test.mjs` 通过。
- `git diff tmp/deployed-20261111 <第七组分支>` 只包含 `docs/devlog/DEV-176` 至 `DEV-181` 与 `docs/devlog/README.md` 的新增索引。

## 限制

- 本 PR 收纳的是已部署实现的尾部和测试，不引入新的运行时行为。
- 数据库迁移与真实设备数据仍由各组原有的部署和回归证据覆盖。

## 验收步骤与预期结果

1. 依次合入七个 PR 后，本地 `main` 与 `tmp/deployed-20261111` 比较：除六个新增 devlog 和 README 索引外，不应有任何差异。
2. 运行 `pnpm --filter @bd777/foundry-web typecheck`：统计图表依赖与审计配置应能解析，Web 类型检查通过。
3. 运行 `go test ./internal/sqlitestore -run 'Test(ModelNotesKeepHistoryAndStayWithTheirOwner|ExecutionDefaultsFallBackByScope|ModelPoolsKeepOwnerCursorAndProviderScopedUsage)$'`：模型心得、执行默认和模型池存储行为应通过。
4. 运行 Web 的 `foundry-data-stream-order.test.mjs`：设备事件更新后 `runtimeState` 应被保留，其他整设备替换语义不变。
