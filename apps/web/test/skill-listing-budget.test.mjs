import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeSkillListing,
  displayWidth,
} from "../src/features/skills/skill-listing-budget.ts";

test("CJK characters take two columns of the listing budget", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("搜索abc"), 7);
});

test("a listing within budget keeps every description", () => {
  const skills = [
    { name: "a", description: "x".repeat(10) },
    { name: "b", description: "y".repeat(10) },
  ];
  // "- a: xxxxxxxxxx" is 15 wide, twice, plus one newline.
  assert.deepEqual(claudeSkillListing(skills, 31), {
    entries: 2,
    budget: 31,
    fullWidth: 31,
    withoutDescriptions: 0,
  });
});

test("over budget, names stay and the narrowest descriptions come back first", () => {
  const skills = [
    { name: "a", description: "x".repeat(10) },
    { name: "b", description: "y".repeat(40) },
    { name: "c", description: "z".repeat(5) },
    { name: "official", description: "w".repeat(30), bundled: true },
  ];
  // Names: "- a" "- b" "- c" (3 each), the bundled entry in full (42), three
  // newlines: 54. A budget of 73 leaves 19: c (+7) and a (+12) fit, b (+42)
  // does not; one less and a no longer fits either.
  assert.equal(claudeSkillListing(skills, 73).withoutDescriptions, 1);
  assert.equal(claudeSkillListing(skills, 72).withoutDescriptions, 2);
});

test("descriptions count at most 1536 characters", () => {
  const long = [{ name: "a", description: "x".repeat(5000) }];
  assert.equal(claudeSkillListing(long, 100_000).fullWidth, 3 + 2 + 1536);
});
