import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverBrowsers,
  discoverComputerUse,
  reclaimSessionResources,
  sessionResourceNotes,
  sessionBrowserLaunchers,
  sessionScratchDirectory,
  sessionScratchEnvironment,
} from "../dist/resource-pool.js";

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
  assert.match(sessionResourceNotes("/w", []), /No browser was found/);
  assert.doesNotMatch(sessionResourceNotes("/w", []), /Screen control/);
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
  copyFileSync("/bin/sh", shell);
  copyFileSync("/bin/sleep", child);
  chmodSync(shell, 0o755);
  chmodSync(child, 0o755);
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
    await new Promise((done) => setTimeout(done, 300));
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
