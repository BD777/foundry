# DEV-168 · 统计 S-1a/S-1b/S-1c：表、写入、回填与查询 API

## 问题

逐回合事件能展示当前会话用量，但跨会话统计需要对模型请求做结构化持久化；没有稳定表、幂等写入、历史回填和查询 API 就无法生成可靠汇总。

## 调查与修复

- 新增 usage statistics 契约、SQLite 表和索引，以请求身份去重，保留模型、时间、token、成本与失败状态。
- Server 在回合与模型请求事件路径写入统计，写入失败不阻断会话主流程，并按确定性时间窗口回填已有会话。
- 新增统计查询 API，支持按范围、模型和维度聚合；权限沿用工作区访问规则。
- usage 表登记为历史事实：工作区迁移不重写原 device id，删除设备/工作区/会话不抹除用量记录。
- 模块边界审计与 Server、store、回填和 API 测试同步更新。

## 部署与版本证据

该持久化与查询层属于 dev 已部署状态，已纳入 2026-11-10 部署状态快照 D。

## 检查

- 契约重新生成
- Server `go build ./...`
- Server `go vet ./...`
- `go test ./internal/httpapi ./internal/sqlitestore ./internal/usagestats -run '<usage stats tests>'`
- 设备删除、workspace migration 与 owned-row 分类测试

## 限制

本次为提交窗口本地演练，不推送、不创建 PR。统计只覆盖已记录事件；历史缺失 token 保持缺失。

## 验收步骤

1. 运行几个 Claude/Codex 回合，确认同请求重复事件只写入一行。
2. 重启 Server 或复制一个有历史的 DB 后执行回填，统计应补齐可识别请求且不重复。
3. 查询工作区内最近 24 小时统计，应按模型返回请求数、输入/输出与成本。
4. 非成员访问同一查询应被拒绝。
