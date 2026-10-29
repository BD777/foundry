import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const root = new URL("../src/", import.meta.url);
const foundation = readFileSync(
  new URL("styles/00-foundation.css", root),
  "utf8",
);
const family = '"Foundry Latin Punctuation"';

function codePoints(range) {
  const covered = new Set();
  for (const part of range.split(",").map((value) => value.trim())) {
    const [from, to = from] = part.replace(/^U\+/i, "").split("-");
    for (let cp = parseInt(from, 16); cp <= parseInt(to, 16); cp += 1)
      covered.add(cp);
  }
  return covered;
}

function stylesheets(dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) return stylesheets(url);
    return entry.name.endsWith(".css")
      ? [[url.pathname, readFileSync(url, "utf8")]]
      : [];
  });
}

test("Latin punctuation comes from a Latin font in every weight", () => {
  const faces = [...foundation.matchAll(/@font-face\s*\{([^}]*)\}/g)]
    .map((match) => match[1])
    .filter((body) => body.includes(family));
  assert.equal(faces.length, 2, "a regular and a bold face");
  for (const face of faces) {
    const range = /unicode-range:\s*([^;]+);/.exec(face)?.[1] ?? "";
    const covered = codePoints(range);
    // ’ ‘ “ ” … · — – •: full-width in CJK fonts, which a missing Latin
    // family otherwise falls back to.
    for (const cp of [
      0x2019, 0x2018, 0x201c, 0x201d, 0x2026, 0xb7, 0x2014, 0x2013, 0x2022,
    ])
      assert.ok(covered.has(cp), `U+${cp.toString(16)} is covered`);
    // Only punctuation: letters and CJK keep their own fonts.
    assert.ok(!covered.has(0x61) && !covered.has(0x4e2d));
    assert.match(face, /src:\s*local\(/);
    assert.match(face, /local\("DejaVu Sans/);
  }
});

test("every sans-serif stack uses it before the generic fallback", () => {
  const stacks = stylesheets().flatMap(([path, css]) =>
    [...css.matchAll(/font-family:\s*([^;]+);/g)]
      .map((match) => match[1].replace(/\s+/g, " "))
      .filter((stack) => /\bsans-serif\b/.test(stack))
      .map((stack) => [path, stack]),
  );
  assert.ok(stacks.length > 0);
  for (const [path, stack] of stacks) {
    const names = stack.split(",").map((name) => name.trim());
    const at = names.indexOf(family);
    assert.ok(at >= 0, `${path}: ${stack}`);
    // After the system UI fonts (which have these glyphs), before the rest.
    for (const later of ['"Segoe UI"', "Roboto", "Arial", "sans-serif"])
      if (names.includes(later))
        assert.ok(at < names.indexOf(later), `${path}: before ${later}`);
  }
});

test("tooltips and popovers stand out from the page in both themes", () => {
  const block = (selector) =>
    new RegExp(`${selector.replace(/[.[\]"]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(
      foundation,
    )?.[1] ?? "";
  for (const selector of [".fdy-popover", ".fdy-tooltip"]) {
    assert.match(block(selector), /background: var\(--fdy-floating-surface\)/);
    assert.match(
      block(selector),
      /border: 1px solid var\(--fdy-floating-border\)/,
    );
  }
  const dark = /:root\[data-theme="dark"\],[^{]*\{([^}]*)\}/.exec(
    foundation,
  )[1];
  const token = (css, name) =>
    new RegExp(`--fdy-${name}:\\s*([^;]+);`).exec(css)?.[1].trim();
  assert.notEqual(token(dark, "floating-surface"), "var(--fdy-paper)");
  assert.notEqual(token(dark, "floating-surface"), token(dark, "paper"));
  assert.equal(token(dark, "floating-border"), "var(--fdy-line-strong)");
});
