import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { enforceAuditBaseline } from "./audit-baseline.mjs";

// Interface copy lives in src/i18n and reaches components through `t`. This
// audit finds copy written straight into components and helpers; the tracked
// debt may only shrink.

const sourceRoot = resolve("src");
const copyModule = resolve(sourceRoot, "i18n");
const copyAttributes = new Set([
  "aria-label",
  "title",
  "placeholder",
  "alt",
  "label",
  "description",
  "actionLabel",
  "ariaLabel",
  "detailLabel",
  "emptyLabel",
  "retryLabel",
  "confirmLabel",
  "body",
]);
const copyProperties = new Set([
  "label",
  "title",
  "message",
  "text",
  "summary",
  "description",
  "detail",
  "hint",
  "placeholder",
  "next",
  "statusLabel",
  "checks",
]);
const han = /[㐀-鿿]/;
const letters = /[A-Za-z㐀-鿿]/;

function listSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory())
      return path === copyModule ? [] : listSourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

/** English prose rather than an identifier, class name, path or code. */
function looksLikeEnglishCopy(text) {
  const value = text.trim();
  return (
    /[A-Za-z]/.test(value) &&
    (/\s/.test(value) || /^[A-Z][a-z]/.test(value)) &&
    !/^(fdy-|--|\/|\.|#|[a-z]+[-_][a-z])/.test(value) &&
    !/^[a-z][A-Za-z0-9]*$/.test(value)
  );
}

/** Inside a `{…}` of JSX, up to the nearest function. */
function inJsxExpression(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxExpression(parent)) return true;
    if (ts.isFunctionLike(parent) || ts.isSourceFile(parent)) return false;
  }
  return false;
}

/** An argument of a call that shows a message: setNotice, onNotice, setError… */
function messageArgument(node) {
  const call = node.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(node))
    return false;
  const name = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : ts.isIdentifier(call.expression)
      ? call.expression.text
      : "";
  return /notice$|^set\w*(Error|Feedback|Message|Status|Notice)$/i.test(name);
}

const failures = [];
for (const path of listSourceFiles(sourceRoot)) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const file = relative(sourceRoot, path);
  const lines = source.text.split("\n");
  // Text that is not interface copy (a prompt sent to an agent, a protocol
  // value) is marked on the line above: `// i18n-ignore: <reason>`.
  const ignored = (node) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line;
    return (
      /i18n-ignore: \S/.test(lines[line - 1] ?? "") ||
      /i18n-ignore: \S/.test(lines[line] ?? "")
    );
  };
  const report = (node, text, reason) =>
    ignored(node) ||
    failures.push({
      path: file,
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      reason,
      token: text.trim().replace(/\s+/g, " ").slice(0, 60),
    });
  const visit = (node) => {
    if (ts.isJsxText(node) && letters.test(node.text)) {
      report(node, node.text, "text in JSX");
    } else if (
      ts.isJsxAttribute(node) &&
      copyAttributes.has(node.name.getText()) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      letters.test(node.initializer.text)
    ) {
      report(node, node.initializer.text, `${node.name.getText()} attribute`);
    } else if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      han.test(node.text)
    ) {
      report(node, node.text, "Chinese text");
      return;
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      looksLikeEnglishCopy(node.text) &&
      (inJsxExpression(node) || messageArgument(node)) &&
      !ts.isJsxAttribute(node.parent) &&
      !ts.isImportDeclaration(node.parent)
    ) {
      report(node, node.text, "text in an expression");
    } else if (
      ts.isPropertyAssignment(node) &&
      copyProperties.has(node.name.getText()) &&
      (ts.isStringLiteral(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer)) &&
      looksLikeEnglishCopy(node.initializer.text)
    ) {
      report(node, node.initializer.text, `${node.name.getText()} property`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

enforceAuditBaseline({
  auditName: "copy",
  failureLabel: "Interface copy",
  failures,
  signature: (failure) => `${failure.path}|${failure.reason}|${failure.token}`,
});
