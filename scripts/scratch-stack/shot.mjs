// Signed-in screenshot of a scratch-stack page. Run through
// `scripts/scratch-stack.sh shot <name> <path> <out.png>`, which passes the
// instance's login in SCRATCH_USER / SCRATCH_PASS.
//
// usage: node shot.mjs <url> <out.png> [--dark] [--width N] [--height N] [--wait ms] [--full]
//
// playwright-core: SCRATCH_PLAYWRIGHT_CORE (its directory), else one this
// checkout resolves, else the newest Foundry playwright-cli tool
// (~/.foundry-tools/playwright-cli/<version>/npm/node_modules).
// Browser: SCRATCH_CHROME, else the newest Chromium under
// PLAYWRIGHT_BROWSERS_PATH or the ms-playwright cache, pinned by path because
// the installed revision may lag the one playwright-core expects.
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const valued = new Set(["--width", "--height", "--wait"]);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const [url, out] = args.filter(
  (a, i) => !a.startsWith("--") && !valued.has(args[i - 1]),
);
if (!url || !out) {
  console.error(
    "usage: node shot.mjs <url> <out.png> [--dark] [--width N] [--height N] [--wait ms] [--full]",
  );
  process.exit(2);
}

const byNumbers = (a, b) => {
  const pa = a.match(/\d+/g)?.map(Number) ?? [];
  const pb = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1)
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
};
const newest = (dir, prefix = "") =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((d) => d.startsWith(prefix))
        .sort(byNumbers)
    : [];

function findPlaywrightCore() {
  if (process.env.SCRATCH_PLAYWRIGHT_CORE)
    return join(process.env.SCRATCH_PLAYWRIGHT_CORE, "index.mjs");
  const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
  for (const from of [repo, join(repo, "apps/web")]) {
    try {
      return join(
        dirname(
          createRequire(join(from, "package.json")).resolve(
            "playwright-core/package.json",
          ),
        ),
        "index.mjs",
      );
    } catch {
      // not installed there
    }
  }
  const tools = join(homedir(), ".foundry-tools/playwright-cli");
  return newest(tools)
    .map((v) => join(tools, v, "npm/node_modules/playwright-core/index.mjs"))
    .find(existsSync);
}

function findChrome() {
  if (process.env.SCRATCH_CHROME) return process.env.SCRATCH_CHROME;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (platform() === "darwin"
      ? join(homedir(), "Library/Caches/ms-playwright")
      : join(homedir(), ".cache/ms-playwright"));
  const builds = [
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const revision of newest(cache, "chromium-"))
    for (const build of builds) {
      const path = join(cache, revision, build);
      if (existsSync(path)) return path;
    }
  return undefined; // playwright-core's own default
}

const core = findPlaywrightCore();
if (!core || !existsSync(core)) {
  console.error(
    "playwright-core not found: set SCRATCH_PLAYWRIGHT_CORE to its directory",
  );
  process.exit(1);
}
const { chromium } = await import(pathToFileURL(core).href);
const executablePath = findChrome();

const origin = new URL(url).origin;
const theme = args.includes("--dark") ? "dark" : "light";
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({
    viewport: {
      width: Number(flag("--width", 1440)),
      height: Number(flag("--height", 900)),
    },
    colorScheme: theme,
  });
  const login = await context.request.post(`${origin}/api/auth/login`, {
    headers: { Origin: origin },
    data: {
      username: process.env.SCRATCH_USER,
      password: process.env.SCRATCH_PASS,
    },
  });
  if (!login.ok())
    throw new Error(`login ${login.status()}: ${await login.text()}`);
  // The app keeps its theme in localStorage (apps/web/src/app/navigation.ts).
  await context.addInitScript(
    (mode) => localStorage.setItem("foundry.themeMode", mode),
    theme,
  );
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(Number(flag("--wait", 1500)));
  await page.screenshot({ path: out, fullPage: args.includes("--full") });
  console.log(`${out} (${page.url()})`);
} finally {
  await browser.close();
}
