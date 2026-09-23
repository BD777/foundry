import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
register("./bundler-resolve.mjs", import.meta.url);
const { searchDeviceSkills, SkillSearchHighlight } =
  await import("../src/features/devices/skill-search.tsx");
const skill = (name, description = "", root = "/skills") => ({
  name,
  description,
  root,
  dirName: name,
});

test("title hits outrank descriptions across roots, exact and prefix first", () => {
  const rows = [
    skill("aaa", "ACMECLI", "/a"),
    skill("x-acmecli"),
    skill("acmecli-extra"),
    skill("acmecli", "", "/z"),
    skill("nomatch"),
  ];
  assert.deepEqual(
    searchDeviceSkills(rows, " AcmeCLI ").map((s) => s.name),
    ["acmecli", "acmecli-extra", "x-acmecli", "aaa"],
  );
  assert.equal(rows[0].name, "aaa");
  assert.deepEqual(searchDeviceSkills(rows, "absent"), []);
  assert.equal(searchDeviceSkills(rows, " ").length, 5);
});
test("highlights literal occurrences only, preserving case and escaping source", () => {
  const html = renderToStaticMarkup(
    createElement(SkillSearchHighlight, {
      text: "<script>AcmeCLI + acmecli</script>",
      query: "acmecli",
    }),
  );
  assert.equal((html.match(/<mark /g) || []).length, 2);
  assert.ok(html.includes(">AcmeCLI</mark>"));
  assert.ok(html.includes("&lt;script&gt;"));
  const literal = renderToStaticMarkup(
    createElement(SkillSearchHighlight, { text: "a+b aab", query: "a+b" }),
  );
  assert.ok(literal.includes(">a+b</mark> aab"));
  const empty = renderToStaticMarkup(
    createElement(SkillSearchHighlight, { text: "plain", query: " " }),
  );
  assert.equal(empty, "plain");
});

test("not-on-server filter composes with keyword ranking and reflects promotion", () => {
  const local = skill("acmecli-local");
  const published = { ...skill("acmecli"), promotedSkillId: "server-id" };
  const description = skill("aaa", "uses acmecli");
  const rows = [published, description, local];
  assert.deepEqual(searchDeviceSkills(rows, "acmecli", true), [
    local,
    description,
  ]);
  assert.deepEqual(
    searchDeviceSkills(rows, "", true).map((s) => s.name),
    ["aaa", "acmecli-local"],
  );
  assert.equal(searchDeviceSkills(rows, "acmecli").length, 3);
  assert.equal(
    searchDeviceSkills([{ ...local, promotedSkillId: "new" }], "acmecli", true)
      .length,
    0,
  );
});
