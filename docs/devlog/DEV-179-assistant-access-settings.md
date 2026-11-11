# DEV-179 · Assistant 权限包与设置页统一

## 问题

Assistant 实际能访问的工作区、连接器、设备和 Skill 分散在多个旧判断里，无法清晰表达“关闭 / 只读 / 读写”，也无法在风险写之前统一确认。Assistant 设置页右侧内容区仍与设备设置、连接器和模型服务页明显不一致，十个分区存在输入宽度、字号、间距和表面层级不统一的问题。

## 调查

- 旧连接器开关只有 enabled/disabled，无法表达只读；device-held 账号也没有权限包信封。
- 可访问对象缺少统一的 include/exclude 规则，MCP、派发和项目索引各自判断。
- 风险写已经有 `remove_device` 类确认卡片，可以复用以一次性审批完全相同的请求。
- 设置页问题不只是左侧菜单：内容直接铺在页面底色上，字段尺度与参照页不同，hover 与选中态叠加。

## 修复

- 新增 PermissionPackage：工作区 include/exclude、连接器账号 `off/read/write`、直接资源租用白名单和 Skill 范围；旧 connector opt-out 迁移为 `off`。
- 权限判定集中到 `permission` 模块，并接入 Assistant MCP 可达范围、路由候选、每轮项目索引、网关和派发。
- 网关写操作按风险分类；删除、对外发送、DNS、App Store Connect 变更等风险写创建 `connector_write` 提案，审批后只放行一次完全相同请求。
- Assistant 连接账号使用“关闭 / 只读 / 读写”三态并统一保存全部账号；device-held 只读暂未隔离写入的 P1 限制在页面明示。
- `NavList` 新增 surface tone，选中与 hover 使用平涂且无 outline/border/shadow；`Panel` 新增 plain、`SectionPanel` 新增 flush，十个设置分区统一为单层页面表面、相同字段宽度、标题和保存行。
- 保存交互、双语文案和窄屏布局统一；不新增页面私有样式。

## 部署与版本证据

该终态已部署到 dev：Server/Web `120fe737567f9e88`，Worker `…1794395454`。服务端权限包、连接账号三态 UI 和设置页第二轮统一均在部署快照中。

## 检查

- 服务端：Go build/vet，权限默认值与迁移、集中判定、read 拒绝写、普通写直通、风险写确认后执行、非 Assistant 不受影响的目标测试通过；契约生成与 Web tsc 通过。
- 连接账号 UI：3/3 专项测试、personal-agent 33/33、风险确认单次提案测试、Web tsc 与 15 项 UI audit 通过；真实浏览器 1280 light/dark、390 px 无溢出，实际保存返回 200。
- 设置页统一：personal-agent 31/31、Web tsc 通过；浏览器实测 10 个分区均无边框、透明背景、无阴影、零 padding，无横向溢出。
- PR 合并前继续执行本分支 Go build/vet、Web typecheck。

## 限制

- device-held 连接器的只读写隔离依赖 P1 跨设备本地探针/窄代理；当前完成权限包、off 过滤和三态 API。
- 设置页截图是 Agent 自验，不等同于用户人工验收。

## 验收步骤与预期结果

1. 打开 Assistant 设置的十个分区：内容应位于与其他设置页一致的单层页面表面，短字段不拉满全宽，保存状态一致。
2. 将某连接器设为只读：读取应成功，写入应被拒绝；设为关闭后该账号不应出现在助理可用列表中。
3. 让助理执行高风险写入：应出现提案卡片；拒绝时不执行，接受后仅执行一次相同请求。
4. 在 light/dark 与 390 px 下检查连接账号：三态控件、说明和保存行不重叠、不横向溢出。
