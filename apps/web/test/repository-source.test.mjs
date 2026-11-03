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

const device = (id, label, status, owned = true) => ({
  id,
  label,
  status,
  lastSeenLabel: "",
  owned,
});

test("Read with offers the server and the person's devices, saying why one cannot read", () => {
  const options = readerOptions([
    device("dev_byte", "linux-dev", "connected"),
    device("dev_mac", "mac-laptop", "disconnected"),
    device("dev_other", "someone", "connected", false),
  ]);
  assert.deepEqual(
    options.map((option) => [option.label, Boolean(option.disabled)]),
    [
      ["Foundry server", false],
      ["linux-dev", false],
      ["mac-laptop", true],
    ],
  );
  assert.match(options[2].detail, /Offline/);
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
  fetchDeviceName: "linux-dev",
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
    "read by linux-dev",
  );
  assert.match(row({ ...repo, fetchDeviceOnline: true }), /read by linux-dev/);
  assert.doesNotMatch(row({ ...repo, fetchDeviceOnline: true }), /Waiting for/);

  const waiting = { ...repo, fetchDeviceOnline: false, checkWaiting: true };
  assert.equal(
    waitingLabel(waiting),
    "Waiting for linux-dev to come online to check for updates",
  );
  const markup = row(waiting);
  assert.match(markup, /read by linux-dev \(offline\)/);
  assert.match(markup, /data-tone="warning"[^>]*>Waiting for linux-dev/);

  assert.equal(readByLabel({ ...repo, fetchDeviceId: undefined }), "");
  assert.equal(usesNpmRegistry({ url: "npm:@corp-dev/corpcli" }), true);
  assert.equal(usesNpmRegistry({ url: repo.url }), false);
});
