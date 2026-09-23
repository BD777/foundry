import { readFileSync } from "node:fs";
import { enforceAuditBaseline } from "./audit-baseline.mjs";
import { readStyleSource } from "./style-source.mjs";

const css = readStyleSource();
const failures = [];

function normalizeColor(value) {
  const color = value.toLowerCase();
  const long = /^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/.exec(color);
  return long ? `#${long[1]}${long[2]}${long[3]}` : color;
}

// Colors of the approved design; CSS may only use values from this palette.
const designColors = new Set(
  JSON.parse(
    readFileSync(new URL("./design-palette.json", import.meta.url), "utf8"),
  ),
);

function lineFor(index) {
  return css.slice(0, index).split("\n").length;
}

function selectorFor(index) {
  const blockStart = css.lastIndexOf("{", index);
  if (blockStart === -1) {
    return "";
  }

  const previousBlockEnd = css.lastIndexOf("}", blockStart);
  return css.slice(previousBlockEnd + 1, blockStart).trim();
}

for (const match of css.matchAll(/letter-spacing\s*:\s*([^;]+);/g)) {
  const value = match[1].trim();
  if (value !== "0") {
    failures.push({
      line: lineFor(match.index),
      reason: `letter-spacing must be 0, got "${value}"`,
    });
  }
}

for (const match of css.matchAll(/font-size\s*:\s*([^;]+);/g)) {
  const value = match[1].trim();
  if (
    /\b(?:calc|clamp)\s*\(/.test(value) ||
    /\d(?:vw|vh|vmin|vmax)\b/.test(value)
  ) {
    failures.push({
      line: lineFor(match.index),
      reason: `font-size must not scale with viewport, got "${value}"`,
    });
  }
}

for (const match of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
  const color = normalizeColor(match[0]);
  if (!designColors.has(color)) {
    failures.push({
      line: lineFor(match.index),
      reason: `CSS color must come from the V3 design palette, got "${match[0]}"`,
    });
  }
}

for (const match of css.matchAll(
  /(overflow-x\s*:\s*auto(?:\s*!important)?|-webkit-overflow-scrolling\s*:\s*touch)\s*;/g,
)) {
  const selector = selectorFor(match.index);
  if (!selector.includes(".fdy-sidebar-nav-scroll .fdy-scroll-viewport")) {
    failures.push({
      line: lineFor(match.index),
      reason: `horizontal scrolling must use ScrollArea components, got "${match[1]}" in "${selector}"`,
    });
  }
}

enforceAuditBaseline({
  auditName: "css-constraints",
  failureLabel: "CSS constraint",
  failures,
  signature: (failure) => failure.reason,
});
