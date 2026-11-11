# Acme CLI: program extension

## English

This folder is a complete, fictional example of a device-held connector
extension that ships a small program. Foundry starts `connector.mjs`, asks it
for the device's own Acme login, and leaves signing in to the terminal.

Choose this shape when the tool needs a little logic to read its login, or when
its output cannot be described by the declarative `cli` block. The manifest
declares `entry: node connector.mjs`; the program implements `initialize`,
`connector.status` and `shutdown`. The connector declares a `terminal` sign-in
method, so the page shows `acme login` and only checks the result.

The example expects a fictional `acme` program on the device:

```sh
acme whoami --json
# {"user":"person@example.test","version":"1.2.3","expiresAt":"2026-12-31T00:00:00Z"}
```

It does not implement guided sign-in, installation, authorization or model
access. Those methods are only needed when the descriptor declares them.

Install it from a checkout of this repository:

```sh
foundry-worker extension add ./extensions/examples/acme-cli-program
```

## 中文

这个目录是一个完整的虚构示例：设备持有型连接器扩展自带一个小程序。Foundry
启动 `connector.mjs`，向它询问这台设备自己的 Acme 登录状态，并把登录交给终端。

如果读取登录需要一点逻辑，或者工具的输出无法用声明式 `cli` 段描述，就选这种
写法。manifest 声明 `entry: node connector.mjs`；程序实现 `initialize`、
`connector.status` 和 `shutdown`。连接器声明 `terminal` 登录方式，所以页面显示
`acme login`，只检查结果。

示例假定设备上有一个虚构的 `acme` 程序：

```sh
acme whoami --json
# {"user":"person@example.test","version":"1.2.3","expiresAt":"2026-12-31T00:00:00Z"}
```

它没有实现 Foundry 引导的登录、安装、附加授权或模型接入；只有描述符声明了
对应能力时才需要实现这些方法。

在仓库检出中安装：

```sh
foundry-worker extension add ./extensions/examples/acme-cli-program
```
