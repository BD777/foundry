# DEV-194 executor 接入执行模型

## 状态

已实现、验证并部署 dev Server 与 Web（2026-11-12）。等待人工验收。

## 问题

DEV-188 已让编排者使用“默认 + alternatives”的执行模型，但助理派出的 helper 仍只读取旧的 executor 角色配置。多助理第一版需要把 executor 改为读取目标工作区的执行模型，并允许每个助理单独覆盖；协调者只在默认模型说明书明确不适用的步骤才选择 alternative。

## 实现

- executor 解析顺序：助理覆盖 → 目标工作区覆盖 → 全局默认 → 旧 `RoleOverrides` / `runDefault`。其他角色不变；实现见 [run/resolve.go](../../apps/server/internal/personalagent/run/resolve.go)。
- assistant 覆盖存入 `PersonalAgentSettings.executionModels`，结构与执行模型的默认项和 alternatives 相同，见 [store/personal_agent.go](../../apps/server/internal/store/personal_agent.go)。
- worker group 仍调用现有 `httpapi.chooseWorkerGroupMember`，没有复制选组算法，见 [personal_agent_ports.go](../../apps/server/internal/httpapi/personal_agent_ports.go)。
- `dispatch_item` 新增可选 `executionChoice`：`default`、1-based alternative 序号或稳定 id；capture 前校验，值不在有效列表时返回错误。选择随 operation 的 `payload_json` 持久化，没有改 `pa_*` 表结构，见 [assistant/operations.go](../../apps/server/internal/personalagent/assistant/operations.go) 和 [mcp_tools.json](../../apps/server/internal/httpapi/mcp_tools.json)。
- `get_execution_default` 在个人助理会话里返回该助理的覆盖；alternatives 带稳定 `id`，group 继续展开成员。契约只定点增加 `ExecutionModelChoice.id` 和 `assistant` scope。
- 助理设置页继续用原选择器设置 coordinator；executor 改用共享 [execution-default-fields.tsx](../../apps/web/src/components/workspace/execution-default-fields.tsx) 的受控模式，未覆盖时明确显示“沿用工作区或全局”，覆盖随助理设置整页保存。中英文案见 `personalAgent` locale。

## 检查

- Server：

  ```text
  go test ./internal/personalagent/... ./internal/httpapi/ -run 'Executor|RunPreference|Resolve|Dispatch|ExecutionDefault|PersonalAgent'
  ok github.com/foundry-dev/foundry/apps/server/internal/httpapi 47.862s
  ```

  同批 `personalagent` 各包均通过。覆盖了解析优先级、executor worker group、alternative id、列表外 `executionChoice` 拒绝，以及助理 override 的 MCP 读取。

- Web：`pnpm typecheck` 通过；`personal-agent.test.mjs` 34/34；执行模型相关 `profiles-feature.test.mjs` 7/7；`worker-group-scope.test.mjs` 1/1。
- `audit-component-system.mjs` 通过。`audit-hints.mjs` 只剩两条事先允许的既有失败：`model-guide-dialog.tsx:114`、`unlinked-models.tsx:94`。
- 真实 Chromium：1280×577 与 390×844 深色下，未覆盖提示、指定按钮和覆盖回退均可见；窄屏 `scrollWidth=380`、`viewport=390`，没有横向溢出。临时覆盖最后已恢复为未设置，并回读确认为空。

## 部署

- Server 备份：`~/.foundry/server/releases/dev023-candidate/foundry-server.pre-dev191-exec`。
- 在 `/tmp/fdy-deploy.lock` 内构建并原子替换 dev candidate；`pm2 restart foundry-server` 后 online，restart count 保持 `63`，等待 30 秒后 uptime `49s`、PID `2845193`，`http://127.0.0.1:31982/healthz` 返回 200。
- Web 在同一个发布锁内构建并发布到 `~/.foundry/server/web-releases/dev191-exec`；新 build `a0f257aa3a46bbb8`，旧 build `82e7bf6a86eca8a4` 保存在 `previous-20261112T103232Z`。`https://dev.foundryapp.app/version.json` 返回同一 build。

## 限制与验收

- 真实浏览器用同源 API 临时注入合成覆盖来检查 UI 回显与清除；完整 provider/model 目录在 e2e-alice 的 executor 选择器里为空，因此没有用鼠标从空目录新建模型覆盖。字段交互和保存请求体由 Web 回归覆盖。
- 没有在真实 helper 上运行模型；worker group 的实际成员选择由 Server 定向测试覆盖。
- 未提交，未改现有单助理路由形态。

验收步骤：

1. 打开“助理设置 → 用哪个模型”。未设置 executor 覆盖时应看到“沿用工作区或全局的执行模型”；coordinator 说明应为“助理自己用的模型：建议用强模型，它只负责路由，不做具体工作”。
2. 指定一个执行模型并保存；重新打开应保留 provider/model 与 alternatives，请求体中的 `executionModels` 与所选项一致。
3. 清除覆盖并保存；重新打开应回到“沿用工作区或全局”，并确认 helper 使用目标工作区覆盖，否则使用全局默认。
4. 在默认模型说明书命中 `avoid` / `weaknesses` 时，以 `dispatch_item.executionChoice` 指定 alternative；返回的 helper preview 应显示所选配置；传入列表外值应被拒绝。
