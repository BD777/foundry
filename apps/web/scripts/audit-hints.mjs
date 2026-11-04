// One hint system (DEV-113): copy that explains, warns or guides is rendered by
// five primitives only, never as a loose paragraph:
//   field helper        FieldHint, directly under its control (or `hint` of an input)
//   page/section        the `description` of PageHeader / SectionHeader / Dialog / EmptyState
//   state notice        Alert (its `actions` slot holds the buttons that answer it)
//   how it works        HelpHint (the ? popover), or the `help` slot of a header
//   row metadata        the row's own meta line (ManagementRowCopy), short
// A locale key that names itself a hint (…Hint, …Note, …Intro, …Help) and is
// rendered straight into JSX outside those primitives fails. Existing
// violations are listed in scripts/hint-baseline.json; it may only shrink.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const sourceRoot = resolve("src");
const baselinePath = new URL("./hint-baseline.json", import.meta.url);
const hintKey = /(?:Hint|Note|Intro|Help)$/;
const hostTags = new Set(["FieldHint", "HelpHint", "Alert", "SectionNote"]);
const hostAttributes = new Set([
  "description",
  "hint",
  "help",
  "label",
  "aria-label",
  "placeholder",
  "content",
]);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(directory, entry.name))
      : [join(directory, entry.name)],
  );
}

function keyOf(call) {
  const callee = call.expression;
  if (!ts.isIdentifier(callee) || callee.text !== "t") return undefined;
  const [first] = call.arguments;
  if (!first || !ts.isStringLiteralLike(first)) return undefined;
  return first.text;
}

function tagName(node) {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.tagName.getText();
}

/** What renders a hint-named key: the primitive it sits in, or the loose tag. */
export function hintViolations(fileName, text) {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const key = keyOf(node);
      if (key && hintKey.test(key)) {
        let parent = node.parent;
        let verdict;
        while (parent && !verdict) {
          if (ts.isJsxAttribute(parent)) {
            const name = parent.name.getText();
            verdict = hostAttributes.has(name) ? "ok" : `attribute ${name}`;
          } else if (ts.isJsxElement(parent)) {
            const tag = tagName(parent);
            verdict = hostTags.has(tag) ? "ok" : `<${tag}>`;
          } else if (
            ts.isFunctionLike(parent) ||
            ts.isSourceFile(parent) ||
            ts.isVariableDeclaration(parent) ||
            ts.isReturnStatement(parent)
          ) {
            verdict = "elsewhere";
          }
          parent = parent.parent;
        }
        if (verdict && verdict !== "ok" && verdict !== "elsewhere") {
          const { line } = source.getLineAndCharacterOfPosition(
            node.getStart(),
          );
          found.push({ key, line: line + 1, host: verdict });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function collect() {
  const all = [];
  for (const path of walk(sourceRoot)) {
    if (!path.endsWith(".tsx")) continue;
    const name = relative(resolve("."), path).split("\\").join("/");
    for (const violation of hintViolations(name, readFileSync(path, "utf8")))
      all.push({ file: name, ...violation });
  }
  return all;
}

const signature = (item) => `${item.file} ${item.key} ${item.host}`;

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const current = collect();
  if (process.env.FOUNDRY_AUDIT_UPDATE === "1") {
    writeFileSync(
      baselinePath,
      `${JSON.stringify([...new Set(current.map(signature))].sort(), null, 2)}\n`,
    );
    console.log(`Hint baseline written with ${current.length} items.`);
    process.exit(0);
  }
  const baseline = new Set(JSON.parse(readFileSync(baselinePath, "utf8")));
  const now = new Set(current.map(signature));
  const added = current.filter((item) => !baseline.has(signature(item)));
  const fixed = [...baseline].filter((entry) => !now.has(entry));
  if (added.length || fixed.length) {
    console.error("Hint audit failed:");
    for (const item of added)
      console.error(
        `- ${item.file}:${item.line} renders ${item.key} in ${item.host}: use FieldHint, HelpHint, Alert, or a header description/help.`,
      );
    for (const entry of fixed)
      console.error(
        `- scripts/hint-baseline.json lists "${entry}", which is gone: run with FOUNDRY_AUDIT_UPDATE=1 to shrink the baseline.`,
      );
    process.exit(1);
  }
  console.log(`Hint audit passed with ${baseline.size} tracked items.`);
}
