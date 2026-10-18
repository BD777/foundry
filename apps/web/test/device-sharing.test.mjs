import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const {
  accountSharers,
  firstAcceptedShare,
  joinNames,
  pendingAccountShareNotices,
  preferUnsharedDevice,
  sharesSystemAccount,
} = await import("../src/lib/device-sharing.ts");
const { i18n } = await import("../src/i18n/index.ts");

const share = (ownerName, extra = {}) => ({
  deviceId: `dev_${ownerName}`,
  deviceLabel: `${ownerName}'s Mac`,
  ownerName,
  ...extra,
});

test("the people sharing a device's system account are named once each", () => {
  const device = {
    sharesSystemAccountWith: [share("Ann"), share("Bo"), share("Ann")],
  };
  assert.deepEqual(accountSharers(device), ["Ann", "Bo"]);
  assert.equal(sharesSystemAccount(device), true);
  assert.equal(sharesSystemAccount({}), false);
  assert.equal(sharesSystemAccount({ sharesSystemAccountWith: [] }), false);
  assert.equal(sharesSystemAccount(undefined), false);
});

test("names join in the reader's language", () => {
  assert.equal(joinNames(["Ann"], "en"), "Ann");
  assert.equal(joinNames(["Ann", "Bo"], "en"), "Ann and Bo");
  assert.equal(joinNames(["Ann", "Bo", "Cy"], "en"), "Ann, Bo, and Cy");
  assert.equal(joinNames(["安", "博"], "zh-CN"), "安和博");
});

test("sharing dates from the earliest choice; none when Foundry only noticed it", () => {
  const device = {
    sharesSystemAccountWith: [
      share("Ann", { acceptedAt: "2026-10-12T00:00:00Z", acceptedBy: "Bo" }),
      share("Cy", { acceptedAt: "2026-10-10T00:00:00Z", acceptedBy: "Cy" }),
      share("Di"),
    ],
  };
  assert.equal(firstAcceptedShare(device).ownerName, "Cy");
  assert.equal(
    firstAcceptedShare({ sharesSystemAccountWith: [share("Di")] }),
    undefined,
  );
});

test("one notice per device whose owner has not read that someone joined", () => {
  const mine = {
    id: "dev_mine",
    label: "Mac",
    sharesSystemAccountWith: [
      share("Ann", { noticePending: true }),
      share("Bo"),
    ],
  };
  const read = {
    id: "dev_read",
    label: "Box",
    sharesSystemAccountWith: [share("Cy")],
  };
  const alone = { id: "dev_alone", label: "Pi" };
  assert.deepEqual(pendingAccountShareNotices([mine, read, alone]), [
    { device: mine, names: ["Ann"] },
  ]);
});

test("a new assistant never defaults to a computer someone else shares", () => {
  const shared = {
    id: "shared",
    status: "connected",
    sharesSystemAccountWith: [share("Ann")],
  };
  const own = { id: "own", status: "connected" };
  const ownOffline = { id: "own-off", status: "disconnected" };
  assert.equal(preferUnsharedDevice([shared, own]).id, "own");
  assert.equal(preferUnsharedDevice([ownOffline, shared]).id, "own-off");
  assert.equal(
    preferUnsharedDevice([{ ...shared, status: "disconnected" }, ownOffline])
      .id,
    "own-off",
  );
  assert.equal(preferUnsharedDevice([shared]), undefined);
  assert.equal(preferUnsharedDevice([]), undefined);
});

test("the pairing choice says plainly that the account is shared", async () => {
  await i18n.changeLanguage("en");
  assert.equal(
    i18n.t("devices:add.consent.body", { names: "Ann", count: 1 }),
    "This computer account is already used by Ann in Foundry. If you continue, you share it: you'll both work with the same files and the same Claude/Codex sign-ins on this account; nothing here keeps your work apart. To have your own separate space, create a separate system account on this computer.",
  );
  assert.match(
    i18n.t("devices:add.consent.body", { names: "Ann and Bo", count: 2 }),
    /you'll all work/,
  );
  assert.equal(
    i18n.t("devices:accountShare.label", { names: "Ann" }),
    "Shares a system account with Ann",
  );
  assert.match(
    i18n.t("devices:accountShare.notice", {
      names: "Ann and Bo",
      count: 2,
      device: "Mac",
    }),
    /^Ann and Bo now also use the system account of Mac/,
  );
  for (const language of ["en", "zh-CN"]) {
    await i18n.changeLanguage(language);
    for (const key of [
      "devices:accountShare.label",
      "devices:accountShare.body",
      "devices:accountShare.noticed",
      "devices:accountShare.notice",
      "sharing:runsCode.body",
    ])
      assert.doesNotMatch(
        i18n.t(key, { names: "Ann", count: 1 }),
        /isolat|separate space|inside this workspace|隔离|工作区内/i,
        `${language} ${key}`,
      );
  }
  await i18n.changeLanguage("en");
});
