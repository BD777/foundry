// Annotations on a table in an answer map to and from the table's expanded
// copy by cell and offset, so both show the same annotation and selecting in
// either creates the same one.
import assert from "node:assert/strict";
import { register } from "node:module";
import test, { after } from "node:test";
import { Window } from "happy-dom";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://foundry.example/" });
for (const key of [
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLTableElement",
  "HTMLTableCellElement",
  "HTMLTableRowElement",
  "NodeFilter",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: window[key],
  });
}

after(() => window.happyDOM.close());

const { tableMirrorSurface } =
  await import("../src/components/conversation/annotation-surfaces.ts");
const { anchorTextHash } =
  await import("../src/components/conversation/annotations.ts");

const tableHtml =
  "<table><thead><tr><th>步</th><th>做什么</th></tr></thead><tbody>" +
  "<tr><td>1</td><td>校验工具<strong>交付后</strong>：处置优先级写进文档</td></tr>" +
  "<tr><td>2</td><td>浩辉同意后：建表</td></tr></tbody></table>";

function setup() {
  const root = document.createElement("div");
  root.innerHTML = `<p>接下来的顺序</p>${tableHtml}<p>结尾</p>`;
  const dialog = document.createElement("div");
  dialog.innerHTML = tableHtml;
  document.body.replaceChildren(root, dialog);
  return {
    root,
    surface: tableMirrorSurface(
      root,
      root.querySelector("table"),
      dialog.querySelector("table"),
    ),
    mirror: dialog.querySelector("table"),
  };
}

function anchorOf(root, text) {
  const start = root.textContent.indexOf(text);
  return { start, end: start + text.length, textHash: anchorTextHash(text) };
}

test("an annotation inside a table cell shows on the expanded copy", () => {
  const { root, surface, mirror } = setup();
  const range = surface.rangeFor(anchorOf(root, "交付后：处置"));
  assert.ok(range);
  assert.equal(range.toString(), "交付后：处置");
  assert.ok(mirror.contains(range.commonAncestorContainer));
});

test("a selection on the expanded copy maps to the answer's offsets", () => {
  const { root, surface, mirror } = setup();
  const cell = mirror.rows[2].cells[1];
  const range = document.createRange();
  range.setStart(cell.firstChild, 0);
  range.setEnd(cell.firstChild, 4);
  assert.equal(range.toString(), "浩辉同意");
  const expected = anchorOf(root, "浩辉同意");
  assert.deepEqual(surface.offsetsFor(range), {
    start: expected.start,
    end: expected.end,
  });
});

test("an annotation that starts before the table shows from its first cell", () => {
  const { root, surface } = setup();
  const range = surface.rangeFor(anchorOf(root, "顺序步做什么1"));
  assert.ok(range);
  assert.equal(range.toString(), "步做什么1");
});

test("annotations outside the table and stale anchors show nothing there", () => {
  const { root, surface } = setup();
  assert.equal(surface.rangeFor(anchorOf(root, "结尾"))?.toString(), undefined);
  const stale = { ...anchorOf(root, "浩辉同意"), textHash: "0" };
  assert.equal(surface.rangeFor(stale)?.toString(), undefined);
});
