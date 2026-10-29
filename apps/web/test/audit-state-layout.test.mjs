import test from "node:test";
import assert from "node:assert/strict";
import { stateLayoutFailures } from "../scripts/audit-state-layout.mjs";

const audit = (css) =>
  stateLayoutFailures([{ path: "fixture.css", css }]).map(
    (failure) => `${failure.selector} | ${failure.properties.join("; ")}`,
  );

test("a control that grows on hover or focus fails the audit (DEV-081)", () => {
  // The DEV-065 copy button: no width at rest, 22 px after hover or focus.
  assert.deepEqual(
    audit(`
      .copy.fdy-button { width: 0; opacity: 0; }
      .group:hover .copy,
      .group:focus-within .copy,
      .copy[data-copied="true"] { width: 22px; margin-left: 2px; opacity: 1; }
    `),
    [
      ".group:hover .copy | width: 22px; margin-left: 2px",
      ".group:focus-within .copy | width: 22px; margin-left: 2px",
    ],
  );
  assert.deepEqual(
    audit(`
      .row { padding: 4px; }
      .row:has(:focus-visible) { padding: 6px; }
      .tab:active { font-weight: 700; }
      @media (hover: hover) { .chip:hover { display: inline-flex; } }
    `),
    [
      ".row:has(:focus-visible) | padding: 6px",
      ".tab:active | font-weight: 700",
      ".chip:hover | display: inline-flex",
    ],
  );
});

test("colour, opacity, out-of-flow and unchanged values pass", () => {
  assert.deepEqual(
    audit(`
      .group:hover .copy { opacity: 1; color: red; box-shadow: none; }
      .float { position: absolute; width: 1px; }
      .float:hover { width: 2px; }
      .resizer::before { position: absolute; width: 1px; }
      .resizer:hover::before { width: 2px; }
      .row[data-selected="true"],
      .row[data-selected="true"]:hover { font-weight: 650; }
      .button:disabled { border-style: dashed; padding: 0 4px; }
      .button:disabled:hover { border-style: dashed; padding: 0 4px; }
    `),
    [],
  );
});
