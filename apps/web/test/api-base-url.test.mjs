import assert from "node:assert/strict";
import test from "node:test";
import { apiBaseUrl, resolveApiBaseUrl } from "../src/lib/api-base-url.ts";

const local = "http://127.0.0.1:31982";

test("a production build without VITE_API_BASE_URL stays on its own origin", () => {
  // A production build folds DEV to false, so no local default is passed.
  assert.equal(resolveApiBaseUrl(undefined, undefined), "");
});

test("the Vite dev server and Node tests default to the local server", () => {
  assert.equal(resolveApiBaseUrl(undefined, local), local);
  assert.equal(apiBaseUrl, local);
});

test("an explicit VITE_API_BASE_URL wins, empty meaning same origin", () => {
  assert.equal(resolveApiBaseUrl("", local), "");
  assert.equal(
    resolveApiBaseUrl("https://api.example", local),
    "https://api.example",
  );
});
