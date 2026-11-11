import "./fixtures/native-test-homes.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOUNDRY_TOOLS_ROOT = mkdtempSync(
  join(tmpdir(), "repo-tools-root-"),
);
process.env.HOME = mkdtempSync(join(tmpdir(), "repo-tools-home-"));
const {
  activateRepositoryTool,
  installRepositoryTool,
  packRepositoryTool,
  uninstallRepositoryTool,
} = await import("../dist/skills/repository-tool.js");
const { managedToolsBin } = await import("../dist/skills/managed-tools.js");
const { checkTool } = await import("../dist/skills/tool-check.js");

const firstCommit = "a".repeat(40);
const secondCommit = "b".repeat(40);
const log = join(process.env.FOUNDRY_TOOLS_ROOT, "gh.log");
mkdirSync(join(process.env.FOUNDRY_TOOLS_ROOT, "bin"), { recursive: true });
writeFileSync(
  join(managedToolsBin(), "gh"),
  [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${log}'`,
    'if [ "$GH_FAIL" = auth ]; then',
    "  echo 'To get started with GitHub CLI, please run: gh auth login' >&2",
    "  exit 1",
    "fi",
    'if [ "$GH_FAIL" = access ]; then',
    "  echo 'HTTP 403: Resource not accessible by integration' >&2",
    "  exit 1",
    "fi",
    'cat "$GH_ARCHIVE"',
    "",
  ].join("\n"),
  { mode: 0o755 },
);

function fixture(commit) {
  const work = mkdtempSync(join(tmpdir(), "open-lark-fixture-"));
  const root = `nwverse-open-lark-${commit.slice(0, 7)}`;
  const plugin = join(work, root, "plugins/open-lark");
  mkdirSync(join(plugin, "bin"), { recursive: true });
  mkdirSync(join(plugin, "server"), { recursive: true });
  writeFileSync(
    join(plugin, "server/olk.mjs"),
    `console.log("olk ${commit.slice(0, 1)} " + process.argv.slice(2).join(" "));\n`,
    { mode: 0o644 },
  );
  writeFileSync(
    join(plugin, "bin/olk"),
    '#!/bin/sh\nhere=$(dirname "$(readlink -f "$0")")\nexec node "$here/../server/olk.mjs" "$@"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(plugin, "bin/olk-ctx"),
    '#!/bin/sh\nhere=$(dirname "$(readlink -f "$0")")\nexec node "$here/../server/olk.mjs" ctx "$@"\n',
    { mode: 0o755 },
  );
  const archive = join(work, "repository.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", work, root]);
  return archive;
}

const spec = (commit) => ({
  name: "olk",
  version: commit,
  source: "repository",
  repository: "https://github.com/nwverse/open-lark",
  path: "plugins/open-lark",
  bins: { olk: "bin/olk", "olk-ctx": "bin/olk-ctx" },
});

test("a repository tool installs one upstream folder, links every bin, and updates atomically", async () => {
  process.env.GH_ARCHIVE = fixture(firstCommit);
  delete process.env.GH_FAIL;
  await installRepositoryTool(spec(firstCommit));
  assert.equal(
    execFileSync(join(managedToolsBin(), "olk"), ["auth", "status"]).toString(),
    "olk a auth status\n",
  );
  assert.equal(
    execFileSync(join(managedToolsBin(), "olk-ctx"), ["today"]).toString(),
    "olk a ctx today\n",
  );
  assert.equal(
    readlinkSync(join(managedToolsBin(), "olk")),
    `../olk/${firstCommit}/olk`,
  );
  assert.equal(
    readlinkSync(join(managedToolsBin(), "olk-ctx")),
    `../olk/${firstCommit}/olk-ctx`,
  );

  process.env.GH_ARCHIVE = fixture(secondCommit);
  await installRepositoryTool(spec(secondCommit));
  assert.equal(
    execFileSync(join(managedToolsBin(), "olk"), ["version"]).toString(),
    "olk b version\n",
  );
  assert.ok(
    existsSync(join(process.env.FOUNDRY_TOOLS_ROOT, "olk", firstCommit)),
    "the old version stays for pinned sessions",
  );
  activateRepositoryTool(spec(firstCommit));
  assert.equal(
    execFileSync(join(managedToolsBin(), "olk"), ["version"]).toString(),
    "olk a version\n",
    "a bundle rollback can activate the retained version",
  );
  activateRepositoryTool(spec(secondCommit));
  assert.match(
    readFileSync(log, "utf8"),
    new RegExp(
      `repos/nwverse/open-lark/tarball/${firstCommit}\\n.*tarball/${secondCommit}`,
      "s",
    ),
  );
});

test("a .mjs bin gets a launcher that uses the Worker's node", async () => {
  process.env.GH_ARCHIVE = fixture(firstCommit);
  delete process.env.GH_FAIL;
  await installRepositoryTool({
    name: "olk-node",
    version: firstCommit,
    source: "repository",
    repository: "https://github.com/nwverse/open-lark",
    path: "plugins/open-lark",
    bins: { "olk-node": "server/olk.mjs" },
  });
  const output = execFileSync(join(managedToolsBin(), "olk-node"), [
    "--flag",
  ]).toString();
  assert.equal(output, "olk a --flag\n");
  const launcher = readFileSync(
    join(process.env.FOUNDRY_TOOLS_ROOT, "olk-node", firstCommit, "olk-node"),
    "utf8",
  );
  assert.match(launcher, /exec "\$node"/);
});

test("a repository tool's rollout check proves the staged commit by running its entry", async () => {
  const commit = "f".repeat(40);
  process.env.GH_ARCHIVE = fixture(commit);
  delete process.env.GH_FAIL;
  await installRepositoryTool(spec(commit), { activate: false });
  const checked = await checkTool({
    tool: {
      name: "olk",
      version: commit,
      source: "repository",
      repository: "https://github.com/nwverse/open-lark",
      path: "plugins/open-lark",
      bins: { olk: "bin/olk", "olk-ctx": "bin/olk-ctx" },
    },
    commands: [],
  });
  assert.equal(checked.error, undefined);
  assert.equal(checked.steps[0].state, "passed");
  assert.equal(checked.steps[0].value, commit);
});

test("paths, bins and source are checked before any GitHub request", async () => {
  const before = readFileSync(log, "utf8");
  await assert.rejects(
    installRepositoryTool({ ...spec(firstCommit), path: "../outside" }),
    /must stay inside the repository/,
  );
  await assert.rejects(
    installRepositoryTool({
      ...spec(firstCommit),
      bins: { olk: "bin/olk", "olk-ctx": "../../etc/passwd" },
    }),
    /must stay inside the repository/,
  );
  await assert.rejects(
    installRepositoryTool({ ...spec(firstCommit), source: "npm" }),
    /invalid repository tool/,
  );
  assert.equal(readFileSync(log, "utf8"), before);
});

test("GitHub CLI sign-in and repository permission errors are readable", async () => {
  process.env.GH_FAIL = "auth";
  await assert.rejects(
    installRepositoryTool(spec("c".repeat(40))),
    /GitHub CLI is not signed in on this device/,
  );
  process.env.GH_FAIL = "access";
  await assert.rejects(
    installRepositoryTool(spec("d".repeat(40))),
    /GitHub CLI cannot read nwverse\/open-lark/,
  );
  delete process.env.GH_FAIL;
});

test("uninstalling removes current bin links and the version folder", async () => {
  process.env.GH_ARCHIVE = fixture("e".repeat(40));
  await installRepositoryTool(spec("e".repeat(40)));
  activateRepositoryTool(spec("e".repeat(40)));
  uninstallRepositoryTool(spec("e".repeat(40)));
  assert.equal(existsSync(join(managedToolsBin(), "olk")), false);
  assert.equal(existsSync(join(managedToolsBin(), "olk-ctx")), false);
  assert.equal(
    existsSync(join(process.env.FOUNDRY_TOOLS_ROOT, "olk", "e".repeat(40))),
    false,
  );
});

test("a device that cannot read the repository installs the folder another device packed", async () => {
  const commit = "c".repeat(40);
  process.env.GH_ARCHIVE = fixture(commit);
  delete process.env.GH_FAIL;
  const { archive, sha256 } = await packRepositoryTool(spec(commit));
  assert.match(sha256, /^[0-9a-f]{64}$/);
  const listing = execFileSync("tar", ["-tzf", "-"], {
    input: archive,
  }).toString();
  assert.match(listing, /plugins\/open-lark\/bin\/olk/);

  writeFileSync(log, "");
  process.env.GH_FAIL = "auth";
  await installRepositoryTool(spec(commit), { archive });
  assert.equal(
    readFileSync(log, "utf8"),
    "",
    "gh is not run for a held archive",
  );
  assert.equal(
    execFileSync(join(managedToolsBin(), "olk"), ["x"]).toString(),
    "olk c x\n",
  );
  delete process.env.GH_FAIL;
});
