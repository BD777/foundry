import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import postcss from "postcss";

const src = fileURLToPath(new URL("../src", import.meta.url));
const cssFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? cssFiles(join(directory, entry.name))
      : entry.name.endsWith(".css")
        ? [join(directory, entry.name)]
        : [],
  );
const foundation = join(src, "styles/00-foundation.css");
const light = {},
  dark = {};
postcss.parse(readFileSync(foundation, "utf8")).walkRules((rule) => {
  if (
    rule.selector !== ":root" &&
    !rule.selector.includes('[data-theme="dark"]')
  )
    return;
  rule.walkDecls((decl) => {
    if (decl.prop.startsWith("--"))
      (rule.selector === ":root" ? light : dark)[decl.prop] = decl.value;
  });
});

test("component and feature colors belong to the theme, with no page-specific dark overrides", () => {
  for (const file of cssFiles(src)) {
    const sheet = postcss.parse(readFileSync(file, "utf8"));
    sheet.walkRules((rule) => {
      if (file !== foundation)
        assert.equal(
          rule.selector.includes("data-theme"),
          false,
          `${file}: theme override in ${rule.selector}`,
        );
    });
    sheet.walkDecls((decl) => {
      const palette =
        file === foundation &&
        decl.prop.startsWith("--") &&
        (decl.parent.selector === ":root" ||
          decl.parent.selector?.includes('[data-theme="dark"]'));
      if (palette) return;
      assert.doesNotMatch(
        decl.value,
        /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i,
        `${file}: ${decl.prop}: ${decl.value} must use a semantic token`,
      );
      if (/^(color|background|border-color)$/.test(decl.prop))
        assert.equal(
          decl.important,
          undefined,
          `${file}: forced color override`,
        );
    });
  }
});

function rgba(value, tokens, depth = 0) {
  assert.ok(depth < 20, "theme tokens must not form cycles");
  value = value.trim().replace(/\s+/g, " ");
  value = value.replace(/var\((--[\w-]+)\)/g, (_, key) => {
    assert.ok(tokens[key], `undefined ${key}`);
    return tokens[key];
  });
  if (value.includes("var(")) return rgba(value, tokens, depth + 1);
  if (value.startsWith("color-mix(")) {
    const [first, second] = value
      .slice(10, -1)
      .trim()
      .replace(/^in srgb,\s*/, "")
      .split(/,\s*(?![^()]*\))/);
    const percentage = first.match(/\s([\d.]+)%$/);
    const p = percentage ? Number(percentage[1]) / 100 : 0.5;
    const a = rgba(first.replace(/\s[\d.]+%$/, ""), tokens, depth + 1),
      b = rgba(second.replace(/\s[\d.]+%$/, ""), tokens, depth + 1);
    return a.map((channel, index) => channel * p + b[index] * (1 - p));
  }
  if (value.startsWith("#")) {
    let hex = value.slice(1);
    if (hex.length === 3) hex = [...hex].map((x) => x + x).join("");
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(1);
  }
  const numbers = value.match(/[\d.]+/g)?.map(Number);
  assert.ok(numbers?.length >= 3, `unsupported color ${value}`);
  return [numbers[0], numbers[1], numbers[2], numbers[3] ?? 1];
}
const blend = (a, b) =>
  [0, 1, 2].map((i) => a[i] * a[3] + b[i] * (1 - a[3])).concat(1);
const luminance = (color) =>
  color
    .slice(0, 3)
    .map((v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    })
    .reduce(
      (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
      0,
    );
for (const [name, overrides] of [
  ["light", {}],
  ["dark", dark],
])
  test(`${name} semantic text/surface pairs meet 4.5:1 contrast`, () => {
    const tokens = { ...light, ...overrides },
      panel = rgba(tokens["--fdy-panel"], tokens);
    const pairs = [
      ...["ink", "ink-muted", "ink-faint"].flatMap((text) =>
        [
          "panel",
          "paper",
          "paper-raised",
          "panel-soft",
          "info-surface",
          "control-surface-hover",
        ].map((surface) => [text, surface]),
      ),
      ...["success", "warning", "error", "info"].map((tone) => [
        `${tone}-text`,
        `${tone}-surface`,
      ]),
      ["on-accent", "brass"],
      ["panel", "ink-strong"],
      ["dark-text", "dark-surface"],
      ["dark-muted", "dark-surface"],
      ["media-text", "media-surface"],
      ["diff-added", "dark-surface"],
      ["diff-removed", "dark-surface"],
    ];
    for (const [text, surface] of pairs) {
      const bg = blend(rgba(tokens[`--fdy-${surface}`], tokens), panel),
        fg = blend(rgba(tokens[`--fdy-${text}`], tokens), bg);
      const a = luminance(fg),
        b = luminance(bg),
        ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      assert.ok(ratio >= 4.5, `${text} on ${surface}: ${ratio.toFixed(2)}`);
    }
  });
