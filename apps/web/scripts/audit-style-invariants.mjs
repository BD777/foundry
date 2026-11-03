import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import postcss from "postcss";
import { readStyleSheets, sourceRoot } from "./style-source.mjs";

const failures = [];
const check = (ok, reason) => {
  if (!ok) failures.push(reason);
};
const read = (path) => readFileSync(resolve(sourceRoot, path), "utf8");
const sheets = readStyleSheets().map(({ path, css }) => ({
  name: relative(sourceRoot, path),
  css,
  root: postcss.parse(css),
}));
/** The declarations of a selector's top-level rule, one per line. */
const rule = (path, selector) => {
  const node = postcss
    .parse(read(path))
    .nodes.find((node) => node.type === "rule" && node.selector === selector);
  const body = node?.nodes.map((decl) => decl.toString()).join(";\n") ?? "";
  check(body, `${path}: ${selector} must be styled`);
  return body;
};

// Theme: colors live in foundation.css (the shared Beautiful UI tokens) and
// tokens.css (the roles built on them); both themes keep text readable.
const foundations = ["styles/foundation.css", "styles/tokens.css"];
const light = {};
const dark = {};
const isPalette = (selector) =>
  selector === ":root" || selector?.includes('[data-theme="dark"]');
for (const { name, root } of sheets) {
  root.walkRules((node) => {
    if (!foundations.includes(name) && node.selector.includes("data-theme"))
      failures.push(`${name}: theme override in ${node.selector}`);
  });
  root.walkDecls((decl) => {
    const selector = decl.parent.selector;
    if (
      foundations.includes(name) &&
      decl.prop.startsWith("--") &&
      isPalette(selector)
    ) {
      (selector === ":root" ? light : dark)[decl.prop] = decl.value;
      return;
    }
    if (foundations.includes(name)) return;
    if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i.test(decl.value))
      failures.push(
        `${name}: ${decl.prop}: ${decl.value} must use a semantic token`,
      );
    if (/^(color|background|border-color)$/.test(decl.prop) && decl.important)
      failures.push(`${name}: forced color override in ${selector}`);
  });
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const toLinear = (v) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const fromLinear = (v) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
/** sRGB 0..255 to OKLab. */
function toOklab([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map((v) => toLinear(v / 255));
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const n = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * n,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * n,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * n,
  ];
}
/** OKLab to sRGB 0..255. */
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const n = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * n,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * n,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * n,
  ].map((v) => clamp01(fromLinear(clamp01(v))) * 255);
}
const splitTop = (text) => {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
};

/** A colour value to [r, g, b, a] (0..255, 0..1), resolving var() and color-mix(). */
function rgba(value, tokens, depth = 0) {
  if (depth > 30) throw new Error("theme tokens form a cycle");
  value = value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/var\((--[\w-]+)\)/g, (_, key) => {
      if (!tokens[key]) throw new Error(`undefined ${key}`);
      return tokens[key];
    });
  if (value.includes("var(")) return rgba(value, tokens, depth + 1);
  if (value === "transparent") return [0, 0, 0, 0];
  if (value.startsWith("color-mix(")) {
    const [space, ...operands] = splitTop(value.slice(10, -1));
    const parsed = operands.map((operand) => {
      const percentage = operand.match(/\s([\d.]+)%$/);
      return {
        color: rgba(operand.replace(/\s[\d.]+%$/, ""), tokens, depth + 1),
        weight: percentage ? Number(percentage[1]) / 100 : undefined,
      };
    });
    const [first, second] = parsed;
    if (first.weight === undefined && second.weight === undefined)
      first.weight = second.weight = 0.5;
    else if (first.weight === undefined) first.weight = 1 - second.weight;
    else if (second.weight === undefined) second.weight = 1 - first.weight;
    const alpha =
      first.color[3] * first.weight + second.color[3] * second.weight;
    const inLab = /oklch|oklab/.test(space);
    const channels = parsed.map(({ color, weight }) =>
      (inLab ? toOklab(color) : color.slice(0, 3)).map(
        (v) => v * weight * color[3],
      ),
    );
    const mixed = [0, 1, 2].map(
      (i) => (channels[0][i] + channels[1][i]) / (alpha || 1),
    );
    return [...(inLab ? fromOklab(mixed) : mixed), alpha];
  }
  if (value.startsWith("oklch(")) {
    const [body, alphaPart] = value
      .slice(6, -1)
      .split("/")
      .map((x) => x.trim());
    const [lightness, chroma, hue] = body
      .split(" ")
      .map((x) => (x.endsWith("%") ? Number(x.slice(0, -1)) / 100 : Number(x)));
    const radians = (hue * Math.PI) / 180;
    const alpha =
      alphaPart === undefined
        ? 1
        : alphaPart.endsWith("%")
          ? Number(alphaPart.slice(0, -1)) / 100
          : Number(alphaPart);
    return [
      ...fromOklab([
        lightness,
        chroma * Math.cos(radians),
        chroma * Math.sin(radians),
      ]),
      alpha,
    ];
  }
  if (value.startsWith("#")) {
    let hex = value.slice(1);
    if (hex.length === 3) hex = [...hex].map((x) => x + x).join("");
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(1);
  }
  const numbers = value.match(/[\d.]+/g)?.map(Number);
  if (!(numbers?.length >= 3)) throw new Error(`unsupported color ${value}`);
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
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrastPairs = [
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
  ["on-accent", "accent"],
  ["panel", "ink-strong"],
  ["dark-text", "dark-surface"],
  ["dark-muted", "dark-surface"],
  ["media-text", "media-surface"],
  ["diff-added", "dark-surface"],
  ["diff-removed", "dark-surface"],
];
for (const [theme, overrides] of [
  ["light", {}],
  ["dark", dark],
]) {
  const tokens = { ...light, ...overrides };
  try {
    const panel = rgba(tokens["--fdy-panel"], tokens);
    for (const [text, surface] of contrastPairs) {
      const bg = blend(rgba(tokens[`--fdy-${surface}`], tokens), panel);
      const fg = blend(rgba(tokens[`--fdy-${text}`], tokens), bg);
      const [a, b] = [luminance(fg), luminance(bg)];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      check(
        ratio >= 4.5,
        `${theme}: ${text} on ${surface} is ${ratio.toFixed(2)}:1, below 4.5:1`,
      );
    }
  } catch (error) {
    failures.push(`${theme} theme: ${error.message}`);
  }
}

// Tooltips and popovers stand out from the page in both themes.
for (const [path, selector] of [
  ["components/ui/popover.css", ".fdy-popover"],
  ["components/ui/tooltip.css", ".fdy-tooltip"],
]) {
  const body = rule(path, selector);
  check(
    /background: var\(--fdy-floating-surface\)/.test(body),
    `${selector} must use --fdy-floating-surface`,
  );
  check(
    /border: 1px solid var\(--fdy-floating-border\)/.test(body),
    `${selector} must use --fdy-floating-border`,
  );
}
check(
  dark["--fdy-floating-surface"] !== "var(--fdy-paper)" &&
    dark["--fdy-floating-surface"] !== dark["--fdy-paper"],
  "dark --fdy-floating-surface must differ from the page",
);
check(
  dark["--fdy-floating-border"] === "var(--fdy-line-strong)",
  "dark --fdy-floating-border must be --fdy-line-strong",
);

// Latin punctuation: CJK fonts draw ’ ‘ “ ” … · — – • full-width, so a Latin
// face covers only those, in every weight and every sans-serif stack.
const family = '"Foundry Latin Punctuation"';
const faces = [];
for (const { root } of sheets)
  root.walkAtRules("font-face", (face) => {
    if (face.toString().includes(family)) faces.push(face);
  });
check(faces.length === 2, `${family} needs a regular and a bold face`);
for (const face of faces) {
  const covered = new Set();
  let range = "";
  let src = "";
  face.walkDecls((decl) => {
    if (decl.prop === "unicode-range") range = decl.value;
    if (decl.prop === "src") src = decl.value;
  });
  for (const part of range.split(",").map((value) => value.trim())) {
    const [from, to = from] = part.replace(/^U\+/i, "").split("-");
    for (let cp = parseInt(from, 16); cp <= parseInt(to, 16); cp += 1)
      covered.add(cp);
  }
  for (const cp of [
    0x2019, 0x2018, 0x201c, 0x201d, 0x2026, 0xb7, 0x2014, 0x2013, 0x2022,
  ])
    check(covered.has(cp), `${family} must cover U+${cp.toString(16)}`);
  check(
    !covered.has(0x61) && !covered.has(0x4e2d),
    `${family} must cover punctuation only`,
  );
  check(
    /^local\(/.test(src) && src.includes('local("DejaVu Sans'),
    `${family} must use local fonts`,
  );
}
for (const { name, root } of sheets)
  root.walkDecls("font-family", (decl) => {
    const names = decl.value
      .replace(/\s+/g, " ")
      .split(",")
      .map((n) => n.trim());
    if (!names.includes("sans-serif")) return;
    const at = names.indexOf(family);
    check(at >= 0, `${name}: ${decl.value} must include ${family}`);
    for (const later of ['"Segoe UI"', "Roboto", "Arial", "sans-serif"])
      if (names.includes(later))
        check(
          at < names.indexOf(later),
          `${name}: ${family} must come before ${later}`,
        );
  });

// cmdk parts are styled through className, never its private attributes.
for (const { name, css } of sheets)
  for (const match of css.matchAll(/\[cmdk-[a-z-]+/g))
    failures.push(`${name}: style cmdk through className, not ${match[0]}]`);

// The model picker inside the profile dialog: a modal popover owns the
// topmost scroll lock, opens downward without flipping, and hands a bounded
// height down to the one scrolling list, whose floor yields to the space.
const combobox = read("components/agent-runtime/model-combobox.tsx");
check(
  /<Popover\.Root[^>]*\bmodal\b/.test(combobox),
  "model-combobox: Popover.Root must be modal",
);
const content = /<Popover\.Content([\s\S]*?)>/.exec(combobox)?.[1] ?? "";
check(
  /side="bottom"/.test(content) && /avoidCollisions=\{false\}/.test(content),
  "model-combobox: the panel must open downward without flipping",
);
check(
  /<Command\.List className="fdy-model-combobox-list"/.test(combobox),
  "model-combobox: the list must be bounded by its own class",
);
const runtimeCss = "components/agent-runtime/agent-runtime.css";
const popover = rule(runtimeCss, ".fdy-model-combobox-popover");
check(/max-height:\s*min\(/.test(popover), "model popover needs a max-height");
check(
  /grid-template-rows:\s*minmax\(0,\s*1fr\)\s*auto/.test(popover),
  "model popover: the catalog row must flex",
);
check(
  /--fdy-model-combobox-chrome:\s*\d/.test(popover),
  "model popover owns --fdy-model-combobox-chrome",
);
const command = rule(runtimeCss, ".fdy-model-combobox-command");
check(
  /grid-template-rows:\s*auto\s*minmax\(0,\s*1fr\)/.test(command) &&
    /min-height:\s*0/.test(command),
  "model command must pass its bound to the list",
);
const list = rule(runtimeCss, ".fdy-model-combobox-list");
check(/overflow-y:\s*auto/.test(list), "model list must scroll");
const floor = /min-height:\s*min\(([\s\S]*?)\)(?:;|$)/.exec(list)?.[1] ?? "";
check(
  floor.includes("--radix-popover-content-available-height") &&
    (floor.match(/--fdy-model-combobox-chrome/g) ?? []).length === 2,
  "model list floor must yield to the available height minus the panel chrome",
);

// Menus inside a dialog open modally and above it; the dialog keeps a
// settled height with the form as its one scrolling row.
check(
  /modal=\{insideDialog\}/.test(read("components/ui/select-menu.tsx")),
  "SelectMenu must open modally inside a dialog",
);
check(
  /<RuntimeDefaultFields[\s\S]*?insideDialog/.test(
    read("features/profiles/profile-editor.tsx"),
  ),
  "the profile editor must pass insideDialog",
);
check(
  /<SelectMenu[\s\S]*?insideDialog=\{insideDialog\}/.test(
    read("components/agent-runtime/runtime-default-fields.tsx"),
  ),
  "runtime default fields must pass insideDialog to SelectMenu",
);
const menuLayer = Number(
  /z-index:\s*(\d+)/.exec(
    rule("components/ui/select-menu.css", ".fdy-select-popover"),
  )?.[1],
);
const dialogLayers = [
  ...read("features/profiles/profiles.css").matchAll(/z-index:\s*(\d+)/g),
].map((m) => Number(m[1]));
check(
  menuLayer >= Math.max(...dialogLayers),
  `.fdy-select-popover (${menuLayer}) must stack above the profile dialog (${Math.max(...dialogLayers)})`,
);
const modal = rule("features/profiles/profiles.css", ".fdy-profile-modal");
check(
  /(^|\n)height:\s*min\(/.test(modal),
  "the profile dialog needs a settled height",
);
check(
  !/overflow:\s*auto/.test(modal),
  "the profile form scrolls, not the whole dialog",
);
check(
  /grid-template-areas:/.test(modal),
  "the profile dialog lays out with grid areas",
);

if (failures.length) {
  console.error(`Style invariants audit failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else console.log("Style invariants audit passed (no baseline exemptions).");
