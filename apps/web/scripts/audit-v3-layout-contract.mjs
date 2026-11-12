// Structural invariants of the web styles. Values (colors, spacing, sizes)
// are not snapshotted here: the sheets are their only source, and the
// screenshots of a change are its visual review. What this checks is how the
// styles are organized, so a sheet cannot silently restyle what it does not
// own (src/ARCHITECTURE.md, "Styling").
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import postcss from "postcss";
import { enforceAuditBaseline } from "./audit-baseline.mjs";
import {
  importedStylePaths,
  readStyleSheets,
  sourceRoot,
  styleEntryPath,
  styleSheetPaths,
} from "./style-source.mjs";

const failures = [];
const fail = (path, line, reason) =>
  failures.push({ path: relative(sourceRoot, path), line, reason });

const sheets = readStyleSheets().map((sheet) => ({
  ...sheet,
  root: postcss.parse(sheet.css, { from: sheet.path }),
}));

function splitSelectors(selector) {
  return postcss.list
    .comma(selector)
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

/** Style rules outside @keyframes, with their sheet. */
function* styleRules() {
  for (const sheet of sheets)
    for (const node of sheet.root.nodes ?? []) yield* rulesIn(node, sheet);
}

function* rulesIn(node, sheet) {
  if (node.type === "rule") yield { rule: node, sheet };
  else if (node.type === "atrule" && !/keyframes$/.test(node.name))
    for (const child of node.nodes ?? []) yield* rulesIn(child, sheet);
}

// 1. One entry, one mechanism: src/styles.css imports every sheet once, in
//    cascade order, and no module imports a stylesheet itself (an import in a
//    component lands wherever the bundler first meets the module).
{
  const imported = importedStylePaths();
  const counts = new Map();
  for (const path of imported) counts.set(path, (counts.get(path) ?? 0) + 1);
  for (const [path, count] of counts)
    if (count > 1)
      fail(
        styleEntryPath,
        1,
        `${relative(sourceRoot, path)} is imported ${count} times`,
      );
  const known = new Set(styleSheetPaths());
  for (const path of counts.keys())
    if (!known.has(path))
      fail(
        styleEntryPath,
        1,
        `imports ${relative(sourceRoot, path)}, which does not exist`,
      );
  for (const path of known)
    if (!counts.has(path))
      fail(
        path,
        1,
        `${relative(sourceRoot, path)} is not imported by src/styles.css`,
      );

  for (const name of readdirSync(sourceRoot, { recursive: true })) {
    if (!/\.(?:ts|tsx)$/.test(name)) continue;
    const source = readFileSync(join(sourceRoot, name), "utf8");
    for (const match of source.matchAll(/^import\s+["']([^"']+\.css)["'];?$/gm))
      if (!(name === "main.tsx" && match[1] === "./styles.css"))
        fail(
          join(sourceRoot, name),
          source.slice(0, match.index).split("\n").length,
          `${name} imports ${match[1]}; import sheets only from src/styles.css`,
        );
  }
}

// 2. Ownership. A sheet belongs to the module whose folder holds it: a
//    feature (features/<name>), a shared widget (components/<name>), the
//    primitives (components/ui) or the app shell (app); src/styles holds the
//    tokens, base rules and patterns several modules render. A class belongs
//    to the modules whose code names it. A selector may name another module's
//    class only when it is a primitive's class on the sheet owner's own
//    element (`.fdy-own.fdy-button`): props, variants and className are the
//    way to restyle anything else (apps/web/AGENTS.md, UI principles).
const moduleOf = (path) => {
  const rel = relative(sourceRoot, path);
  let match;
  if ((match = /^features\/([^/]+)\//.exec(rel))) return `features/${match[1]}`;
  if (/^components\/ui\//.test(rel)) return "components/ui";
  if ((match = /^components\/([^/]+)\//.exec(rel)))
    return `components/${match[1]}`;
  if ((match = /^components\/([^/.]+)\./.exec(rel)))
    return `components/${match[1]}`;
  if (/^(?:app\/|App\.tsx$)/.test(rel)) return "app";
  if (/^styles\//.test(rel)) return "shared";
  return rel;
};

const code = readdirSync(sourceRoot, { recursive: true })
  .filter((name) => /\.(?:ts|tsx)$/.test(name) && !name.startsWith("i18n/"))
  .map((name) => ({
    module: moduleOf(join(sourceRoot, name)),
    source: readFileSync(join(sourceRoot, name), "utf8"),
  }));
// `fdy-page-surface-${variant}`: a class built from a prefix belongs to the
// module that builds it.
const builtPrefixes = code.flatMap(({ module, source }) =>
  [...source.matchAll(/(fdy-[\w-]*-)\$\{/g)].map((match) => ({
    module,
    prefix: match[1],
  })),
);
const ownersCache = new Map();
function ownersOf(className) {
  if (!ownersCache.has(className)) {
    const word = new RegExp(
      `(?<![\\w-])${className.replace(/-/g, "\\-")}(?![\\w-])`,
    );
    const owners = new Set(
      code
        .filter(({ source }) => word.test(source))
        .map(({ module }) => module),
    );
    for (const { module, prefix } of builtPrefixes)
      if (className.startsWith(prefix)) owners.add(module);
    ownersCache.set(className, owners);
  }
  return ownersCache.get(className);
}

// Compound selectors. `element` holds the classes the matched element itself
// carries; `inner` the ones inside :has()/:not()/:is()/:where(), which say
// something about other elements or alternatives, not what the element is.
function compounds(selector) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of selector) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (depth === 0 && /[\s>+~]/.test(char)) {
      if (current) parts.push(current);
      current = "";
    } else current += char;
  }
  if (current) parts.push(current);
  const classes = (text) => [
    ...new Set([...text.matchAll(/\.(fdy-[\w-]+)/g)].map((match) => match[1])),
  ];
  return parts.map((part) => {
    const outer = part.replace(/:[\w-]+\((?:[^()]|\([^()]*\))*\)/g, "");
    const element = classes(outer);
    return {
      element,
      inner: classes(part).filter((name) => !element.includes(name)),
    };
  });
}

const tokensPath = join(sourceRoot, "styles/tokens.css");
const themePaths = [join(sourceRoot, "styles/foundation.css"), tokensPath];
for (const { rule, sheet } of styleRules()) {
  // The theme sheets are checked as tokens below.
  if (themePaths.includes(sheet.path)) continue;
  const sheetModule = moduleOf(sheet.path);
  const line = rule.source?.start?.line ?? 1;
  for (const selector of splitSelectors(rule.selector)) {
    for (const { element, inner } of compounds(selector)) {
      // The element is the sheet's own: a class its module renders, or in a
      // shared sheet a class several modules render.
      const own = element.some((name) =>
        sheetModule === "shared"
          ? ownersOf(name).size > 1
          : ownersOf(name).has(sheetModule),
      );
      for (const name of [...element, ...inner]) {
        const owners = ownersOf(name);
        if (owners.size === 0) {
          fail(sheet.path, line, `.${name} is styled but no module renders it`);
          continue;
        }
        const primitive = owners.size === 1 && owners.has("components/ui");
        if (own && primitive) continue;
        if (sheetModule === "shared") {
          if (owners.size === 1)
            fail(
              sheet.path,
              line,
              `.${name} is rendered only by ${[...owners][0]}; style it in that module's sheet`,
            );
          continue;
        }
        if (owners.has(sheetModule)) continue;
        fail(
          sheet.path,
          line,
          primitive
            ? `"${selector}" restyles the primitive class .${name} on an element ${sheetModule} does not own; use a prop, variant or className of the primitive`
            : `"${selector}" styles .${name}, a class of ${[...owners].join(", ")}; style it in its owner's sheet or through the owner's props`,
        );
      }
    }
  }
}

// 3. One class, one meaning: a top-level `.name` rule in two sheets that
//    disagree on `display` is two components sharing a class, and the later
//    sheet silently relays out the other (DEV-078: the screenshot viewer's
//    `.fdy-chat-screen` turned the chat page into a padded, content-high grid).
{
  const displayByClass = new Map();
  for (const sheet of sheets)
    for (const rule of sheet.root.nodes ?? []) {
      if (rule.type !== "rule") continue;
      for (const selector of splitSelectors(rule.selector)) {
        if (!/^\.[\w-]+$/.test(selector)) continue;
        rule.walkDecls("display", (declaration) => {
          const entries = displayByClass.get(selector) ?? [];
          entries.push({
            path: sheet.path,
            line: declaration.source?.start?.line ?? 1,
            value: declaration.value.trim(),
          });
          displayByClass.set(selector, entries);
        });
      }
    }
  for (const [selector, entries] of displayByClass) {
    const files = new Set(entries.map((entry) => entry.path));
    const values = new Set(entries.map((entry) => entry.value));
    if (files.size > 1 && values.size > 1)
      fail(
        entries.at(-1).path,
        entries.at(-1).line,
        `${selector} is laid out by more than one sheet (${entries
          .map(
            (entry) =>
              `${relative(sourceRoot, entry.path)} display: ${entry.value}`,
          )
          .join("; ")}); give each component its own class`,
      );
  }
}

// 4. Tokens: the theme defines every token once in :root (styles/foundation.css
//    and styles/tokens.css),
//    the dark theme only overrides those, and every var(--fdy-…) used without
//    a fallback is declared somewhere.
{
  const light = new Set();
  const dark = new Set();
  const themeRules = sheets
    .filter((sheet) => themePaths.includes(sheet.path))
    .flatMap((sheet) => {
      const rules = [];
      sheet.root.walkRules((rule) => {
        // Keyframes, the base layer's element rules and custom variants are not
        // tokens.
        let ancestor = rule.parent;
        let inBase = false;
        while (ancestor) {
          if (ancestor.name === "layer" || ancestor.name === "custom-variant")
            inBase = true;
          ancestor = ancestor.parent;
        }
        if (!inBase && !/keyframes$/.test(rule.parent?.name ?? ""))
          rules.push(rule);
      });
      return rules;
    });
  themeRules.forEach((rule) => {
    const selectors = splitSelectors(rule.selector);
    const target = selectors.includes(":root")
      ? light
      : selectors.every((selector) => selector.includes('[data-theme="dark"]'))
        ? dark
        : null;
    if (!target) {
      fail(
        tokensPath,
        rule.source?.start?.line ?? 1,
        `the theme sheets may only hold :root and the dark theme, got "${rule.selector}"`,
      );
      return;
    }
    rule.walkDecls(/^--/, (declaration) => target.add(declaration.prop));
  });
  if (light.size === 0)
    fail(
      tokensPath,
      1,
      "styles/tokens.css must define the theme tokens in :root",
    );
  for (const token of dark)
    if (!light.has(token))
      fail(
        tokensPath,
        1,
        `the dark theme sets ${token}, which :root does not define`,
      );

  const declared = new Set();
  for (const sheet of sheets)
    sheet.root.walkDecls(/^--/, (declaration) =>
      declared.add(declaration.prop),
    );
  for (const sheet of sheets)
    sheet.root.walkDecls((declaration) => {
      for (const match of declaration.value.matchAll(
        /var\(\s*(--fdy-[\w-]+)\s*(,)?/g,
      ))
        if (!match[2] && !declared.has(match[1]))
          fail(
            sheet.path,
            declaration.source?.start?.line ?? 1,
            `${match[1]} is used but never defined`,
          );
    });
}

// 5. The shell: the window never scrolls as a page; the shell fills the
//    dynamic viewport and each view decides how it scrolls. The document
//    rules are in the theme sheet; the shell's containers are Tailwind
//    utilities on the elements components/ui/app-shell.tsx renders.
{
  const documentRules = [["body", { margin: "0", overflow: "hidden" }]];
  for (const [selector, expected] of documentRules) {
    const declared = new Map();
    for (const { rule } of styleRules())
      if (
        (rule.parent.type === "root" || rule.parent.name === "layer") &&
        splitSelectors(rule.selector).includes(selector)
      )
        rule.walkDecls((declaration) =>
          declared.set(declaration.prop, declaration.value.trim()),
        );
    for (const [property, value] of Object.entries(expected))
      if (declared.get(property) !== value)
        fail(
          styleEntryPath,
          1,
          `${selector} must set ${property}: ${value} (the shell layout), got ${declared.get(property) ?? "nothing"}`,
        );
  }

  const shellPath = join(sourceRoot, "components/ui/app-shell.tsx");
  const shellSource = readFileSync(shellPath, "utf8");
  const shellClasses = [...shellSource.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map(
    (match) => match[1].split(/\s+/),
  );
  const shell = [
    ["fdy-foundry-shell", ["flex", "h-dvh", "overflow-hidden"]],
    ["fdy-sidebar", ["flex", "flex-col", "min-h-0"]],
    ["fdy-main", ["flex", "flex-col", "min-w-0"]],
    [
      "fdy-view",
      [
        "min-h-0",
        "flex-1",
        "overflow-hidden",
        "data-[scroll-mode=page]:overflow-y-auto",
      ],
    ],
  ];
  for (const [marker, utilities] of shell) {
    const classes = shellClasses.find((tokens) => tokens.includes(marker));
    const missing = utilities.filter((utility) => !classes?.includes(utility));
    if (!classes || missing.length)
      fail(
        shellPath,
        1,
        `${marker} must carry ${missing.length ? missing.join(", ") : utilities.join(", ")} (the shell layout)`,
      );
  }
}

enforceAuditBaseline({
  auditName: "v3-layout",
  failureLabel: "V3 layout contract",
  failures,
  signature: (failure) => failure.reason,
});
