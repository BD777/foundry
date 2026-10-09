import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
globalThis.document ??= { title: "" };

const { buildDocumentTitle, setDocumentChat, setDocumentPage } =
  await import("../src/lib/document-title.ts");
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
  assert.ok(built.startsWith("● "));
  assert.ok(built.endsWith(" · my-feishu — Foundry"));
  assert.ok(built.includes("…"));
  assert.ok(built.length < long.length + 30);
});

test("the open chat replaces the page name until it closes", () => {
  setDocumentPage({ primary: "Chats", context: "my-feishu" });
  assert.equal(document.title, "Chats · my-feishu — Foundry");
  setDocumentChat({ title: "Digest the group", running: true });
  assert.equal(document.title, "● Digest the group · my-feishu — Foundry");
  setDocumentChat({ title: "Digest the group", running: false });
  assert.equal(document.title, "Digest the group · my-feishu — Foundry");
  setDocumentChat(undefined);
  assert.equal(document.title, "Chats · my-feishu — Foundry");
});
