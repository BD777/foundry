import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { FakeChannels, FakeLocks, settle } from "./fake-tabs.mjs";

register("./bundler-resolve.mjs", import.meta.url);

const { parseBuildVersion, runningBuild } =
  await import("../src/lib/web-build.ts");
const {
  createDeployedBuildWatch,
  deployedBuildCheckMs,
  deployedBuildFreshMs,
  pageHoldsWork,
} = await import("../src/app/deployed-build.tsx");
const { joinTabs } = await import("../src/stream/tabs.ts");

/** A browser's tabs, each with its own watch; the test plays the clock and the deployment. */
function browser({ deployed = "b2" } = {}) {
  const locks = new FakeLocks();
  const channels = new FakeChannels();
  const clock = { now: 1_000_000 };
  const reads = [];
  const deployment = { build: deployed };
  function openTab(name, running = "b1") {
    const tabs = joinTabs({
      locks: locks.forTab(name),
      openChannel: (channel) => channels.open(channel, name),
    });
    const watch = createDeployedBuildWatch({
      running,
      tabs,
      now: () => clock.now,
      fetchDeployed: async () => {
        reads.push(name);
        return deployment.build;
      },
    });
    return { name, tabs, watch };
  }
  async function lead(tab) {
    tab.tabs.seekLeadership(() => tab.tabs.post({ kind: "leader" }));
    await settle();
  }
  return { clock, reads, deployment, openTab, lead };
}

test("version.json names the build; anything else names none", () => {
  assert.equal(parseBuildVersion('{"build":"abc"}\n'), "abc");
  assert.equal(parseBuildVersion("<!doctype html><html></html>"), undefined);
  assert.equal(parseBuildVersion('{"build":""}'), undefined);
  assert.equal(parseBuildVersion("null"), undefined);
});

test("the page's build comes from its meta tag; the dev server has none", () => {
  const { document } = new Window();
  assert.equal(runningBuild(document), undefined);
  document.head.innerHTML = '<meta name="foundry-build" content="abc123">';
  assert.equal(runningBuild(document), "abc123");
});

test("a newer build is told once a tab reads that another is deployed", async () => {
  const { clock, reads, deployment, openTab } = browser({ deployed: "b1" });
  const tab = openTab("a");
  let told = 0;
  tab.watch.subscribe(() => told++);

  // The page just loaded what was deployed: a reconnect reads nothing yet.
  assert.equal(tab.watch.streamOpened(), undefined);
  clock.now += deployedBuildFreshMs;
  await tab.watch.streamOpened();
  assert.deepEqual(reads, ["a"]);
  assert.equal(tab.watch.newer(), false);

  deployment.build = "b2";
  clock.now += deployedBuildFreshMs;
  await tab.watch.shown();
  assert.equal(tab.watch.newer(), true);
  assert.equal(told, 2);

  // Read again within the minute: nothing new is asked.
  assert.equal(tab.watch.shown(), undefined);
  assert.equal(reads.length, 2);
});

test("one tab reads for the browser; the others learn what it read", async () => {
  const { clock, reads, openTab, lead } = browser();
  const leader = openTab("leader");
  const follower = openTab("follower");
  const current = openTab("current", "b2");
  await lead(leader);
  assert.equal(follower.tabs.leaderElsewhere(), true);

  clock.now += deployedBuildCheckMs;
  // Every tab's stream opens again after the server restarted.
  await Promise.all(
    [leader, follower, current].map((tab) => tab.watch.streamOpened()),
  );
  await settle();
  assert.deepEqual(reads, ["leader"]);
  assert.equal(follower.watch.newer(), true);
  assert.equal(current.watch.newer(), false, "it runs the deployed build");

  // The periodic check: the leader reads, the followers heard it recently.
  clock.now += deployedBuildCheckMs;
  await Promise.all([follower.watch.tick(), leader.watch.tick()]);
  assert.deepEqual(reads, ["leader", "leader"]);
});

test("a follower reads itself when its leader (an older build) says nothing", async () => {
  const { clock, reads, openTab, lead } = browser();
  const oldLeader = openTab("old");
  oldLeader.watch.dispose();
  const follower = openTab("follower");
  await lead(oldLeader);

  clock.now += deployedBuildCheckMs;
  assert.equal(follower.watch.tick(), undefined);
  assert.equal(follower.watch.streamOpened(), undefined);
  clock.now += deployedBuildCheckMs;
  await follower.watch.tick();
  assert.deepEqual(reads, ["follower"]);
  assert.equal(follower.watch.newer(), true);
});

test("a page with typed text or an open dialog is not reloaded unattended", () => {
  const { document } = new Window();
  document.body.innerHTML =
    '<textarea></textarea><input type="text"><input type="checkbox" value="on"><div contenteditable="true"> </div>';
  assert.equal(pageHoldsWork(document), false);

  document.querySelector("textarea").value = "half a message";
  assert.equal(pageHoldsWork(document), true);
  document.querySelector("textarea").value = "";

  document.querySelector("input[type=text]").value = "x";
  assert.equal(pageHoldsWork(document), true);
  document.querySelector("input[type=text]").value = "";

  document.querySelector("[contenteditable]").textContent = "note";
  assert.equal(pageHoldsWork(document), true);
  document.querySelector("[contenteditable]").textContent = "";

  document.body.insertAdjacentHTML("beforeend", '<div role="dialog"></div>');
  assert.equal(pageHoldsWork(document), true);
});
