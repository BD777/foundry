// One component system (DEV-113): the Web's UI is built from components/ui
// (Beautiful UI and shadcn/ui components on Tailwind v4) and Tailwind utilities
// over the theme in styles/foundation.css and styles/tokens.css. Features and
// shared widgets add no stylesheet and no rule that reaches into a component
// by its `fdy-*` class.
//
// Test fixtures and galleries follow the same rule: no stylesheet of their own.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const webRoot = resolve(".");
const themeSheets = new Set([
  "src/styles/foundation.css",
  "src/styles/tokens.css",
]);
const entrySheet = "src/styles.css";

const posix = (path) => relative(webRoot, path).split("\\").join("/");

const skippedDirectories = new Set(["node_modules", "dist", ".vite"]);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? skippedDirectories.has(entry.name)
        ? []
        : walk(join(directory, entry.name))
      : [join(directory, entry.name)],
  );
}

const stripComments = (css) =>
  css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** Selectors of every rule in a sheet (at-rule preludes excluded). */
function selectors(css) {
  const source = stripComments(css);
  const found = [];
  for (const match of source.matchAll(/([^{}@;]+)\{/g)) {
    const prelude = match[1].trim();
    if (prelude && !/^(?:from|to|\d+%)/.test(prelude))
      found.push({ selector: prelude, line: lineOf(source, match.index) });
  }
  return found;
}

const layoutUtility =
  /^(?:-?(?:p[xytrblse]?|m[xytrblse]?|w|h|min-w|min-h|max-w|max-h|size|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|start|end|basis|grow|shrink|flex|order|columns|col-span|row-span|grid-cols|grid-rows|leading|tracking|indent)-|text-(?:2xs|xs|sm|md|lg|xl|2xl|\[length:|\(length:)|font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|mono|sans)\b|border(?:-[xytrblse])?(?:-\d+|-\[[\d.]+px\])?$|(?:hidden|block|inline|inline-block|inline-flex|flex|grid|inline-grid|contents|table|static|relative|absolute|fixed|sticky|float-\w+|truncate|whitespace-\w+|break-\w+)$)/;
const stateVariant =
  /^(?:hover|focus|focus-visible|focus-within|active|group-hover|group-focus|group-focus-visible|group-focus-within|group-active|peer-hover|peer-focus|peer-focus-visible|peer-active|has-\[[^\]]*:(?:hover|focus|focus-visible|focus-within|active)[^\]]*\]|group-has-\[[^\]]*\]):/;

function stringLiterals(text) {
  const literals = [];
  for (const match of text.matchAll(
    /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g,
  )) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    const bare = value.replace(/\[[^\]]*\]/g, "").replace(/\(--[^)]*\)/g, "");
    if (
      (/\s/.test(value.trim()) || /[:\[]/.test(value)) &&
      !/[(){};=?$]/.test(bare)
    )
      literals.push({ value, line: lineOf(text, match.index) });
  }
  return literals;
}

/** Problems in the Tailwind utilities written in one TSX/TS file. */
export function utilityFailures(text) {
  const failures = [];
  for (const { value, line } of stringLiterals(text)) {
    const tokens = value.split(/\s+/).filter(Boolean);
    // `outline-none` sets --tw-outline-style: none, which every later outline
    // utility (focus-visible:outline-2 …) reuses: the focus ring never shows.
    if (
      tokens.includes("outline-none") &&
      tokens.some((token) => /(?:^|:)outline-(?:\d|\(|\[|offset)/.test(token))
    )
      failures.push({
        line,
        token: "outline-none",
        reason:
          "outline-none switches every outline utility of this element off, including its focus ring; leave it out (outline-0 for a width reset)",
      });
    // Overflow clips descenders when the line box is shorter than the glyphs:
    // `truncate` (overflow hidden) with `leading-none` or a leading under 1.2.
    const clips = tokens.some((token) =>
      /^(?:truncate|overflow-hidden|overflow-x-hidden|text-ellipsis|line-clamp-\d+)$/.test(
        token,
      ),
    );
    const tightLeading = tokens.find((token) => {
      if (token === "leading-none") return true;
      const arbitrary = /^leading-\[([\d.]+)\]$/.exec(token);
      return arbitrary !== null && Number(arbitrary[1]) < 1.2;
    });
    if (clips && tightLeading)
      failures.push({
        line,
        token: tightLeading,
        reason:
          "overflow-hidden/truncate with a line height under 1.2 clips descenders (g, y, p); use leading-snug or more, or give the box padding",
      });
    const atRestOutOfFlow = tokens.some((token) =>
      /^(?:absolute|fixed)$/.test(token),
    );
    for (const token of tokens) {
      const parts = token.split(/:(?![^\[]*\]|[^(]*\))/);
      const utility = parts[parts.length - 1];
      const variants = parts.slice(0, -1);
      if (/^!./.test(utility) || /!$/.test(utility))
        failures.push({ line, token, reason: "important modifier" });
      if (/^-?text-\[[\d.]+(?:px|rem|em)\]$/.test(utility))
        failures.push({
          line,
          token,
          reason: "font size outside the type scale (text-2xs … text-2xl)",
        });
      if (/^rounded(?:-[a-z]{1,2})?-\[[\d.]+(?:px|rem)\]$/.test(utility))
        failures.push({
          line,
          token,
          reason:
            "radius outside the scale (rounded-xs … rounded-xl, rounded-full)",
        });
      if (/\[#[0-9a-fA-F]{3,8}\]|\[rgba?\(|\[hsla?\(/.test(utility))
        failures.push({
          line,
          token,
          reason: "raw colour: use a theme colour",
        });
      if (
        /^(?:bg|text|border|ring|fill|stroke|outline|divide|from|to|via|shadow|decoration|accent|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}$/.test(
          utility,
        )
      )
        failures.push({
          line,
          token,
          reason: "default Tailwind palette colour: use a theme colour",
        });
      if (/^font-\[(?:inherit|initial)\]$/.test(utility))
        failures.push({
          line,
          token,
          reason:
            "sets only the font family, not weight and size: write [font:inherit] for `font: inherit`",
        });
      if (/\.fdy-/.test(token))
        failures.push({
          line,
          token,
          reason: "a utility variant that selects an fdy-* class",
        });
      if (
        variants.some((variant) => stateVariant.test(`${variant}:`)) &&
        layoutUtility.test(utility.replace(/^!/, "")) &&
        !atRestOutOfFlow
      )
        failures.push({
          line,
          token,
          reason:
            "hover/focus/active must not move content (float the affordance with absolute, or keep its space at rest)",
        });
    }
  }
  return failures;
}

export function componentSystemFailures() {
  const failures = [];
  const files = walk(webRoot).map((path) => ({ path, name: posix(path) }));
  const sheets = files.filter(({ name }) => name.endsWith(".css"));
  for (const { name, path } of sheets) {
    if (name === entrySheet) continue;
    const css = readFileSync(path, "utf8");
    if (themeSheets.has(name)) {
      for (const { selector, line } of selectors(css))
        if (
          /\.fdy-/.test(selector) &&
          !/^\.fdy-foundry-shell\[data-theme="dark"\]$/.test(selector.trim()) &&
          !/^:root\[data-theme="dark"\],\s*\.fdy-foundry-shell\[data-theme="dark"\]$/.test(
            selector.trim(),
          )
        )
          failures.push(
            `${name}:${line} "${selector}" targets an fdy-* class.`,
          );
    } else {
      failures.push(
        `${name} is a stylesheet outside the theme: build the UI from components/ui and Tailwind utilities (only src/styles/foundation.css and src/styles/tokens.css hold CSS).`,
      );
      continue;
    }
    if (/!\s*important/.test(stripComments(css)))
      failures.push(`${name} uses !important.`);
  }
  for (const { name, path } of files) {
    if (!name.endsWith(".tsx") || name.startsWith("scripts/")) continue;
    for (const failure of utilityFailures(readFileSync(path, "utf8")))
      failures.push(
        `${name}:${failure.line} "${failure.token}": ${failure.reason}.`,
      );
  }
  return failures;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const failures = componentSystemFailures();
  if (failures.length) {
    console.error("Component system audit failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("Component system audit passed.");
}
