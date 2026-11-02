import assert from "node:assert/strict";
import test from "node:test";
import {
  insidePath,
  isInside,
  relativeInside,
  tildePath,
  within,
} from "../dist/platform/paths.js";

test("isInside compares by segment and excludes the root itself", () => {
  assert.equal(isInside("/a/b", "/a/b/c"), true);
  assert.equal(isInside("/a/b/", "/a/b/c/d"), true);
  assert.equal(isInside("/a/b", "/a/b"), false);
  assert.equal(isInside("/a/b", "/a/bc"), false);
  assert.equal(isInside("/a/b", "/a"), false);
  assert.equal(isInside("/a/b", "/a/b/../c"), false);
  // A name that only begins with dots stays inside (was refused by
  // startsWith("..") copies).
  assert.equal(isInside("/a", "/a/..cache"), true);
  assert.equal(isInside("/", "/etc"), true);
});

test("within also accepts the root", () => {
  assert.equal(within("/a/b", "/a/b"), true);
  assert.equal(within("/a/b/", "/a/b"), true);
  assert.equal(within("/a/b", "/a/b/c"), true);
  assert.equal(within("/a/b", "/a/bc"), false);
  assert.equal(within("/a/b", "/a/b/c/../../x"), false);
});

test("insidePath returns the relative path only when inside", () => {
  assert.equal(insidePath("/a", "/a/b/c"), "b/c");
  assert.equal(insidePath("/a", "/a/..b"), "..b");
  assert.equal(insidePath("/a", "/a"), undefined);
  assert.equal(insidePath("/a", "/b"), undefined);
  assert.equal(relativeInside(".."), false);
  assert.equal(relativeInside("../x"), false);
  assert.equal(relativeInside("..x"), true);
  assert.equal(relativeInside(""), false);
});

test("tildePath shows paths in the home folder as a person types them", () => {
  assert.equal(
    tildePath("/home/me/.foundry/bin", "/home/me"),
    "~/.foundry/bin",
  );
  assert.equal(tildePath("/home/me", "/home/me"), "~");
  assert.equal(tildePath("/home/meadow/x", "/home/me"), "/home/meadow/x");
  assert.equal(tildePath("/opt/x", "/home/me"), "/opt/x");
});
