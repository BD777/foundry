# Acme CLI: declarative extension

## English

This folder is a fictional device-held example with no program. The Worker runs
the device's own `acme` command according to the `cli` block, reads its JSON
answers and answers the extension protocol itself.

Choose this shape when the tool's public command line can report status as
JSON, read a sign-in value, and sign out. The manifest declares `status`,
`version`, `signIn` and `signOut`; no `entry` or `connector.mjs` is needed.
Secrets named by a guided method stay out of the arguments and are written to
stdin.

The example expects a fictional `acme` program on the device:

```sh
acme status --json
# {"signedIn":true,"user":"person@example.test","expiresAt":"2026-12-31T00:00:00Z"}
acme --version
# acme 1.2.3
acme login --token-stdin
acme logout
```

The token field is passed to `acme login --token-stdin` on stdin. Replace the
commands and JSON pointers with the public interface of your own tool.

Install it from a checkout of this repository:

```sh
foundry-worker extension add ./extensions/examples/acme-cli-declarative
```

## 中文

这个目录是一个虚构的设备持有型示例，不写程序。Worker 按 `cli` 段运行设备上的
`acme` 命令，读取它的 JSON 回答，并自己回答扩展协议。

如果工具的公开命令行能用 JSON 报告状态、接收登录值并登出，就选这种写法。
manifest 声明 `status`、`version`、`signIn` 和 `signOut`；不需要 `entry` 或
`connector.mjs`。引导式登录方法里声明的秘密字段不会进参数，而是写到 stdin。

示例假定设备上有一个虚构的 `acme` 程序：

```sh
acme status --json
# {"signedIn":true,"user":"person@example.test","expiresAt":"2026-12-31T00:00:00Z"}
acme --version
# acme 1.2.3
acme login --token-stdin
acme logout
```

令牌字段经 stdin 交给 `acme login --token-stdin`。把命令和 JSON pointer 换成
你自己工具的公开接口即可。

在仓库检出中安装：

```sh
foundry-worker extension add ./extensions/examples/acme-cli-declarative
```
