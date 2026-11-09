import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("./bundler-resolve.mjs", import.meta.url);

await import("../src/i18n/index.ts");
const {
  bundleDeviceStatus,
  bundleForCommand,
  bundleUpdateTargets,
  rolloutMoving,
  checkText,
  connectorDeviceLine,
  rolloutSummary,
} = await import("../src/lib/bundle-versions.ts");
const { SkillBundleRow } =
  await import("../src/features/skill-library/skill-bundle-row.tsx");
const { toolInstallRows } =
  await import("../src/features/skill-library/bundle-tool-status.tsx");

const passed = {
  state: "passed",
  deviceId: "sg",
  deviceName: "sg-chaos",
  at: "2026-11-09T06:02:00Z",
  steps: [
    {
      name: "feishu-cli --version",
      state: "passed",
      kind: "version",
      value: "v1.44.0",
    },
    {
      name: "feishu-cli auth status -o json",
      state: "passed",
      kind: "status",
      service: "Feishu",
    },
    {
      name: "feishu-cli api GET /open-apis/authen/v1/user_info --as user",
      state: "skipped",
      kind: "read",
      service: "Feishu",
      detail: "the device owner has no Feishu account",
    },
  ],
};
const failedCheck = {
  ...passed,
  state: "failed",
  steps: [
    {
      name: "feishu-cli --version",
      state: "passed",
      kind: "version",
      value: "v1.44.0",
    },
    {
      name: "feishu-cli auth refresh -o json",
      state: "failed",
      kind: "refresh",
      service: "Feishu",
      detail: "exit 1: token expired",
    },
  ],
};
const doneRollout = {
  id: "ro_1",
  seq: 3,
  tag: "v1.44.0",
  trigger: "auto",
  state: "done",
  canaryDeviceId: "sg",
  startedAt: "2026-11-09T06:00:00Z",
  finishedAt: "2026-11-09T06:02:00Z",
  devices: [
    { deviceId: "sg", deviceName: "sg-chaos", state: "updated", check: passed },
    { deviceId: "mac", deviceName: "mac-laptop", state: "updated" },
    { deviceId: "mini", deviceName: "mini", state: "updated" },
  ],
};
const version = (deviceId, state, extra = {}) => ({
  deviceId,
  tools: { "feishu-cli": state === "current" ? "v1.44.0" : "v1.41.0" },
  state,
  ...extra,
});

test("a device's state: consistent, unchecked, behind, waiting, mismatch", () => {
  const idle = { rollout: doneRollout };
  assert.equal(
    bundleDeviceStatus(
      version("sg", "current", { seq: 3, tag: "v1.44.0", verified: true }),
      idle,
    ),
    "consistent",
  );
  assert.equal(
    bundleDeviceStatus(version("sg", "current", { seq: 3 }), idle),
    "unchecked",
  );
  assert.equal(
    bundleDeviceStatus(version("mac", "behind", { seq: 2 }), idle),
    "update-available",
  );
  assert.equal(bundleDeviceStatus(version("mac", "unknown"), idle), "mismatch");
  const running = {
    rollout: {
      ...doneRollout,
      state: "rolling",
      finishedAt: undefined,
      devices: [
        doneRollout.devices[0],
        { deviceId: "mac", state: "offline" },
        { deviceId: "mini", state: "failed", error: "disk full" },
      ],
    },
  };
  assert.equal(
    bundleDeviceStatus(version("mac", "behind", { seq: 2 }), running),
    "waiting",
  );
  assert.equal(
    bundleDeviceStatus(version("mini", "behind", { seq: 2 }), running),
    "update-available",
    "a device the rollout failed on is not waiting for it",
  );
});

test("Update targets lagging devices only while nothing moves them", () => {
  const deviceVersions = [
    version("sg", "current", { verified: true }),
    version("mac", "behind"),
    version("mini", "unknown"),
  ];
  assert.deepEqual(
    bundleUpdateTargets({ deviceVersions }).map((entry) => entry.deviceId),
    ["mac", "mini"],
  );
  assert.deepEqual(bundleUpdateTargets({ deviceVersions, paused: true }), []);
  assert.deepEqual(
    bundleUpdateTargets({
      deviceVersions,
      rollout: { ...doneRollout, state: "canary" },
    }),
    [],
  );
  // A rollout that only waits for an offline device is idle: Update moves
  // the others, and the offline one continues when it reconnects.
  const idle = {
    ...doneRollout,
    state: "rolling",
    devices: [
      { deviceId: "sg", state: "updated" },
      { deviceId: "mini", state: "offline" },
    ],
  };
  assert.equal(rolloutMoving(idle), false);
  assert.deepEqual(
    bundleUpdateTargets({ deviceVersions, rollout: idle }).map(
      (entry) => entry.deviceId,
    ),
    ["mac"],
  );
  const busy = {
    ...idle,
    devices: [...idle.devices, { deviceId: "mac", state: "installing" }],
  };
  assert.equal(rolloutMoving(busy), true);
  assert.deepEqual(bundleUpdateTargets({ deviceVersions, rollout: busy }), []);
  assert.equal(rolloutMoving({ ...idle, state: "waiting" }), false);
  // A rollout waiting for any of its devices to come online offers nothing.
  assert.deepEqual(
    bundleUpdateTargets({
      deviceVersions,
      rollout: {
        ...doneRollout,
        state: "waiting",
        devices: [
          { deviceId: "mac", state: "pending" },
          { deviceId: "mini", state: "pending" },
        ],
      },
    }),
    [],
  );
});

test("a rollout in one line", () => {
  assert.match(
    rolloutSummary(doneRollout),
    /^v1\.44\.0 rolled out to 3 devices · canary sg-chaos passed · .*2026/,
  );
  assert.match(
    rolloutSummary({
      ...doneRollout,
      devices: [
        ...doneRollout.devices.slice(0, 2),
        { deviceId: "mini", state: "failed", error: "disk full" },
      ],
    }),
    /^v1\.44\.0 rolled out to 2 of 3 devices · 1 failed · canary sg-chaos passed/,
  );
  assert.match(
    rolloutSummary(
      {
        ...doneRollout,
        state: "rolled_back",
        devices: [
          { deviceId: "sg", state: "rolled_back", check: failedCheck },
          { deviceId: "mac", state: "rolled_back" },
        ],
      },
      (id) => (id === "sg" ? "sg-chaos" : undefined),
    ),
    /^v1\.44\.0 rolled back · canary sg-chaos: Token refresh failed · /,
  );
  assert.equal(
    rolloutSummary({
      ...doneRollout,
      state: "canary",
      finishedAt: undefined,
    }),
    "Updating to v1.44.0 · checking on canary sg-chaos",
  );
  assert.equal(
    rolloutSummary({
      ...doneRollout,
      state: "rolling",
      devices: [doneRollout.devices[0], { deviceId: "mac", state: "pending" }],
    }),
    "Updating to v1.44.0 · 1 of 2 devices updated",
  );
  assert.equal(checkText(undefined), "not checked");
  assert.equal(checkText(passed), "check passed on sg-chaos");
});

test("a connector finds its CLI's bundle and words each device", () => {
  const repo = {
    id: "r",
    mode: "bundle",
    tools: [{ name: "feishu-cli", version: "v1.44.0", assets: [] }],
  };
  assert.equal(
    bundleForCommand(
      [{ id: "p", mode: "pick", tools: repo.tools }, repo],
      "feishu-cli",
    ),
    repo,
  );
  assert.equal(bundleForCommand([repo], "aws"), undefined);
  assert.equal(
    connectorDeviceLine(
      version("sg", "current", { seq: 3, tag: "v1.44.0", verified: true }),
      "feishu-cli",
      "sg-chaos",
      {},
    ),
    "feishu-cli v1.44.0 on sg-chaos · skills v1.44.0 · Consistent, checked",
  );
  assert.equal(
    connectorDeviceLine(version("sg", "unknown"), "feishu-cli", "sg-chaos", {}),
    "feishu-cli v1.41.0 on sg-chaos · latest skills · Not in any recorded version",
  );
});

const devices = [
  {
    id: "sg",
    label: "sg-chaos",
    status: "connected",
    lastSeenLabel: "",
    owned: true,
  },
  {
    id: "mac",
    label: "mac-laptop",
    status: "connected",
    lastSeenLabel: "",
    owned: true,
  },
  {
    id: "mini",
    label: "mini",
    status: "disconnected",
    lastSeenLabel: "",
    owned: true,
  },
];
const bundle = {
  id: "repo_1",
  url: "https://github.com/riba2534/feishu-cli",
  label: "github.com/riba2534/feishu-cli",
  createdAt: "",
  mode: "bundle",
  name: "feishu-cli",
  version: "v1.44.0",
  skills: [],
  tools: [{ name: "feishu-cli", version: "v1.44.0", assets: [] }],
  versions: [
    {
      seq: 3,
      tag: "v1.44.0",
      commit: "c3",
      appliedAt: "2026-11-09T06:00:00Z",
      check: passed,
    },
    { seq: 2, tag: "v1.41.0", commit: "c2", appliedAt: "2026-10-01T06:00:00Z" },
  ],
  deviceVersions: [
    version("sg", "current", { seq: 3, tag: "v1.44.0", verified: true }),
    version("mac", "behind", { seq: 2, tag: "v1.41.0" }),
  ],
};
const render = (repo, canManage = true) =>
  renderToStaticMarkup(
    createElement(SkillBundleRow, {
      repo,
      canManage,
      busy: false,
      checkedLabel: "",
      devices,
      deviceTools: [],
      isDefault: false,
      onToggleDefault: () => {},
      refresh: async () => {},
      run: () => {},
    }),
  );
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("manual mode offers Update for lagging devices; members only see it", () => {
  const html = render({ ...bundle, updatePolicy: "manual" });
  assert.match(html, /role="radio"[^>]*aria-checked="true"[^>]*>Manual</);
  assert.match(
    text(html),
    /Update when you choose; it tries one device first too/,
  );
  assert.match(text(html), /feishu-cli v1\.44\.0 Update available from/);
  assert.match(text(html), /1 device is not on v1\.44\.0 Update /);
  assert.match(
    text(html),
    /Version history · Updated to v1\.44\.0 v1\.44\.0 .* check passed on sg-chaos v1\.41\.0 .* not checked/,
  );
  const member = text(render({ ...bundle, updatePolicy: "manual" }, false));
  assert.match(
    member,
    /Updates Manual Default for my workspaces Update when you choose/,
  );
  assert.match(member, /1 device is not on v1\.44\.0/);
  assert.doesNotMatch(member, /Automatic|not on v1\.44\.0 Update/);
});

test("a just-finished rollout is a line with progress, devices and the canary's checks collapsed", () => {
  const recent = { ...doneRollout, finishedAt: new Date().toISOString() };
  const html = render({ ...bundle, rollout: recent });
  assert.match(text(html), /Updated to v1\.44\.0 · 3 of 3 devices/);
  assert.doesNotMatch(html, /<progress/, "a finished rollout needs no bar");
  assert.match(text(html), /sg-chaos Canary Updated/);
  // The checks are one line until opened; each is one line, never output.
  assert.match(html, /<details[^>]*><summary[^>]*>2 checks passed<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.match(
    text(html),
    /Version v1\.44\.0 .*Signed in · token valid .*Read through Feishu skipped · the device owner has no Feishu account/,
  );
  assert.doesNotMatch(html, /auth status -o json|user_info --as user/);
  // A rollout that finished days ago is only in the version history.
  const old = text(
    render({
      ...bundle,
      rollout: { ...doneRollout, finishedAt: "2026-10-01T06:02:00Z" },
    }),
  );
  assert.doesNotMatch(old, /3 of 3 devices/);
});

test("a running rollout shows each device; a rolled-back one says following is paused", () => {
  const runningHtml = render({
    ...bundle,
    rollout: {
      ...doneRollout,
      state: "rolling",
      finishedAt: undefined,
      devices: [
        doneRollout.devices[0],
        { deviceId: "mac", state: "installing", from: "feishu-cli v1.41.0" },
        {
          deviceId: "mini",
          state: "offline",
          from: "feishu-cli v1.41.0",
        },
      ],
    },
  });
  const running = text(runningHtml);
  assert.match(
    runningHtml,
    /<progress[^>]*aria-label="1 of 3 devices that follow it are on v1\.44\.0"[^>]*max="3" value="1"/,
  );
  assert.match(running, /feishu-cli v1\.44\.0 Updating 1 of 3 from/);
  assert.match(
    running,
    /Updating to v1\.44\.0 · 1 of 3 devices that follow it started/,
  );
  assert.match(running, /mac-laptop Installing v1\.41\.0 → v1\.44\.0/);
  // A device that is not the viewer's says whose it is.
  assert.match(
    text(
      render({
        ...bundle,
        rollout: {
          ...doneRollout,
          state: "rolling",
          finishedAt: undefined,
          devices: [
            {
              deviceId: "vm2",
              deviceName: "VM-4-8-debian …2146",
              owner: "e2e-alice",
              state: "offline",
              from: "feishu-cli v1.41.0",
            },
          ],
        },
      }),
    ),
    /VM-4-8-debian …2146 · e2e-alice(?:'|&#x27;)s Offline, continues when it reconnects on v1\.41\.0/,
  );
  // A device that has not moved yet says where it is, not an arrow.
  assert.match(
    running,
    /mini Offline, continues when it reconnects on v1\.41\.0/,
  );
  assert.doesNotMatch(
    running,
    /devices? (is|are) not on/,
    "nothing to start while it runs",
  );
  const html = render({
    ...bundle,
    paused: true,
    rollout: {
      ...doneRollout,
      state: "rolled_back",
      devices: [{ deviceId: "sg", state: "rolled_back", check: failedCheck }],
    },
  });
  const rolledBack = text(html);
  assert.match(rolledBack, /feishu-cli v1\.44\.0 Paused from/);
  assert.match(
    rolledBack,
    /v1\.44\.0 rolled back · the check on sg-chaos failed: Token refresh failed/,
  );
  assert.match(
    rolledBack,
    /Updates are paused and every device stays on its version/,
  );
  assert.match(rolledBack, /Resume updates/);
  // The failed check's (redacted) output waits behind Details, in mono.
  assert.match(
    html,
    /<summary[^>]*>Details<\/summary><pre[^>]*font-mono[^>]*>exit 1: token expired<\/pre>/,
  );
});

test("a repository whose check failed says why in one line, with the output behind Details", () => {
  const html = renderToStaticMarkup(
    createElement(SkillBundleRow, {
      repo: { ...bundle, rollout: undefined },
      canManage: true,
      busy: false,
      checkError:
        "CanWendeMac-mini could not reach @bytedance-dev/bytedcli: npm error code ENOTFOUND\nnpm error network request to https://bnpm.byted.org/@bytedance-dev%2fbytedcli failed, reason: getaddrinfo ENOTFOUND bnpm.byted.org",
      checkedLabel: "",
      devices,
      deviceTools: [],
      isDefault: false,
      onToggleDefault: () => {},
      refresh: async () => {},
      run: () => {},
    }),
  );
  assert.match(text(html), /feishu-cli v1\.44\.0 Check failed from/);
  assert.match(
    text(html).replace(/&#x27;/g, "'"),
    /Couldn't check for updates: CanWendeMac-mini can't resolve bnpm\.byted\.org Check again/,
  );
  assert.match(
    html,
    /<summary[^>]*>Details<\/summary><pre[^>]*>CanWendeMac-mini could not reach/,
  );
});

test("the install dialog's rows carry each device's bundle version", () => {
  const rows = toolInstallRows(
    bundle.tools[0],
    devices,
    [
      {
        deviceId: "sg",
        tool: "feishu-cli",
        available: true,
        checkedAt: "",
        version: "v1.44.0",
      },
      {
        deviceId: "mac",
        tool: "feishu-cli",
        available: true,
        checkedAt: "",
        version: "v1.41.0",
      },
    ],
    {
      ...bundle,
      deviceVersions: [...bundle.deviceVersions, version("mini", "unknown")],
    },
  );
  assert.deepEqual(
    rows.map((row) => [row.device.id, row.state, row.version, row.status]),
    [
      ["sg", "current", "v1.44.0", "consistent"],
      ["mac", "older", "v1.41.0", "update-available"],
      ["mini", "offline", "v1.41.0", "mismatch"],
    ],
  );
});
