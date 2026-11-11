import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { Window } from "happy-dom";

test("a Happy DOM node has a concise inspect representation", () => {
  const window = new Window();
  const button = window.document.createElement("button");
  button.className = "fdy-primary";
  button.textContent = "Save profile";

  assert.equal(
    inspect(button),
    '<button class="fdy-primary">Save profile</button>',
  );
});
