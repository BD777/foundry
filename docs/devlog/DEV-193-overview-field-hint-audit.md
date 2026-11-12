# DEV-193 概览页 FieldHint 与 `<Trans>` 提示审计

## 状态

已合入 main（PR #264，squash 7e2a354c）。

概览页的 Git 状态说明和离线说明已改用共享 `FieldHint`，Web build `eca52bfb4caeeb3e` 已部署 dev；`audit-hints` 也补上了静态 `<Trans i18nKey>` 检测，只改检查脚本，因此没有再次部署 Web。

## 问题

- 工作区概览的 Git 状态说明和离线说明是字段/状态辅助文字，却直接渲染为 `<p>`；这与共享提示规范不一致，也让审计只能把新出现的裸段落登记成例外。
- `audit-hints` 原先只识别 `t("...Hint")` 调用；用 `<Trans i18nKey="...Hint">` 渲染同类文案时会漏检，尤其容易藏在宿主 `<p>` 或非提示组件里。

## 调查

- 概览页实现与部署：[sess_1794467052784850629](https://dev.foundryapp.app/chats/sess_1794467052784850629)。
- `<Trans>` 审计补齐：[sess_1794469782345637159](https://dev.foundryapp.app/chats/sess_1794469782345637159)。
- `FieldHint` 是 `components/ui/field.tsx` 导出的共享字段提示；概览的离线说明还需要保留 `role="status"` 的语义。
- 审计应把 `Trans` 当作透明的翻译包装，继续检查它真正位于哪个宿主元素或属性，而不是把 `Trans` 本身当作合法宿主。

## 修复

- 工作区概览的 `overview.notGitNote`、`overview.nestedNote` 和 `overview.offlineNote` 改用 `FieldHint`；`offlineNote` 保留 `role="status"`。
- `hint-baseline.json` 删除已经修复的 `overview.notGitNote <p>` 和 `overview.offlineNote <p>` 例外。
- `audit-hints.mjs` 新增静态 `i18nKey` 提取，支持多行属性、任意属性顺序、自闭合与非自闭合写法。
- `t(...)` 与 `i18nKey` 共用 `hintKey`、宿主标签和宿主属性判定；遍历时同时检查调用表达式和 JSX 属性。

## 部署与版本证据

- Web build `eca52bfb4caeeb3e` 已通过 `flock /tmp/fdy-deploy.lock` 发布到 dev；上一版 `574590acda8fd8ff` 保存在 `~/.foundry/server/web-releases/overview-git-hint/previous-20261112T073352Z`。
- 部署后核验时，公网 `version.json` 返回 `eca52bfb4caeeb3e`，线上主包包含 `overview.offlineNote` 的 `FieldHint` 写法。
- `audit-hints.mjs` 是仓库检查脚本，本次没有页面 bundle 变化，因此没有为新审计逻辑单独产生 Web build。

## 检查

- `pnpm typecheck` 通过，退出码 0，无诊断输出。
- `node scripts/audit-hints.mjs` 按预期只报告两条既有失败：`model-guide-dialog.tsx:114` 的 `modelGuides.editHint` 和 `unlinked-models.tsx:94` 的 `modelGuides.unlinkedIntro`。
- 所有 `t(...)` 与静态 `<Trans i18nKey="...">` 提示都经过同一宿主判定；新增 `<Trans>` 违规为 0。
- `audit-component-system.mjs` 与 `audit-state-layout.mjs` 均通过。

## 限制

- 两条模型说明书的既有 `MutedText` hint 失败未在本项修复，审计仍以退出码 1 结束。
- `<Trans>` 检测只识别静态字符串 `i18nKey`；动态 key 不会被这套 AST 规则归到固定文案，仍需人工审查。
- 本次没有逐页重新检查所有现存的裸 `<p>{t(...)}</p>`，只确认没有新增 hint key 违规。

## 验收步骤

1. 打开一个不是 Git 仓库、位于父级 Git 仓库内，或设备离线/重连中的工作区概览：Git 状态说明和离线说明应使用共享字段提示的排版与颜色；离线说明仍会被读屏作为状态播报。
2. 在模型说明书页面运行 `node scripts/audit-hints.mjs`：只应看到上述两条已知失败。
3. 新增一个静态 `<Trans i18nKey="...Hint">` 并将它放在普通 `<p>` 中：`audit-hints` 应指出宿主为 `<p>`，而不是静默通过。
