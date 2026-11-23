import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultParallel, planShards } from "./pa-eval-parallel.mjs";

const c = (id, snapshot) => ({ id, snapshot });
const cases = [
  c("a", "2026-06-01"),
  c("b", "2026-06-01"),
  c("c", "2026-06-01"),
  c("d", "2026-10-12"),
  c("e", "2026-10-12"),
  c("f", "2026-10-12"),
];

test("shards cover every unit once, in cutoff order", () => {
  const shards = planShards(cases, 2, 3);
  const flat = shards.flat();
  assert.equal(flat.length, 12);
  assert.equal(new Set(flat.map((u) => `${u.repeat}:${u.id}`)).size, 12);
  assert.deepEqual(
    shards.map((s) => s.length),
    [4, 4, 4],
  );
  // The first shard holds only the earliest cutoff's units.
  assert.ok(shards[0].every((u) => ["a", "b", "c"].includes(u.id)));
  assert.ok(shards[2].every((u) => ["d", "e", "f"].includes(u.id)));
});

test("more shards than units leaves none empty", () => {
  const shards = planShards(cases.slice(0, 2), 1, 5);
  assert.equal(shards.length, 2);
});

test("the default follows CPUs, memory and the amount of work", () => {
  assert.equal(defaultParallel(351, 64, 235), 16);
  assert.equal(defaultParallel(351, 2, 7), 1);
  assert.equal(defaultParallel(20, 64, 235), 3);
  assert.equal(defaultParallel(2000, 256, 1000), 24);
});
