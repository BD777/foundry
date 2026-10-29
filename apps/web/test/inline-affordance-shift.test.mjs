// DEV-081: hovering, focusing or leaving a path an answer names must never
// move any text. Renders the real answer markup, styles it with the app's
// real style sheets in Chromium, and compares every text box across states.
// Skips when no playwright-core or Chromium is installed (set
// FOUNDRY_TEST_PLAYWRIGHT_CORE / FOUNDRY_TEST_CHROME to point at them).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { readStyleSource } from "../scripts/style-source.mjs";

const byVersion = (a, b) => {
  const pa = a.match(/\d+/g)?.map(Number) ?? [];
  const pb = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1)
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
};
const entries = (dir) =>
  existsSync(dir) ? readdirSync(dir).sort(byVersion) : [];

function findPlaywrightCore() {
  if (process.env.FOUNDRY_TEST_PLAYWRIGHT_CORE)
    return join(process.env.FOUNDRY_TEST_PLAYWRIGHT_CORE, "index.mjs");
  try {
    return createRequire(import.meta.url)
      .resolve("playwright-core/package.json")
      .replace(/package\.json$/, "index.mjs");
  } catch {
    const tools = join(homedir(), ".foundry-tools/playwright-cli");
    return entries(tools)
      .map((v) => join(tools, v, "npm/node_modules/playwright-core/index.mjs"))
      .find(existsSync);
  }
}

function findChrome() {
  if (process.env.FOUNDRY_TEST_CHROME) return process.env.FOUNDRY_TEST_CHROME;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(homedir(), ".cache/ms-playwright");
  for (const revision of entries(cache).filter((d) =>
    d.startsWith("chromium-"),
  ))
    for (const build of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const path = join(cache, revision, build);
      if (existsSync(path)) return path;
    }
  return undefined;
}

const answer = [
  "已导出到 `reports/feishu-export/` ，另见 [计划](docs/plan.md) 和 `apps/web/src/app.ts` 。",
  "后面还有一段较长的说明，让段落换到第二行、第三行，检查换行后的文字同样不会移动。",
].join("");

/** The answer as the chat renders it, with its path buttons. */
async function answerMarkup() {
  const window = new Window();
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    IntersectionObserver: window.IntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of ["Node", "Element", "HTMLElement", "Event", "MouseEvent"])
    globals[key] = window[key];
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  try {
    const { createRoot } = await import("react-dom/client");
    await import("../src/i18n/index.ts");
    const { MarkdownContent } =
      await import("../src/components/conversation/markdown-content.tsx");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(
          MarkdownContent,
          {
            fileReferences: [
              ["reports/feishu-export/", "reports/feishu-export", "dir"],
              ["docs/plan.md", "docs/plan.md", "file"],
              ["apps/web/src/app.ts", "apps/web/src/app.ts", "file"],
            ].map(([text, path, kind]) => ({
              text,
              path: `/home/u/ws/${path}`,
              kind,
            })),
            onOpenFileReference: () => {},
          },
          answer,
        ),
      ),
    );
    const html = container.innerHTML;
    await act(async () => root.unmount());
    return html;
  } finally {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}

// Every text box in the answer, path text included, except the copy button's.
function textBoxes() {
  const boxes = [];
  const walker = document.createTreeWalker(
    document.querySelector("#answer"),
    NodeFilter.SHOW_TEXT,
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement.closest(".fdy-chat-file-reference-copy")) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects())
      boxes.push(
        `${node.textContent.slice(0, 6)} ${r.x.toFixed(2)},${r.y.toFixed(2)} ${r.width.toFixed(2)}x${r.height.toFixed(2)}`,
      );
  }
  return boxes;
}

const copyShown = (page, index) =>
  page.evaluate(
    (i) =>
      getComputedStyle(
        document.querySelectorAll(".fdy-chat-file-reference-copy")[i],
      ).opacity === "1",
    index,
  );

const core = findPlaywrightCore();
const chrome = findChrome();
const skip =
  !core || !existsSync(core)
    ? "playwright-core is not installed"
    : !chrome
      ? "Chromium is not installed"
      : false;

test(
  "hovering, focusing or leaving an answer's path moves no text",
  { skip, timeout: 60_000 },
  async () => {
    const { chromium } = await import(pathToFileURL(core).href);
    const html = await answerMarkup();
    const css = readStyleSource();
    const browser = await chromium.launch({
      executablePath: chrome,
      headless: true,
    });
    try {
      for (const [width, theme] of [
        [1280, "light"],
        [390, "dark"],
      ]) {
        const context = await browser.newContext({
          viewport: { width, height: 700 },
        });
        const page = await context.newPage();
        await page.setContent(
          `<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head><body><main id="answer" style="padding:16px 20px;max-width:640px">${html}</main></body></html>`,
        );
        const chips = page.locator(".fdy-chat-file-reference");
        const count = await chips.count();
        assert.equal(count, 3, "three paths link");
        const rest = await page.evaluate(textBoxes);
        const same = async (state) =>
          assert.deepEqual(
            await page.evaluate(textBoxes),
            rest,
            `${width}px ${theme}: ${state}`,
          );

        for (let i = 0; i < count; i += 1) {
          assert.equal(await copyShown(page, i), false, "hidden at rest");
          const chip = await chips.nth(i).boundingBox();
          await page.mouse.move(chip.x + chip.width / 2, chip.y + 4);
          await page.waitForTimeout(350);
          assert.equal(await copyShown(page, i), true, `copy ${i} on hover`);
          // Its full size: the zero-width anchor must not squeeze it.
          const shown = await page
            .locator(".fdy-chat-file-reference-copy")
            .nth(i)
            .boundingBox();
          assert.deepEqual([shown.width, shown.height], [24, 24]);
          await same(`hover path ${i}`);
          // Cross the gap slowly: the button must stay up and take the hover.
          const copy = await page
            .locator(".fdy-chat-file-reference-copy")
            .nth(i)
            .boundingBox();
          await page.mouse.move(
            copy.x + copy.width / 2,
            copy.y + copy.height / 2,
            { steps: 12 },
          );
          await page.waitForTimeout(350);
          assert.equal(
            await page.evaluate(
              (n) =>
                document
                  .querySelectorAll(".fdy-chat-file-reference-copy")
                  [n].matches(":hover"),
              i,
            ),
            true,
            `copy ${i} takes the pointer`,
          );
          await same(`hover copy ${i}`);
          await page.evaluate(
            (n) =>
              document
                .querySelectorAll(".fdy-chat-file-reference-copy")
                [n].setAttribute("data-copied", "true"),
            i,
          );
          await same(`copied ${i}`);
          await page.evaluate(
            (n) =>
              document
                .querySelectorAll(".fdy-chat-file-reference-copy")
                [n].setAttribute("data-copied", "false"),
            i,
          );
          await page.mouse.move(1, 1);
          await page.waitForTimeout(450);
          assert.equal(await copyShown(page, i), false, `copy ${i} leaves`);
          await same(`left path ${i}`);
        }

        // Keyboard: Tab reaches each path, then its copy button.
        await page.evaluate(() => document.activeElement?.blur());
        for (let i = 0; i < count; i += 1) {
          await page.keyboard.press("Tab");
          await page.waitForTimeout(200);
          assert.equal(
            await page.evaluate(() =>
              document.activeElement?.classList.contains(
                "fdy-chat-file-reference",
              ),
            ),
            true,
          );
          assert.equal(await copyShown(page, i), true, `copy ${i} on focus`);
          await same(`focus path ${i}`);
          await page.keyboard.press("Tab");
          await page.waitForTimeout(200);
          assert.equal(
            await page.evaluate(() =>
              document.activeElement?.getAttribute("aria-label"),
            ),
            `Copy ${["/home/u/ws/reports/feishu-export", "/home/u/ws/docs/plan.md", "/home/u/ws/apps/web/src/app.ts"][i]}`,
          );
          await same(`focus copy ${i}`);
        }
        await context.close();
      }

      // Touch: no hover, so the button keeps its own slot and stays in sight.
      const touch = await browser.newContext({
        viewport: { width: 390, height: 700 },
        hasTouch: true,
        isMobile: true,
      });
      const page = await touch.newPage();
      await page.setContent(
        `<!doctype html><html data-theme="light"><head><style>${css}</style></head><body><main id="answer" style="padding:16px 20px">${html}</main></body></html>`,
      );
      if (await page.evaluate(() => matchMedia("(hover: none)").matches)) {
        const rest = await page.evaluate(textBoxes);
        assert.equal(await copyShown(page, 0), true, "copy shown on touch");
        await page.locator(".fdy-chat-file-reference-copy").first().tap();
        await page.waitForTimeout(300);
        assert.deepEqual(await page.evaluate(textBoxes), rest, "touch tap");
      }
      await touch.close();
    } finally {
      await browser.close();
    }
  },
);
