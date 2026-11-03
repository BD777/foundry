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
  if (!/^(?:var\(--fdy-text-[\w-]+\)|inherit|[\d.]+(?:em|%))$/.test(value)) {
    failures.push({
      line: lineFor(match.index),
      reason: `font-size must be a --fdy-text-* token, got "${value}"`,
    });
  }
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

for (const match of css.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;]+);/g)) {
  const value = match[1].trim();
  if (
    !/^(?:(?:var\(--fdy-(?:radius|panel-radius)[\w-]*\)|0|50%|inherit)(?:\s+|$))+$/.test(
      value,
    )
  ) {
    failures.push({
      line: lineFor(match.index),
      reason: `border-radius must use --fdy-radius-* tokens, got "${value}"`,
    });
  }
}

// A boundary is drawn once: a card is a ring in its shadow, a field a border.
// A rule with a visible border and a ring-bearing shadow draws it twice.
const ringShadows =
  /var\(--fdy-(?:panel-shadow|panel-shadow-hover|shadow|ring|shadow-floating|shadow-sheet|shadow-prompt|selected-ring)\)/;
const borderingProps = /^(?:border|border-color)$/;
for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const body = match[2];
  const border = [
    ...body.matchAll(/(?:^|[;\s])(border(?:-color)?)\s*:\s*([^;]+)(?:;|$)/g),
  ].find(
    ([, prop, value]) =>
      borderingProps.test(prop) &&
      !/^(?:0|none)\b|transparent|--fdy-panel-border/.test(value.trim()),
  );
  const shadow = /box-shadow\s*:\s*([^;]+)(?:;|$)/.exec(body);
  if (border && shadow && ringShadows.test(shadow[1])) {
    failures.push({
      line: lineFor(match.index),
      reason: `a visible border and a ring shadow draw the boundary twice in "${match[1].trim().split("\n").pop()}"`,
    });
  }
}

// A card is a Panel: a ring in its shadow, not a bordered box. Fields, frames
// around embedded documents and code chips keep their border.
const borderedCardException =
  /field|select-trigger|-frame|code|input|textarea|button|chip|pill|badge|tag|swatch/i;
for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = match[1].trim().split("\n").pop();
  const body = match[2];
  if (borderedCardException.test(match[1])) continue;
  const border =
    /(?:^|[;\s])border\s*:\s*1px solid var\(--fdy-(?:line|line-strong|control-border|line-soft)\)/.test(
      body,
    );
  const radius =
    /border-radius\s*:\s*var\(--fdy-(?:radius-(?:lg|xl)|panel-radius(?:-md)?)\)\s*(?:;|$)/.test(
      body,
    );
  const fill =
    /background(?:-color)?\s*:\s*var\(--fdy-(?:panel|paper-raised|paper-main)\)/.test(
      body,
    );
  if (border && radius && fill) {
    failures.push({
      line: lineFor(match.index),
      reason: `"${selector}" draws a card with a border; use a ring shadow (--fdy-panel-shadow) or the Panel component`,
    });
  }
}

// A rule that needs !important is fighting someone else's inline style or
// another rule: fix it through the primitive's props or the cascade order.
for (const match of css.matchAll(/!\s*important/gi)) {
  failures.push({
    line: lineFor(match.index),
    reason: `!important is not allowed, got it in "${selectorFor(match.index)}"`,
  });
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
  if (
    !selector.includes(".fdy-sidebar-nav-scroll .fdy-scroll-viewport") &&
    !selector.includes('.fdy-scroll-viewport[data-direction="horizontal"]')
  ) {
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
