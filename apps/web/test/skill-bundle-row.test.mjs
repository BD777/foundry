import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("./bundler-resolve.mjs", import.meta.url);

const { SkillBundleRow } =
  await import("../src/features/skill-library/skill-bundle-row.tsx");

const repo = {
  id: "repo_1",
  url: "https://github.com/riba2534/feishu-cli",
  label: "github.com/riba2534/feishu-cli",
  createdAt: "",
  mode: "bundle",
  name: "feishu-cli",
  version: "v1.41.0",
  description: "Feishu CLI and its agent skills",
  skills: [
    {
      skillId: "a",
      dir: "skills/feishu-cli-docs",
      commit: "c",
      name: "feishu-cli-docs",
    },
    {
      skillId: "b",
      dir: "skills/feishu-cli-mail",
      commit: "c",
      name: "feishu-cli-mail",
    },
    {
      skillId: "c",
      dir: "skills/feishu-cli-old",
      commit: "c",
      name: "feishu-cli-old",
      retired: true,
    },
  ],
  versions: [
    {
      seq: 2,
      tag: "v1.41.0",
      commit: "c2",
      appliedAt: "",
      changed: ["feishu-cli-docs", "feishu-cli-mail"],
      added: ["feishu-cli-mail"],
    },
    { seq: 1, tag: "v1.40.0", commit: "c1", appliedAt: "" },
  ],
  tools: [{ name: "feishu-cli", version: "v1.41.0", assets: [] }],
};
const devices = [
  {
    id: "mac",
    label: "mac-laptop",
    status: "connected",
    lastSeenLabel: "",
    owned: true,
  },
  {
    id: "dev",
    label: "linux-dev",
    status: "connected",
    lastSeenLabel: "",
    owned: true,
  },
  {
    id: "old",
    label: "mini",
    status: "connected",
    lastSeenLabel: "",
    owned: true,
  },
];
const deviceTools = [
  {
    deviceId: "mac",
    tool: "feishu-cli",
    available: true,
    checkedAt: "",
    version: "v1.41.0",
  },
  {
    deviceId: "old",
    tool: "feishu-cli",
    available: true,
    checkedAt: "",
    version: "v1.40.0",
  },
];

test("a bundle row shows its version, last update, skills and tool on each device", () => {
  const html = renderToStaticMarkup(
    createElement(SkillBundleRow, {
      repo,
      canManage: true,
      busy: false,
      checkedLabel: "",
      devices,
      deviceTools,
      isDefault: false,
      onToggleDefault: () => {},
      refresh: async () => {},
      run: () => {},
    }),
  );
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  // Header: name, version and one status; then where it comes from.
  assert.match(
    text,
    /feishu-cli v1\.41\.0 Up to date from github\.com\/riba2534\/feishu-cli/,
  );
  assert.match(text, /Feishu CLI and its agent skills/);
  assert.doesNotMatch(text, /Bundle|latest release/);
  // One row of facts: skills (names behind a toggle), installs, updates,
  // default for my workspaces as a switch.
  assert.match(
    text,
    /2 skills Installed on 1 of your 3 devices some have an older version Manage Updates Automatic Manual Default for my workspaces Tries one device first and rolls back if its check fails/,
  );
  assert.match(
    html,
    /aria-expanded="false"[^>]*aria-label="Show the skills of feishu-cli"|aria-label="Show the skills of feishu-cli"[^>]*aria-expanded="false"/,
  );
  assert.doesNotMatch(
    text,
    /feishu-cli-docs/,
    "skill names wait behind the toggle",
  );
  assert.match(html, /role="switch"[^>]*aria-checked="false"/);
  // What the latest version did is the version history's line.
  assert.match(
    text,
    /Version history · Updated to v1\.41\.0 · 2 changed · 1 added/,
  );
  assert.doesNotMatch(
    text,
    /linux-dev|mac-laptop/,
    "no per-device list on the card",
  );
  // Checking, rolling back and unfollowing sit behind one "…" menu.
  assert.match(html, /aria-label="Actions for feishu-cli"/);
  assert.doesNotMatch(text, /Roll back|Check now|Stop following/);
  assert.doesNotMatch(html, /fdy-button-primary/, "nothing to suggest");
});

test("a paused bundle suggests resuming", () => {
  const html = renderToStaticMarkup(
    createElement(SkillBundleRow, {
      repo: { ...repo, paused: true },
      canManage: true,
      busy: false,
      checkedLabel: "",
      devices,
      deviceTools,
      isDefault: false,
      onToggleDefault: () => {},
      refresh: async () => {},
      run: () => {},
    }),
  );
  assert.match(html, /fdy-button-primary[^>]*>Resume updates</);
});
