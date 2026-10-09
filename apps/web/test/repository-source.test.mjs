import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("./bundler-resolve.mjs", import.meta.url);

await import("../src/i18n/index.ts");
const { readerOptions, readByLabel, waitingLabel, usesNpmRegistry } =
  await import("../src/features/skill-library/repository-source.tsx");
const { SkillPickRow } =
  await import("../src/features/skill-library/skill-pick-row.tsx");
const { toolInstallRows } =
  await import("../src/features/skill-library/bundle-tool-status.tsx");

const device = (id, label, status, capabilities, owned = true) => ({
  id,
  label,
  status,
  lastSeenLabel: "",
  owned,
  capabilities,
});

test("Read with offers the server and the person's devices, saying why one cannot read", () => {
  const options = readerOptions([
    device("dev_byte", "byte-dev", "connected", ["skill_repository_fetch"]),
    device("dev_mac", "macbook", "disconnected", ["skill_repository_fetch"]),
    device("dev_old", "old-box", "connected", []),
    device(
      "dev_other",
      "someone",
      "connected",
      ["skill_repository_fetch"],
      false,
    ),
  ]);
  assert.deepEqual(
    options.map((option) => [option.label, Boolean(option.disabled)]),
    [
      ["Foundry server", false],
      ["byte-dev", false],
      ["macbook", true],
      ["old-box", true],
    ],
  );
  assert.match(options[2].detail, /Offline/);
  assert.match(options[3].detail, /too old/);
  // A repository read by someone else's device keeps showing that device.
  const kept = readerOptions([], { id: "dev_other", name: "someone" });
  assert.deepEqual(
    kept.map((option) => [option.label, Boolean(option.disabled)]),
    [
      ["Foundry server", false],
      ["someone", true],
    ],
  );
});

const repo = {
  id: "repo_1",
  url: "https://code.internal.example/team/skills",
  label: "code.internal.example/team/skills",
  createdAt: "",
  mode: "pick",
  skills: [{ skillId: "a", dir: "skills/a", commit: "c", name: "a" }],
  version: "v1.0.0",
  fetchDeviceId: "dev_byte",
  fetchDeviceName: "byte-dev",
};
const row = (item) =>
  renderToStaticMarkup(
    createElement(SkillPickRow, {
      repo: item,
      canManage: true,
      busy: false,
      anyBusy: false,
      checkedLabel: "",
      devices: [],
      onAdd: () => {},
      refresh: async () => {},
      run: () => {},
    }),
  );

test("a repository read by a device names it, and says when its check waits for it", () => {
  assert.equal(
    readByLabel({ ...repo, fetchDeviceOnline: true }),
    "read by byte-dev",
  );
  assert.match(row({ ...repo, fetchDeviceOnline: true }), /read by byte-dev/);
  assert.doesNotMatch(row({ ...repo, fetchDeviceOnline: true }), /Waiting for/);

  const waiting = { ...repo, fetchDeviceOnline: false, checkWaiting: true };
  assert.equal(
    waitingLabel(waiting),
    "Waiting for byte-dev to come online to check for updates",
  );
  const markup = row(waiting);
  assert.match(markup, /read by byte-dev \(offline\)/);
  assert.match(markup, /data-tone="warning"[^>]*>Waiting for byte-dev/);

  assert.equal(readByLabel({ ...repo, fetchDeviceId: undefined }), "");
  assert.equal(usesNpmRegistry({ url: "npm:@bytedance-dev/bytedcli" }), true);
  assert.equal(usesNpmRegistry({ url: repo.url }), false);
});

test("an npm tool from a named registry needs a worker that honors it", () => {
  const tool = {
    name: "bytedcli",
    version: "1.2.0",
    source: "npm",
    package: "@bytedance-dev/bytedcli",
    registry: "https://bnpm.byted.org",
    signIn: ["auth", "login"],
  };
  const devices = [
    device("dev_new", "byte-dev", "connected", [
      "tool_install",
      "tool_sources",
      "tool_registry",
    ]),
    device("dev_old", "older", "connected", ["tool_install", "tool_sources"]),
  ];
  assert.deepEqual(
    toolInstallRows(tool, devices, []).map((row) => row.state),
    ["missing", "unsupported"],
  );
});
