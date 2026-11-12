import "./fixtures/native-test-homes.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDRY_TOOLS_ROOT = mkdtempSync(join(tmpdir(), "path-tools-"));
const { joinPaths, servicePath } =
  await import("../dist/platform/path-list.js");
const { readLoginShellPath, loginShellPath, setLoginShellPathReaderForTests } =
  await import("../dist/session/login-path.js");
const { sessionEnvironment } =
  await import("../dist/session/session-ambient.js");
const { managedToolsBin } = await import("../dist/skills/managed-tools.js");

test("a login shell PATH is read between markers, without session folders", () => {
  const out = readLoginShellPath({
    shell: "/bin/zsh",
    run: (shell, args) => {
      assert.equal(shell, "/bin/zsh");
      assert.equal(args[0], "-lc");
      return {
        status: 0,
        stdout:
          "motd\n__FOUNDRY_LOGIN_PATH__/a:/h/.foundry/session-bin/sess_1:/b__FOUNDRY_LOGIN_PATH__",
      };
    },
  });
  assert.equal(out, "/a:/b");
});

test("a failed or silent login shell falls back and logs", () => {
  const logs = [];
  for (const result of [
    { error: new Error("timed out") },
    { status: 1, stdout: "" },
  ])
    assert.equal(
      readLoginShellPath({ run: () => result, log: (m) => logs.push(m) }),
      undefined,
    );
  assert.equal(logs.length, 2);
  assert.match(logs[0], /service PATH/);
});

test("PATH lists are joined without repeats and service PATH drops session folders", () => {
  assert.equal(joinPaths("/a:/b", undefined, "/b:/c::/a"), "/a:/b:/c");
  assert.equal(
    servicePath(
      "/u/.foundry/session-bin/sess_1:/usr/bin:/u/.foundry-tools/.sessions/sess_1:/usr/bin:/u/.foundry/session-bin/sess_1",
    ),
    "/usr/bin",
  );
});

test("a session PATH is its tool folder, the login PATH, then the service PATH", () => {
  setLoginShellPathReaderForTests(() => "/home/u/.local/bin:/usr/bin");
  const saved = process.env.PATH;
  process.env.PATH = "/usr/bin:/svc/bin:/h/.foundry/session-bin/sess_old";
  try {
    const env = sessionEnvironment(
      "/w",
      { id: "p", runtime: "claude", connectionType: "local_login" },
      { id: "sess_order", input: { id: "i", prompt: "x" } },
    );
    assert.deepEqual(env.PATH.split(":"), [
      managedToolsBin(),
      "/home/u/.local/bin",
      "/usr/bin",
      "/svc/bin",
    ]);
    assert.equal(loginShellPath(), "/home/u/.local/bin:/usr/bin");
    setLoginShellPathReaderForTests(() => undefined);
    const fallback = sessionEnvironment(
      "/w",
      { id: "p", runtime: "claude", connectionType: "local_login" },
      { id: "sess_order", input: { id: "i", prompt: "x" } },
    );
    assert.deepEqual(fallback.PATH.split(":"), [
      managedToolsBin(),
      "/usr/bin",
      "/svc/bin",
    ]);
  } finally {
    process.env.PATH = saved;
    setLoginShellPathReaderForTests(undefined);
  }
});
