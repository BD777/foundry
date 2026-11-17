import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./bundler-resolve.mjs", import.meta.url);
const { parseAnnotationReferenceHref, remarkCodexAnnotations } =
  await import("../src/components/conversation/remark-codex-annotations.ts");

function render(children) {
  const tree = { type: "root", children: [{ type: "paragraph", children }] };
  remarkCodexAnnotations()(tree);
  return tree.children[0].children;
}

test("a directive becomes a reference link carrying its index and id", () => {
  const [before, link, after] = render([
    {
      type: "text",
      value: '前文 :codex-annotation{index="1" id="0418a499"} 已收到',
    },
  ]);
  assert.equal(before.value, "前文 ");
  assert.equal(link.type, "link");
  assert.deepEqual(parseAnnotationReferenceHref(link.url), {
    index: 1,
    id: "0418a499",
  });
  assert.equal(after.value, " 已收到");
});

test("a directive without an id is still a reference, with no id", () => {
  const [link] = render([
    { type: "text", value: ':codex-annotation{index="2"}' },
  ]);
  assert.deepEqual(parseAnnotationReferenceHref(link.url), {
    index: 2,
    id: undefined,
  });
});

test("code and existing links keep the directive as written", () => {
  const children = [
    {
      type: "inlineCode",
      value: ':codex-annotation{index="1" id="x"}',
    },
    {
      type: "link",
      url: "https://example.com",
      children: [
        { type: "text", value: ':codex-annotation{index="1" id="x"}' },
      ],
    },
  ];
  const result = render(children);
  assert.equal(result[0].type, "inlineCode");
  assert.equal(result[1].type, "link");
  assert.equal(result[1].url, "https://example.com");
  assert.equal(result[1].children[0].type, "text");
});

test("an invalid index is not a reference", () => {
  assert.equal(
    parseAnnotationReferenceHref("#codex-annotation:0:x"),
    undefined,
  );
  assert.equal(
    parseAnnotationReferenceHref("#codex-annotation:abc:x"),
    undefined,
  );
  assert.equal(parseAnnotationReferenceHref("#other"), undefined);
});
