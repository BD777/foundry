import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { readBackgroundTaskOutput } from "../dist/agent-background-tasks.js";
import {
  discoverBrowsers,
  discoverComputerUse,
  reclaimSessionResources,
  sessionResourceNotes,
  sessionBrowserLaunchers,
  sessionScratchDirectory,
  sessionScratchEnvironment,
} from "../dist/resource-pool.js";
import * as resourcePool from "../dist/resource-pool.js";

test("browsers on PATH become one resource per browser", (t) => {
  const bin = mkdtempSync(join(tmpdir(), "foundry-browsers-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  for (const name of ["chromium", "chromium-browser"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\n");
    chmodSync(join(bin, name), 0o755);
  }
  const found = discoverBrowsers("linux", { PATH: bin }).filter((resource) =>
    resource.attributes.path.startsWith(bin),
  );
  assert.deepEqual(found, [
    {
      id: "browser:chromium",
      kind: "browser",
      name: "Chromium",
      available: true,
      attributes: { path: join(bin, "chromium") },
    },
  ]);
});

test("macOS screen control reflects the real grants, never the platform alone", () => {
  assert.deepEqual(discoverComputerUse("linux"), []);
  const [granted] = discoverComputerUse("darwin", () => ({
    screenRecording: true,
    accessibility: true,
  }));
  assert.equal(granted.available, true);
  assert.equal(granted.detail, undefined);
  const [partial] = discoverComputerUse("darwin", () => ({
    screenRecording: false,
    accessibility: true,
  }));
  assert.equal(partial.available, false);
  assert.match(partial.detail, /^Screen Recording not granted/);
  const [unknown] = discoverComputerUse("darwin", () => {
    throw new Error("osascript failed");
  });
  assert.equal(unknown.available, false);
  assert.match(unknown.detail, /osascript failed/);
});

test("session notes name what the device offers and where images go", () => {
  const notes = sessionResourceNotes("/work/space", [
    {
      id: "browser:google-chrome",
      kind: "browser",
      name: "Google Chrome",
      available: true,
      attributes: { path: "/opt/google/chrome/chrome" },
    },
    {
      id: "computer_use:macos",
      kind: "computer_use",
      name: "macOS screen control",
      available: false,
      detail: "Accessibility not granted to the Foundry worker.",
    },
  ]);
  assert.match(notes, /Google Chrome \(\/opt\/google\/chrome\/chrome\)/);
  assert.match(notes, /do not download or install/);
  assert.match(notes, /--user-data-dir/);
  assert.match(notes, /Screen control is not available.*Accessibility/);
  assert.match(notes, /\/work\/space\/\.foundry\/attachments\//);
  assert.match(
    notes,
    /cite each by its absolute or workspace-relative path in inline code/,
  );
  assert.match(sessionResourceNotes("/w", []), /No browser was found/);
  assert.doesNotMatch(sessionResourceNotes("/w", []), /Screen control/);
  // A session learns its own id and what Foundry ids and links name.
  assert.doesNotMatch(notes, /You are Foundry session/);
  const own = sessionResourceNotes("/w", [], undefined, "sess_42");
  assert.match(own, /^- You are Foundry session sess_42\. /m);
  assert.match(own, /sess_….*ws_… and dev_….*\/chats\/<id>.*foundry skill/);
  assert.match(own, /foundry skill .*starts, steers and waits on/);
});

const linuxOnly = { skip: process.platform !== "linux" };
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (check, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 50));
  return check();
};

/** Stand-ins whose executables are named like a browser. */
function fakeBrowser(t) {
  const dir = mkdtempSync(join(tmpdir(), "foundry-reclaim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shell = join(dir, "chromium");
  const child = join(dir, "chromium-child");
  // macOS kills a copied system binary (its code signature no longer
  // matches); a link keeps the browser-like name that ps reports.
  if (process.platform === "darwin") {
    symlinkSync("/bin/sh", shell);
    symlinkSync("/bin/sleep", child);
  } else {
    copyFileSync("/bin/sh", shell);
    copyFileSync("/bin/sleep", child);
    chmodSync(shell, 0o755);
    chmodSync(child, 0o755);
  }
  return { dir, shell, child };
}

test(
  "an ended input closes the whole browser its session left, not other processes",
  linuxOnly,
  async (t) => {
    const { shell, child } = fakeBrowser(t);
    // The top process has no session marker, like Chrome after it rewrites
    // its environment; its helper still carries one.
    const top = spawn(
      shell,
      ["-c", `FOUNDRY_SESSION_ID=sess_reclaim "${child}" 60 & wait`],
      { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" },
    );
    const other = spawn(child, ["60"], {
      env: { PATH: "/usr/bin:/bin", FOUNDRY_SESSION_ID: "sess_other" },
      stdio: "ignore",
    });
    const notABrowser = spawn("/bin/sleep", ["60"], {
      env: { PATH: "/usr/bin:/bin", FOUNDRY_SESSION_ID: "sess_reclaim" },
      stdio: "ignore",
    });
    t.after(() => [top, other, notABrowser].forEach((c) => c.kill("SIGKILL")));
    await new Promise((done) => setTimeout(done, 300));
    const closed = reclaimSessionResources("sess_reclaim");
    assert.deepEqual(closed.sort(), ["chromium", "chromium-child"]);
    assert.ok(await waitFor(() => !alive(top.pid)), "the top process remains");
    assert.ok(alive(other.pid), "another session's browser was closed");
    assert.ok(alive(notABrowser.pid), "a non-browser process was closed");
    assert.deepEqual(reclaimSessionResources(""), []);
  },
);

test(
  "a browser using the session's scratch directory is the session's",
  linuxOnly,
  async (t) => {
    const { shell, child } = fakeBrowser(t);
    const scratch = sessionScratchEnvironment("sess_scratch").TMPDIR;
    assert.equal(sessionScratchDirectory("sess_scratch"), scratch);
    // No marker in the environment; only an open file in the scratch dir.
    const browser = spawn(
      shell,
      ["-c", `exec 3>"${scratch}/SingletonLock"; exec "${child}" 60`],
      { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" },
    );
    t.after(() => browser.kill("SIGKILL"));
    await new Promise((done) => setTimeout(done, 300));
    assert.deepEqual(reclaimSessionResources("sess_scratch"), [
      "chromium-child",
    ]);
    assert.ok(await waitFor(() => !alive(browser.pid)));
  },
);

test(
  "a real headless browser left running is closed with all its processes",
  {
    skip:
      process.platform !== "linux" ||
      !discoverBrowsers().some((browser) => /chrom/i.test(browser.name)),
  },
  async (t) => {
    const browser = discoverBrowsers().find((b) => /chrom/i.test(b.name));
    const scratch = sessionScratchDirectory("sess_real_browser");
    const profile = mkdtempSync(join(scratch, "profile-"));
    // Detached and without the session marker: only the scratch directory
    // (TMPDIR) ties it to the session, as for an agent's `nohup … &`.
    const started = spawn(
      browser.attributes.path,
      [
        "--headless=new",
        "--no-sandbox",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      {
        detached: true,
        env: { PATH: "/usr/bin:/bin", HOME: tmpdir(), TMPDIR: scratch },
        stdio: "ignore",
      },
    );
    started.unref();
    t.after(() => {
      try {
        process.kill(-started.pid, "SIGKILL");
      } catch {
        // Already closed.
      }
    });
    await new Promise((done) => setTimeout(done, 2500));
    const closed = reclaimSessionResources("sess_real_browser");
    assert.ok(closed.length > 0, "nothing was closed");
    assert.ok(
      await waitFor(() => !alive(started.pid), 5000),
      "the browser's top process is still running",
    );
  },
);

test("browsers other tools downloaded into Playwright's cache count, newest first", (t) => {
  const cache = mkdtempSync(join(tmpdir(), "foundry-playwright-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  for (const build of ["chromium-100", "chromium-120", "firefox-9"]) {
    const dir = join(cache, build, "chrome-linux64");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "chrome"), "");
  }
  const [found] = discoverBrowsers("linux", {
    PATH: "",
    PLAYWRIGHT_BROWSERS_PATH: cache,
  }).filter((resource) => resource.id === "browser:playwright-chromium");
  assert.equal(
    found.attributes.path,
    join(cache, "chromium-120", "chrome-linux64", "chrome"),
  );
});

test(
  "a browser started through its launcher is leased to the session exactly",
  { skip: process.platform === "win32" },
  async (t) => {
    const { child } = fakeBrowser(t);
    const [launcher] = Object.values(
      sessionBrowserLaunchers("sess_lease", [
        {
          id: "browser:chromium",
          kind: "browser",
          name: "Chromium",
          available: true,
          attributes: { path: child },
        },
      ]),
    );
    assert.match(launcher, /\/bin\/chromium$/);
    // No session marker in its environment and no use of the scratch dir:
    // only the lease ties it to the session.
    const browser = spawn(launcher, ["60"], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: "ignore",
      cwd: tmpdir(),
    });
    t.after(() => browser.kill("SIGKILL"));
    // The launcher records its pid, then execs the browser in its place; wait
    // until that has happened rather than for a fixed time (a loaded machine
    // can take longer than a few hundred milliseconds).
    assert.ok(
      await waitFor(() =>
        spawnSync("/bin/ps", ["-o", "comm=", "-p", String(browser.pid)], {
          encoding: "utf8",
        })
          .stdout?.trim()
          .endsWith("chromium-child"),
      ),
      "the launcher became the browser",
    );
    // exec keeps the pid: the leased process is the browser itself.
    assert.deepEqual(reclaimSessionResources("sess_lease"), ["chromium-child"]);
    assert.ok(await waitFor(() => !alive(browser.pid)));
    assert.deepEqual(reclaimSessionResources("sess_lease"), []);
    const notes = sessionResourceNotes(
      "/w",
      [
        {
          id: "browser:chromium",
          kind: "browser",
          name: "Chromium",
          available: true,
          attributes: { path: child },
        },
      ],
      "sess_lease",
    );
    assert.ok(notes.includes(launcher), notes);
  },
);

test(
  "a leased pid reused by something else is left alone",
  { skip: process.platform === "win32" },
  async (t) => {
    const scratch = sessionScratchDirectory("sess_reused");
    const other = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    t.after(() => other.kill("SIGKILL"));
    writeFileSync(join(scratch, "browser-leases"), `${other.pid}\n`);
    assert.deepEqual(reclaimSessionResources("sess_reused"), []);
    assert.ok(alive(other.pid));
  },
);

test("asking for screen control prompts, then opens only the panes still missing", () => {
  const { requestResourceAccess } = resourcePool;
  if (process.platform !== "darwin") {
    assert.throws(
      () => requestResourceAccess("computer_use:macos"),
      /needs no access/,
    );
    return;
  }
  const opened = [];
  let prompted = false;
  assert.deepEqual(
    requestResourceAccess(
      "computer_use:macos",
      () => ({ screenRecording: true, accessibility: false }),
      (url) => opened.push(url),
      () => (prompted = true),
    ),
    ["Accessibility"],
  );
  assert.ok(prompted);
  assert.deepEqual(opened, [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  ]);
});

test("unavailable screen control names the program to allow", () => {
  const [resource] = discoverComputerUse("darwin", () => ({
    screenRecording: false,
    accessibility: false,
  }));
  assert.equal(resource.attributes.grantTo, process.execPath);
  assert.match(resource.detail, /Screen Recording and Accessibility/);
});

// --- Session scratch directories ---------------------------------------------

const {
  knownSessionScratchDirectory,
  sessionScratchIdleMs,
  sweepSessionScratchDirectories,
} = resourcePool;

/**
 * This test's own worker state root and temporary root; the process stands
 * for one worker, a child process on the same roots for its next run.
 */
function scratchWorker(t) {
  const base = mkdtempSync(join(tmpdir(), "scratch-"));
  const temporary = join(base, "tmp");
  mkdirSync(temporary);
  const saved = {
    FOUNDRY_STATE_ROOT: process.env.FOUNDRY_STATE_ROOT,
    TMPDIR: process.env.TMPDIR,
  };
  process.env.FOUNDRY_STATE_ROOT = join(base, "state");
  process.env.TMPDIR = temporary;
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(base, { recursive: true, force: true });
  });
  return {
    base,
    state: process.env.FOUNDRY_STATE_ROOT,
    temporary,
    /** The fdy- directories in the shared temporary root. */
    fdy: () =>
      readdirSync(temporary)
        .filter((name) => name.startsWith("fdy-"))
        .sort(),
  };
}

const distModule = (name) => new URL(`../dist/${name}`, import.meta.url).href;

/** Runs code in another worker process on stateRoot; returns its result. */
function inWorkerProcess(stateRoot, code) {
  const script = [
    `import * as pool from ${JSON.stringify(distModule("resource-pool.js"))};`,
    `import * as background from ${JSON.stringify(distModule("agent-background-tasks.js"))};`,
    `import * as fs from "node:fs";`,
    `const result = await (async () => { ${code} })();`,
    "console.log(JSON.stringify(result ?? null));",
  ].join("\n");
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: { ...process.env, FOUNDRY_STATE_ROOT: stateRoot },
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").at(-1));
}

const later = (ms) => () => Date.now() + ms;
const leasedBrowser = (path) => ({
  id: "browser:chromium",
  kind: "browser",
  name: "Chromium",
  available: true,
  attributes: { path },
});
const isBrowserNow = (pid) =>
  spawnSync("/bin/ps", ["-o", "comm=", "-p", String(pid)], {
    encoding: "utf8",
  })
    .stdout?.trim()
    .endsWith("chromium-child");

test("the scratch idle time is configurable and defaults to three days", () => {
  assert.equal(sessionScratchIdleMs({}), 3 * 24 * 60 * 60 * 1000);
  assert.equal(
    sessionScratchIdleMs({ FOUNDRY_SESSION_SCRATCH_IDLE_MS: "90000" }),
    90000,
  );
  assert.equal(
    sessionScratchIdleMs({ FOUNDRY_SESSION_SCRATCH_IDLE_MS: "soon" }),
    3 * 24 * 60 * 60 * 1000,
  );
});

test("a restarted worker gives a session its scratch directory again, task logs included", (t) => {
  const { state, fdy } = scratchWorker(t);
  const first = inWorkerProcess(
    state,
    `const directory = pool.sessionScratchDirectory("sess_restart");
    const tasks = directory + "/claude-1/-ws/n/tasks";
    fs.mkdirSync(tasks, { recursive: true });
    fs.writeFileSync(tasks + "/b1.output", "still here\\n");
    return directory;`,
  );
  const second = inWorkerProcess(
    state,
    `const known = pool.knownSessionScratchDirectory("sess_restart");
    const read = background.readBackgroundTaskOutput({
      sessionId: "sess_restart",
      taskId: "b1",
      record: { id: "b1", kind: "command", status: "running", description: "b1", startedAt: "" },
      scratchDirectory: known,
    });
    return { known, used: pool.sessionScratchDirectory("sess_restart"), content: read.content };`,
  );
  assert.equal(second.known, first);
  assert.equal(second.used, first);
  assert.equal(second.content, "still here\n");
  assert.deepEqual(fdy(), [basename(first)], "a restart left an orphan");
  // A later run sweeps what an earlier one left once it is idle.
  const swept = inWorkerProcess(
    state,
    `return (await pool.sweepSessionScratchDirectories({ idleMs: 0, now: () => Date.now() + 1000 })).map((entry) => entry.directory);`,
  );
  assert.deepEqual(swept, [first]);
  assert.deepEqual(fdy(), []);
});

test(
  "an idle session's scratch directory goes after its browsers; a busy or held one stays",
  linuxOnly,
  async (t) => {
    const { fdy } = scratchWorker(t);
    const { child } = fakeBrowser(t);
    const idle = sessionScratchDirectory("sess_sweep_idle");
    const [launcher] = Object.values(
      sessionBrowserLaunchers("sess_sweep_idle", [leasedBrowser(child)]),
    );
    const browser = spawn(launcher, ["60"], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: "ignore",
      cwd: "/",
    });
    const busy = sessionScratchDirectory("sess_sweep_busy");
    const held = sessionScratchDirectory("sess_sweep_held");
    // Something the session left running that is not a browser.
    const holder = spawn("/bin/sleep", ["60"], {
      env: { PATH: "/usr/bin:/bin", FOUNDRY_SESSION_ID: "sess_sweep_held" },
      stdio: "ignore",
    });
    t.after(() => [browser, holder].forEach((c) => c.kill("SIGKILL")));
    assert.ok(await waitFor(() => isBrowserNow(browser.pid)));

    // Used within the idle time: kept.
    assert.deepEqual(
      await sweepSessionScratchDirectories({ idleMs: 60_000 }),
      [],
    );
    const removed = await sweepSessionScratchDirectories({
      idleMs: 60_000,
      now: later(120_000),
      busy: (sessionId) => sessionId === "sess_sweep_busy",
    });
    assert.deepEqual(removed, [
      {
        sessionId: "sess_sweep_idle",
        directory: idle,
        closed: ["chromium-child"],
      },
    ]);
    assert.ok(await waitFor(() => !alive(browser.pid)), "its browser runs");
    assert.equal(existsSync(idle), false);
    assert.equal(knownSessionScratchDirectory("sess_sweep_idle"), undefined);
    assert.ok(existsSync(busy), "a busy session lost its directory");
    assert.ok(existsSync(held), "a held directory was removed");
    assert.ok(alive(holder.pid), "the session's other process was closed");

    // Once nothing holds them, they go too.
    holder.kill("SIGKILL");
    assert.ok(await waitFor(() => !alive(holder.pid)));
    const rest = await sweepSessionScratchDirectories({
      idleMs: 60_000,
      now: later(120_000),
    });
    assert.deepEqual(rest.map((entry) => entry.sessionId).sort(), [
      "sess_sweep_busy",
      "sess_sweep_held",
    ]);
    assert.deepEqual(fdy(), []);
    // A session used again gets a new directory.
    assert.notEqual(sessionScratchDirectory("sess_sweep_idle"), idle);
  },
);

test(
  "a scratch directory removed from outside is made again, and nothing on the way fails",
  { skip: process.platform === "win32" },
  async (t) => {
    scratchWorker(t);
    const { child } = fakeBrowser(t);
    const directory = sessionScratchDirectory("sess_removed");
    const tasks = join(directory, "claude-1", "-ws", "n", "tasks");
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(tasks, "b2.output"), "gone soon\n");
    rmSync(directory, { recursive: true, force: true });

    // The input end and a read of the task's log cope with it.
    assert.deepEqual(reclaimSessionResources("sess_removed"), []);
    const record = {
      id: "b2",
      kind: "command",
      status: "completed",
      description: "b2",
      startedAt: "",
    };
    for (const read of [
      { record },
      { record: { ...record, outputPath: join(tasks, "b2.output") } },
    ])
      assert.equal(
        readBackgroundTaskOutput({
          sessionId: "sess_removed",
          taskId: "b2",
          scratchDirectory: directory,
          ...read,
        }).kind,
        "missing",
      );

    // The next use makes it again, at the same path, launchers and lease too.
    const [launcher] = Object.values(
      sessionBrowserLaunchers("sess_removed", [leasedBrowser(child)]),
    );
    assert.equal(launcher, join(directory, "bin", "chromium"));
    assert.equal(sessionScratchDirectory("sess_removed"), directory);
    const browser = spawn(launcher, ["60"], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: "ignore",
      cwd: "/",
    });
    t.after(() => browser.kill("SIGKILL"));
    assert.ok(await waitFor(() => isBrowserNow(browser.pid)));
    assert.equal(
      readFileSync(join(directory, "browser-leases"), "utf8"),
      `${browser.pid}\n`,
    );
    assert.deepEqual(reclaimSessionResources("sess_removed"), [
      "chromium-child",
    ]);

    // A path someone else took meanwhile is never reused.
    rmSync(directory, { recursive: true, force: true });
    symlinkSync(tmpdir(), directory);
    t.after(() => rmSync(directory, { force: true }));
    const replaced = sessionScratchDirectory("sess_removed");
    assert.notEqual(replaced, directory);
    assert.match(basename(replaced), /^fdy-/);
  },
);

test("a sweep removes only its own worker's directories, not another's under the same prefix", async (t) => {
  const { base, state, temporary, fdy } = scratchWorker(t);
  const otherState = join(base, "other-state");
  const other = inWorkerProcess(
    otherState,
    `return pool.sessionScratchDirectory("sess_other_worker");`,
  );
  // One no worker recorded, such as an older worker version left.
  const unrecorded = mkdtempSync(join(temporary, "fdy-"));
  const own = sessionScratchDirectory("sess_own_worker");
  assert.notEqual(state, otherState);

  const removed = await sweepSessionScratchDirectories({
    idleMs: 0,
    now: later(1000),
  });
  assert.deepEqual(
    removed.map((entry) => entry.directory),
    [own],
  );
  assert.ok(existsSync(other), "another worker's directory was removed");
  assert.ok(existsSync(unrecorded), "an unrecorded directory was removed");

  const theirs = inWorkerProcess(
    otherState,
    `return (await pool.sweepSessionScratchDirectories({ idleMs: 0, now: () => Date.now() + 1000 })).map((entry) => entry.directory);`,
  );
  assert.deepEqual(theirs, [other]);
  assert.deepEqual(fdy(), [basename(unrecorded)]);
});
