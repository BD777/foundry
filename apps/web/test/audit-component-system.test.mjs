import assert from "node:assert/strict";
import test from "node:test";
import { utilityFailures } from "../scripts/audit-component-system.mjs";

const tokens = (source) => utilityFailures(source).map((f) => f.token);

test("the component system audit rejects utilities that bypass the theme", () => {
  assert.deepEqual(
    tokens(
      `<div className="p-2 !m-0 text-[13px] bg-[#fff] hover:bg-red-500 rounded-[7px] [&_.fdy-x]:flex" />`,
    ),
    [
      "!m-0",
      "text-[13px]",
      "bg-[#fff]",
      "hover:bg-red-500",
      "rounded-[7px]",
      "[&_.fdy-x]:flex",
    ],
  );
});

test("outline-none cannot sit beside an outline utility that draws a focus ring", () => {
  assert.deepEqual(
    tokens(`<b className="outline-none focus-visible:outline-2" />`),
    ["outline-none"],
  );
  assert.deepEqual(
    tokens(`<b className="outline-0 focus-visible:outline-none" />`),
    [],
  );
});

test("overflow clipping with a tight line height is rejected (clipped descenders)", () => {
  assert.deepEqual(tokens(`<b className="truncate leading-none" />`), [
    "leading-none",
  ]);
  assert.deepEqual(tokens(`<b className="overflow-hidden leading-[1.1]" />`), [
    "leading-[1.1]",
  ]);
  assert.deepEqual(tokens(`<b className="truncate leading-tight" />`), []);
  assert.deepEqual(tokens(`<b className="flex leading-none" />`), []);
});

test("font-[inherit] is not the font shorthand", () => {
  assert.deepEqual(tokens(`<b className="font-[inherit] [font:inherit]" />`), [
    "font-[inherit]",
  ]);
});

test("hover, focus and press utilities may not move content", () => {
  assert.deepEqual(
    tokens(
      `<a className="flex hover:p-4 group-hover:w-8 focus-visible:border-2" />`,
    ),
    ["hover:p-4", "group-hover:w-8", "focus-visible:border-2"],
  );
  assert.deepEqual(
    tokens(
      `<a className="relative hover:bg-hover focus-visible:outline-2 hover:text-ink active:scale-95 hover:underline" />`,
    ),
    [],
  );
  // An affordance that floats out of flow may appear on hover.
  assert.deepEqual(tokens(`<a className="absolute group-hover:flex" />`), []);
});

test("code that merely contains bangs and quotes is not read as utilities", () => {
  assert.deepEqual(
    tokens(`if (!items.length || value !== "a b") return \`\${x} y\`;`),
    [],
  );
});
