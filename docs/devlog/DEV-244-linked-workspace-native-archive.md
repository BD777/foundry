# DEV-244 归档原生会话把链接父目录当成另一个工作区

状态：已部署 dev（train8-20261116）；已合入 main（PR #270）。实现与定向验证完成（byte-dev 上新增用例通过；唯一失败的既有 Codex-CLI 用例在干净 `HEAD` 上同样失败）。工作树 `~/workspace/foundry-dev244`（以共享树 HEAD `4e830ac6` 为基线，已应用共享树的未提交改动；补丁 = 本工作树的 `git diff` 加新增文件）。

来源：E2E 第三轮，编排会话 `sess_1794464313271186377` 下发。

## 问题

归档一个原生会话时失败，返回 `Native archive conflict or workspace mismatch`。byte-dev 上无法归档 `ccm-omh-integration` 的 Claude 会话。

## 根因

`packages/worker/src/session/chat/native-archive.ts` 的 `ownsWorkspace` 用字符串比较原生 transcript 记录的 cwd 与 Foundry 的工作区路径：

```ts
resolve(row.payload.cwd) === resolve(workspace);
```

byte-dev 上 transcript 记录 `/data00/home/dengcanwen/workspace/ccm/projects/ccm-omh-integration`，Foundry 注册的路径是 `/home/dengcanwen/...`。`/home/dengcanwen` 是指向 `/data00/home/dengcanwen` 的链接，两者是同一个目录（同一 dev:ino），但 `resolve()` 不跟随链接，字符串永远不相等。这与 DEV-228 的链接家目录是同一根因。

同一个比较也在原生会话列表/历史里各有一份：`native-chat.ts` 用 `logFolder(...) !== workspacePath` 和 `parsed.workspacePath !== workspacePath` 过滤日志，链接父目录下的 native 会话会从 Foundry 的列表里消失，归档后重新读取也找不到。

## 修复

`packages/worker/src/platform/paths.ts` 新增 `samePath(a, b)`，复用已有的 `canonical()`（路径存在时用 `realpathSync`，不存在时递归真实化父目录再拼回尾部）：

1. 入口先 `resolve()`；字符串相同直接为真；
2. 否则比较 `canonical()` 后的真实路径，覆盖链接父目录；
3. 真实路径仍不同时回退到 `statSync` 的 `dev:ino`，覆盖同一目录的 bind mount；`ino` 为 0 的文件系统不参与该判断，空路径永远不匹配。

调用点：

- `native-archive.ts` `ownsWorkspace`：Codex `session_meta.payload.cwd` 和 Claude 首行 `cwd` 都改用 `samePath`。
- `native-chat.ts`：`nativeChatLogPath` 与 Codex/Claude 工作区扫描的 3 处 `logFolder`、3 处 `workspacePath` 比较全部改用 `samePath`。

检查过的其他位置：

- `daemon/workspace-migration/scan.ts` 的 `codexRolloutCwd` 已用 `within(folder, cwd) || within(folderReal, cwd)`，`folderReal` 就是真实路径，已覆盖链接。
- `daemon/control-connection.ts` 与 `workspace/workspaces.ts` 也有工作区路径相等比较，但比的是两个 Foundry 侧登记路径（不是 transcript 记录的 cwd），语义是「同一登记」而不是「同一目录」，不在本次范围，保持原样。

## 测试

- `test/platform-paths.test.mjs` 新增 `samePath`：真实目录与指向它的链接互相匹配；无关目录、不存在的路径、空字符串不匹配。
- `test/native-archive.test.mjs` 新增：Claude 与 Codex 各建一个指向工作区的链接，transcript 记录真实路径、`applyNativeArchive` 传入链接路径时 dry run 为 `active`（不再报 workspace mismatch）；同一 transcript 传无关目录时为 `failed` 且错误含 `workspace mismatch`。

定向运行（byte-dev，家目录是链接，经 `scripts/remote-check.sh --worker test`）：

```text
test/platform-paths.test.mjs test/native-archive.test.mjs
# tests 27 / pass 26 / fail 1
ok 8  - native archive ownership follows a linked workspace and refuses another folder
ok 27 - samePath follows a linked path to the directory it names
not ok 11 - installed Codex archives a scratch cascade and restores only recorded descendants
            ENOENT: ... archived_sessions/rollout-…-5555….jsonl
```

唯一失败的是「installed Codex …」：它要求设备上真实安装的 Codex CLI，失败点是预先归档的 rollout 在归档后不在原处；该用例不调用本次改动的 `ownsWorkspace` 或列表比较。用干净的 `HEAD` 工作树在同一台 byte-dev 重跑同一文件，同一用例同样失败（`ENOENT` 指向同一个文件），说明是 byte-dev 上 Codex CLI 的既有环境问题，不是本次回归。新加的两个用例都通过。

## 验收步骤

1. 在 byte-dev 上给 `ccm-omh-integration` 的原生 Claude 会话点归档：不再报 `Native archive conflict or workspace mismatch`，会话出现在归档区。
2. 同一工作区的原生会话列表仍能看到归档前后的会话，不因 `/home/...` 与 `/data00/...` 的写法差异消失。
3. 用无关工作区路径调用归档时仍被拒绝（`workspace mismatch`）。

## 限制

- 未在真实 byte-dev 工作区触发一次真实归档（只跑定向测试，避免改动本人会话记录）。
- `dev:ino` 回退只在真实路径不同时执行；网络文件系统若返回不稳定 inode，仍以真实路径判断为准。

## 时间线

| 时间       | 进展                                                                                                                                                                                                                                                                              | 待办 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 2026-11-16 | 复现路径读代码确认 `ownsWorkspace` 的字符串比较；新增 `samePath` 并替换归档与列表中的 8 处比较；新增 2 个测试用例。byte-dev 定向 Worker 测试 27 个中 26 通过，唯一失败（installed Codex cascade）在干净 `HEAD` 工作树上同样失败，属既有环境问题；未部署、未提交，补丁交编排会话。 | —    |
| 2026-11-16 | CanWendeMac-mini 定向 Worker 测试通过（`platform-paths` 5/5；`native-archive` 21 通过、1 跳过——需真实 Codex CLI 的既有用例），prettier 通过；PR #270 合入 main。                                                                                                                  | —    |
