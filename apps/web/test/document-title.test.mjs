import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "http://127.0.0.1/" });
globalThis.document = window.document;
// As index.html links it (Vite's base is "/").
document.head.innerHTML =
  '<link rel="icon" type="image/png" href="/foundry-icon.png" />';
const icon = document.querySelector('link[rel~="icon"]');

const {
  buildDocumentTitle,
  setDocumentChat,
  setDocumentPage,
  setDocumentUnread,
  tabStatusMarks,
} = await import("../src/lib/document-title.ts");
const { documentPageTitle } = await import("../src/app/use-document-title.ts");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");

const title = (input) => buildDocumentTitle(documentPageTitle(input));

test("tab titles name the most specific thing first", () => {
  assert.equal(
    title({ view: "chats", workspaceName: "my-feishu" }),
    "Chats · my-feishu — Foundry",
  );
  assert.equal(
    title({
      view: "issue",
      workspaceName: "foundry",
      issue: { shortId: "ISS-7", title: "Fix login" },
    }),
    "ISS-7 Fix login · foundry — Foundry",
  );
  assert.equal(
    title({ view: "issues", workspaceName: "foundry" }),
    "Issues · foundry — Foundry",
  );
  assert.equal(
    title({ view: "workspace", workspaceName: "foundry" }),
    "Overview · foundry — Foundry",
  );
  assert.equal(
    title({ view: "skills", workspaceName: "foundry" }),
    "Skills · foundry — Foundry",
  );
  assert.equal(
    title({ view: "library", workspaceName: "foundry" }),
    "Skill library — Foundry",
  );
  assert.equal(
    title({ view: "devices", workspaceName: "foundry" }),
    "Devices — Foundry",
  );
  assert.equal(
    title({
      view: "devices",
      workspaceName: "foundry",
      device: { label: "byte-dev" },
    }),
    "byte-dev · Devices — Foundry",
  );
  assert.equal(title({ view: "chats", workspaceName: "" }), "Chats — Foundry");
  assert.equal(buildDocumentTitle({}), "Foundry");
});

test("a long chat title is shortened and a running chat is marked", () => {
  const long =
    "整理一下这个目录，我想在这个目录里面来整理我们的飞书消息。这主要就是关注我关注的某些群吧。你先看看结构合不合理".repeat(
      2,
    );
  const built = buildDocumentTitle({
    primary: long,
    context: "my-feishu",
    running: true,
  });
  assert.ok(built.startsWith("⏳ "));
  assert.ok(built.endsWith(" · my-feishu — Foundry"));
  assert.ok(built.includes("…"));
  assert.ok(built.length < long.length + 30);
});

test("the open chat replaces the page name until it closes", () => {
  setDocumentPage({ primary: "Chats", context: "my-feishu" });
  assert.equal(document.title, "Chats · my-feishu — Foundry");
  setDocumentChat({ title: "Digest the group", running: true });
  assert.equal(document.title, "⏳ Digest the group · my-feishu — Foundry");
  setDocumentChat({ title: "Digest the group", running: false });
  assert.equal(document.title, "Digest the group · my-feishu — Foundry");
  setDocumentChat(undefined);
  assert.equal(document.title, "Chats · my-feishu — Foundry");
});

test("one leading marker: running, else unread, else background", () => {
  const parts = { primary: "Digest", context: "ws" };
  const title = (state) => buildDocumentTitle({ ...parts, ...state });
  assert.equal(title({}), "Digest · ws — Foundry");
  assert.equal(title({ running: true }), "⏳ Digest · ws — Foundry");
  assert.equal(title({ unread: true }), "✅ Digest · ws — Foundry");
  assert.equal(title({ background: true }), "⚙️ Digest · ws — Foundry");
  const all = { running: true, unread: true, background: true };
  assert.equal(title(all), "⏳ Digest · ws — Foundry");
  assert.equal(
    title({ ...all, running: false }),
    "✅ Digest · ws — Foundry",
    "an unseen answer outranks work still running in the background",
  );
  assert.equal(title({ running: true, background: true }), title(all));
});

test("status marks show only while a chat is open, never on other pages", () => {
  setDocumentChat(undefined);
  setDocumentPage({ primary: "Devices", context: "my-feishu" });
  setDocumentUnread(true);
  assert.equal(document.title, "Devices · my-feishu — Foundry");
  setDocumentPage({ primary: "Chats", context: "my-feishu" });
  setDocumentChat({ title: "Digest the group", running: true });
  assert.equal(document.title, "⏳ Digest the group · my-feishu — Foundry");
  setDocumentChat({ title: "Digest the group", running: false });
  assert.equal(document.title, "✅ Digest the group · my-feishu — Foundry");
  setDocumentUnread(false);
  assert.equal(document.title, "Digest the group · my-feishu — Foundry");
  setDocumentChat(undefined);
});

test("the tab icon carries the same mark, and idle restores the app icon", () => {
  setDocumentUnread(false);
  setDocumentPage({ primary: "Chats", context: "ws" });
  setDocumentChat({ title: "Patrol", running: false });
  assert.equal(icon.getAttribute("href"), "/foundry-icon.png");
  setDocumentChat({ title: "Patrol", running: true });
  assert.equal(icon.getAttribute("href"), "/foundry-icon-running.png");
  setDocumentChat({ title: "Patrol", running: false, background: true });
  assert.equal(document.title, "⚙️ Patrol · ws — Foundry");
  assert.equal(icon.getAttribute("href"), "/foundry-icon-background.png");
  setDocumentUnread(true);
  assert.equal(icon.getAttribute("href"), "/foundry-icon-unread.png");
  setDocumentUnread(false);
  assert.equal(icon.getAttribute("href"), "/foundry-icon-background.png");
  setDocumentChat(undefined);
  assert.equal(document.title, "Chats · ws — Foundry");
  assert.equal(icon.getAttribute("href"), "/foundry-icon.png");
});

test("the icon is swapped only when the state changes", async () => {
  const swaps = [];
  const observer = new window.MutationObserver((records) =>
    swaps.push(...records.map(() => icon.getAttribute("href"))),
  );
  observer.observe(icon, { attributes: true, attributeFilter: ["href"] });
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  setDocumentPage({ primary: "Chats", context: "ws" });
  setDocumentChat({ title: "Patrol", running: true });
  setDocumentChat({ title: "Patrol — renamed", running: true });
  setDocumentPage({ primary: "Chats", context: "ws 2" });
  await settled();
  assert.deepEqual(swaps, ["/foundry-icon-running.png"]);
  setDocumentChat({ title: "Patrol", running: false });
  setDocumentChat({ title: "Patrol", running: false });
  setDocumentUnread(false);
  await settled();
  assert.deepEqual(swaps, ["/foundry-icon-running.png", "/foundry-icon.png"]);
  observer.disconnect();
  setDocumentChat(undefined);
});

test("every state's icon is in public/", () => {
  for (const { icon: file } of Object.values(tabStatusMarks)) {
    assert.ok(
      existsSync(new URL(`../public/${file}`, import.meta.url)),
      `public/${file}`,
    );
  }
});
