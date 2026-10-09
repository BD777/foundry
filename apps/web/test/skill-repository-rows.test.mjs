import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("./bundler-resolve.mjs", import.meta.url);

const { SkillPickRow } =
  await import("../src/features/skill-library/skill-pick-row.tsx");
const { bundleVersionLabel, rollbackMenuItems } =
  await import("../src/features/skill-library/skill-bundle-row.tsx");
const { RepositorySkillList } =
  await import("../src/features/skill-library/repository-skill-list.tsx");

const picked = (skills, foundCount) => ({
  id: "repo_1",
  url: "https://github.com/riba2534/feishu-cli",
  label: "github.com/riba2534/feishu-cli",
  createdAt: "",
  mode: "pick",
  commit: "745592c0ffee",
  description: "Feishu CLI and its agent skills",
  foundCount,
  skills,
});
const row = (repo, canManage = true) =>
  renderToStaticMarkup(
    createElement(SkillPickRow, {
      repo,
      canManage,
      busy: false,
      anyBusy: false,
      checkedLabel: "",
      onAdd: () => {},
      run: () => {},
    }),
  );

test("a picked repository describes itself and offers one next step", () => {
  const empty = row(picked([], 9));
  assert.match(empty, /Picked skills/);
  assert.match(empty, /0 of 9 added/);
  assert.match(empty, /Feishu CLI and its agent skills/);
  // Nothing picked follows a version yet.
  assert.doesNotMatch(empty, /latest release|updates automatically|745592c/);
  // How-to guidance is the section's, not each card's.
  assert.doesNotMatch(empty, /Nothing from this repository/);
  // One primary action; the rest sit behind the "…" menu.
  assert.equal(empty.match(/fdy-button-primary/g)?.length, 1);
  assert.match(empty, /fdy-button-primary[^>]*>Follow the whole repository</);
  assert.match(
    empty,
    /aria-label="Actions for github\.com\/riba2534\/feishu-cli"/,
  );
  assert.doesNotMatch(empty, /Stop following|Check now|Pick skills instead/);

  const some = row(
    picked([{ skillId: "a", dir: "skills/a", commit: "c" }], undefined),
  );
  assert.match(some, /1 added/);
  assert.doesNotMatch(some, /fdy-button-primary/, "nothing to suggest");
  assert.match(some, /Actions for/);

  const member = row(picked([], 9), false);
  assert.doesNotMatch(member, /Follow|Actions for/);
  assert.match(member, /Feishu CLI and its agent skills/);
});

test("picked skills show the version they follow, what changed and what left the repository", () => {
  const following = {
    ...picked(
      [
        { skillId: "a", dir: "skills/a", commit: "c3", name: "review" },
        {
          skillId: "b",
          dir: "skills/b",
          commit: "c1",
          name: "notes",
          missing: true,
        },
      ],
      9,
    ),
    version: "v1.2.0",
    versions: [
      {
        seq: 3,
        tag: "v1.2.0",
        commit: "c3",
        appliedAt: "",
        changed: ["review"],
        missing: ["notes"],
      },
      { seq: 2, tag: "v1.1.0", commit: "c2", appliedAt: "" },
      { seq: 1, tag: "v1.0.0", commit: "c1", appliedAt: "" },
    ],
  };
  const text = row(following)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  assert.match(text, /Picked skills v1\.2\.0 \(latest release\)/);
  assert.match(text, /2 of 9 added · updates automatically/);
  assert.match(
    text,
    /Updated to v1\.2\.0 · 1 changed · 1 gone from the repository/,
  );
  assert.match(
    text,
    /notes is no longer in the repository; the library keeps its last version\./,
  );
  assert.match(text, /Show its 2 picked skills review, notes/);
  assert.doesNotMatch(text, /Updates paused|Resume updates/);

  // Earlier versions are offered to roll back to, newest first.
  assert.deepEqual(
    rollbackMenuItems(following, () => {}).map((item) => item.label),
    ["Roll back to v1.1.0", "Roll back to v1.0.0"],
  );

  // Held at an earlier version: resuming is the suggested step.
  const paused = row({ ...following, paused: true });
  assert.match(paused, /Updates paused/);
  assert.match(paused, /fdy-button-primary[^>]*>Resume updates</);
  assert.doesNotMatch(paused, /updates automatically/);
});

test("a bundle's header names the version it follows", () => {
  assert.equal(
    bundleVersionLabel({ version: "v1.41.0" }),
    "v1.41.0 (latest release)",
  );
  assert.equal(
    bundleVersionLabel({ ref: "main", version: "main@abc1234" }),
    "branch main@abc1234",
  );
  assert.equal(
    bundleVersionLabel({ version: "abc1234" }),
    "default branch @ abc1234",
  );
});

test("the pick list offers select all over the skills not yet added", () => {
  const folders = [
    { dir: "skills/a", name: "a", description: "" },
    { dir: "skills/b", name: "b", description: "" },
    { dir: "skills/c", name: "c", description: "", skillId: "in-library" },
  ];
  const render = (chosen) =>
    renderToStaticMarkup(
      createElement(RepositorySkillList, {
        folders,
        chosen: new Set(chosen),
        onChooseAll: () => {},
        onToggle: () => {},
      }),
    );
  assert.match(render([]), /Select all/);
  assert.match(render([]), /0 of 2 selected/);
  assert.match(render(["skills/a", "skills/b"]), /Clear/);
  assert.match(render(["skills/a", "skills/b"]), /2 of 2 selected/);
  // A read-only (bundle) list has no select all.
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(RepositorySkillList, { folders })),
    /Select all/,
  );
});
