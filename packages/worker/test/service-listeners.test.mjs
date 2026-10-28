import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  listServiceListeners,
  parseLinuxListeners,
  parseLsofListeners,
  processLabel,
  reachableLinuxAddress,
} from "../dist/service-listeners.js";

test("only loopback-reachable LISTEN sockets count", () => {
  const v4 = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1
   1: 00000000:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 112 1
   2: 0A00000A:1F92 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 113 1
   3: 0100007F:1F93 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 114 1`;
  assert.deepEqual(
    [...parseLinuxListeners(v4, false)],
    [
      [8080, ["111"]],
      [8081, ["112"]],
    ],
  );
  assert.equal(reachableLinuxAddress("0".repeat(32), true), true);
  assert.equal(
    reachableLinuxAddress("0000000000000000FFFF00000100007F", true),
    true,
  );
  // ::1 alone is not reachable at 127.0.0.1, which tunnels dial.
  assert.equal(
    reachableLinuxAddress("00000000000000000000000001000000", true),
    false,
  );
});

test("process labels never carry arguments beyond a script name", () => {
  assert.equal(
    processLabel(["/usr/bin/python3", "-u", "/srv/app/serve.py", "--token=s"]),
    "python3 serve.py",
  );
  assert.equal(
    processLabel(["/opt/bin/gatewayd", "console", "--secret", "x"]),
    "gatewayd",
  );
  assert.equal(processLabel([""]), undefined);
  const lsof = parseLsofListeners(
    "p10\ncnode\nn127.0.0.1:5173\nn[::1]:5174\np11\ncpython3\nn*:8000\nn10.0.0.2:9000\n",
  );
  assert.deepEqual(
    [...lsof].map(([port, owner]) => [port, owner?.pid]),
    [
      [5173, 10],
      [8000, 11],
    ],
  );
});

test(
  "a server started in the workspace is detected and attributed",
  { skip: process.platform !== "linux" && "Linux /proc scan" },
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "listeners-ws-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "listeners-other-"));
    const serve = (cwd) =>
      spawn(
        process.execPath,
        [
          "-e",
          "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port))",
        ],
        { cwd, stdio: ["ignore", "pipe", "inherit"] },
      );
    const inside = serve(workspace);
    const outside = serve(elsewhere);
    try {
      const port = async (child) =>
        Number(
          await new Promise((resolve) => child.stdout.once("data", resolve)),
        );
      const [a, b] = await Promise.all([port(inside), port(outside)]);
      const listeners = await listServiceListeners(realpathSync(workspace));
      const ours = listeners.find((l) => l.port === a);
      const theirs = listeners.find((l) => l.port === b);
      assert.equal(ours?.inWorkspace, true);
      assert.match(ours?.process ?? "", /node/);
      assert.equal(theirs?.inWorkspace, false);
      const excluded = await listServiceListeners(workspace, [a]);
      assert.equal(
        excluded.some((l) => l.port === a),
        false,
      );
      inside.kill();
      await new Promise((resolve) => inside.once("exit", resolve));
      const after = await listServiceListeners(workspace);
      assert.equal(
        after.some((l) => l.port === a),
        false,
      );
    } finally {
      inside.kill();
      outside.kill();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  },
);
