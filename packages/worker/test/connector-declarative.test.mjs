// Declarative connector extensions (docs/connector-extensions.md, "声明式扩展"):
// an extension without a program whose connectors say how to drive the
// tool's own command line. A fake tool answers from a state file the test
// writes; nothing here names a real tool.
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionHost } from "../dist/connectors/extensions/host.js";
import {
  addExtension,
  removeExtension,
} from "../dist/connectors/extensions/registry.js";
import { parseExtensionManifest } from "../dist/connectors/extensions/manifest.js";
import { extensionConnectorDescriptors } from "../dist/connectors/index.js";
import { render, at } from "../dist/connectors/extensions/declarative.js";

const bin = mkdtempSync(join(tmpdir(), "fdy-decl-bin-"));
const state = join(bin, "state.json");
const calls = join(bin, "calls.jsonl");
// gwcli status|join <name>|remove <name> [--json]; join reads the code on stdin.
writeFileSync(
  join(bin, "gwcli"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.existsSync(${JSON.stringify(state)}) ? fs.readFileSync(${JSON.stringify(state)}, "utf8") : '{"profiles":[],"running":true}');
const [cmd, name] = process.argv.slice(2);
// Status reads run fakes concurrently: replace the file whole, never half-written.
const save = () => { const tmp = ${JSON.stringify(state)} + "." + process.pid; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, ${JSON.stringify(state)}); };
const stdin = cmd === "join" ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), stdin }) + "\\n");
const out = (value, code = 0) => { process.stdout.write(JSON.stringify(value)); process.exit(code); };
if (cmd === "--version") { process.stdout.write("gwcli 3.4.5\\n"); process.exit(0); }
if (cmd === "status") out({ ok: true, data: { running: state.running, profiles: state.profiles } });
if (cmd === "join") {
  if (stdin.trim() !== "good-code") out({ ok: false, error: { message: "That is not an invite.", hint: "Paste the whole code." } }, 2);
  state.profiles.push({ name, tools: ["claude"] }); save(); out({ ok: true, data: { name } });
}
if (cmd === "remove") { state.profiles = state.profiles.filter((p) => p.name !== name); save(); out({ ok: true }); }
out({ ok: false, error: { message: "unknown" } }, 9);
`,
);
writeFileSync(
  join(bin, "gwhelper"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
if (state.describeFails) process.exit(3);
if (process.argv.includes("--describe")) process.stdout.write(JSON.stringify({ identity: "id-" + process.argv[2] }));
`,
);
chmodSync(join(bin, "gwcli"), 0o755);
chmodSync(join(bin, "gwhelper"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const manifest = {
  manifestVersion: 1,
  id: "gw",
  name: "Gateway tools",
  version: "1.0.0",
  protocol: 1,
  connectors: [
    {
      kind: "gateway",
      label: "Gateway",
      tool: { command: "gwcli", source: "device" },
      provides: { modelAccess: { runtimes: ["claude"] } },
      signIn: {
        methods: [
          {
            id: "invite",
            kind: "guided",
            label: "Join",
            fields: [
              {
                id: "code",
                label: "Invite code",
                type: "secret",
                required: true,
              },
              {
                id: "name",
                label: "Name",
                type: "text",
                default: "default",
                pattern: "^[a-z]+$",
              },
            ],
          },
        ],
      },
      cli: {
        version: { args: ["--version"], pattern: "(\\d+\\.\\d+\\.\\d+)" },
        status: {
          args: ["status", "--json"],
          ok: "/ok",
          error: "/error/message",
          signedIn: [{ pointer: "/data/profiles", nonEmpty: true }],
          identity: { items: "/data/profiles", pointer: "/name" },
          problems: [
            {
              when: [{ pointer: "/data/running", equals: false }],
              message: "Its service is not running.",
            },
          ],
        },
        signIn: {
          invite: {
            args: ["join", "{name}", "--json"],
            stdin: "{code}\n",
            ok: "/ok",
            error: "/error/message",
            hint: "/error/hint",
          },
        },
        signOut: {
          forEach: "/data/profiles",
          args: ["remove", "{/name}", "--json"],
          ok: "/ok",
        },
        modelAccess: {
          items: "/data/profiles",
          where: [{ pointer: "/tools", includes: "claude" }],
          id: "gw_{/name}",
          label: "Gateway · {/name}",
          models: ["sonnet"],
          session: { command: "gwhelper", args: ["{/name}", "~/.gw"] },
          identity: { args: ["{/name}", "--describe"], pointer: "/identity" },
        },
      },
    },
  ],
};

function extensionFolder(value = manifest) {
  const dir = mkdtempSync(join(tmpdir(), "fdy-decl-ext-"));
  writeFileSync(join(dir, "foundry-extension.json"), JSON.stringify(value));
  return dir;
}

test("a declarative extension reads, signs in and out, and lists model providers through the tool", async (t) => {
  writeFileSync(state, JSON.stringify({ profiles: [], running: true }));
  writeFileSync(calls, "");
  addExtension(extensionFolder(), []);
  t.after(() => removeExtension("gw"));
  // The descriptor the device reports carries no cli.
  const reported = extensionConnectorDescriptors().find(
    (c) => c.kind === "gateway",
  );
  assert.equal(reported.cli, undefined);
  assert.equal(reported.adapter, "extension:gw");

  const host = new ExtensionHost({ log: () => {} });
  const status = (kind = "gateway") =>
    host.call("gw", "connector.status", { kind }, 30000);
  assert.deepEqual(await status(), {
    installed: true,
    installSource: "device",
    version: "3.4.5",
    signedIn: false,
  });

  // A wrong code: the tool's own words; a missing required field is refused before running it.
  assert.deepEqual(
    await host.call(
      "gw",
      "connector.signIn.begin",
      {
        kind: "gateway",
        scratch: bin,
        options: { method: "invite", code: "bad" },
      },
      30000,
    ),
    { status: "failed", error: "That is not an invite. Paste the whole code." },
  );
  assert.equal(
    (
      await host.call(
        "gw",
        "connector.signIn.begin",
        { kind: "gateway", scratch: bin, options: { method: "invite" } },
        30000,
      )
    ).status,
    "failed",
  );
  assert.equal(
    (
      await host.call(
        "gw",
        "connector.signIn.begin",
        {
          kind: "gateway",
          scratch: bin,
          options: { method: "invite", code: "good-code", name: "Bad Name" },
        },
        30000,
      )
    ).error,
    "Name does not have the expected form.",
  );
  assert.deepEqual(
    await host.call(
      "gw",
      "connector.signIn.begin",
      {
        kind: "gateway",
        scratch: bin,
        options: { method: "invite", code: "good-code" },
      },
      30000,
    ),
    { status: "complete" },
  );
  // The secret went on stdin, the default name in the arguments.
  const joined = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((c) => c.argv[0] === "join")
    .at(-1);
  assert.deepEqual(joined, {
    argv: ["join", "default", "--json"],
    stdin: "good-code\n",
  });
  assert.equal((await status()).identity, "default");

  const { profiles } = await host.call(
    "gw",
    "modelAccess.list",
    { kind: "gateway" },
    30000,
  );
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, "gw_default");
  assert.equal(profiles[0].label, "Gateway · default");
  assert.equal(profiles[0].identity, "id-default");
  assert.equal(profiles[0].session.command, join(bin, "gwhelper"));
  assert.deepEqual(profiles[0].session.args, [
    "default",
    join(process.env.HOME, ".gw"),
  ]);

  const patchState = (patch) =>
    writeFileSync(
      state,
      JSON.stringify({ ...JSON.parse(readFileSync(state, "utf8")), ...patch }),
    );
  const listed = async () =>
    (await host.call("gw", "modelAccess.list", { kind: "gateway" }, 30000))
      .profiles;

  // Signed in but its service is down: an error with the declared message,
  // and the profile is still listed, with that reason instead of an identity.
  patchState({ running: false });
  await assert.rejects(status(), /Its service is not running\./);
  const down = await listed();
  assert.equal(down.length, 1);
  assert.equal(down[0].id, "gw_default");
  assert.equal(down[0].identity, "");
  assert.equal(down[0].problem, "Its service is not running.");
  patchState({ running: true });

  // A helper that cannot confirm the identity keeps the profile listed too.
  patchState({ describeFails: true });
  const unconfirmed = await listed();
  assert.equal(unconfirmed.length, 1);
  assert.equal(unconfirmed[0].identity, "");
  assert.match(
    unconfirmed[0].problem,
    /Gateway · default could not confirm its identity \(the helper exited with code 3\)\./,
  );
  patchState({ describeFails: false });
  assert.equal((await listed())[0].problem, undefined);

  // Sign-out runs once per profile.
  await host.call("gw", "connector.signOut", { kind: "gateway" }, 30000);
  assert.equal((await status()).signedIn, false);
  await assert.rejects(
    host.call("gw", "connector.install", { kind: "gateway" }, 30000),
    /does not do connector\.install/,
  );
});

test("a declarative manifest is checked: cli without entry only, templates name only what exists", () => {
  const variant = (change) => {
    const copy = structuredClone(manifest);
    change(copy, copy.connectors[0]);
    return copy;
  };
  assert.throws(
    () =>
      parseExtensionManifest(
        variant((m) => (m.entry = { command: "node", args: [] })),
      ),
    /belongs to an extension without entry/,
  );
  assert.throws(
    () => parseExtensionManifest(variant((_, c) => delete c.cli)),
    /declares cli or serverHeld/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(
        variant((_, c) => (c.cli.signIn.invite.args = ["join", "{nope}"])),
      ),
    /\{nope\} is not something it can name here/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(
        variant((_, c) => (c.cli.signIn.other = { args: [] })),
      ),
    /names no guided sign-in method/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(variant((_, c) => (c.cli.status.signedIn = []))),
    /1 to 8 conditions/,
  );
  assert.throws(
    () => parseExtensionManifest(variant((_, c) => (c.cli.status.ok = "data"))),
    /JSON pointer/,
  );
  assert.throws(
    () => parseExtensionManifest(variant((_, c) => delete c.provides)),
    /needs provides\.modelAccess/,
  );
  const parsed = parseExtensionManifest(manifest);
  assert.equal(parsed.entry, undefined);
  assert.ok(parsed.cli.gateway.status);
  assert.equal(parsed.connectors[0].cli, undefined);
});

test("templates fill names, item pointers and the home folder, without a shell", () => {
  assert.equal(render("{a}-{/b/0}", { a: "x" }, { b: ["y"] }), "x-y");
  assert.equal(render("~/f", {}), join(process.env.HOME, "f"));
  assert.equal(render("{home}/f", {}), `${process.env.HOME}/f`);
  assert.equal(render("$(rm -rf /) {a}", { a: "; ls" }), "$(rm -rf /) ; ls");
  assert.equal(at({ "a/b": { "c~d": 1 } }, "/a~1b/c~0d"), 1);
  mkdirSync(join(bin, "unused"), { recursive: true });
});
