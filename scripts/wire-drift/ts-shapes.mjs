// The TypeScript half of the wire drift report (scripts/wire-drift-report.mjs):
// what the worker declares it receives. For each daemon message the server
// sends, the type its handler casts the payload to (`envelope.payload as X`,
// followed one call deep); for each device REST call, the type argument of
// getJSON/postJSON/api. Recorded values are checked against those types with
// the worker's own type checker: unknown fields, missing required ones,
// other JSON types, null where the type has none.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const root = resolve(import.meta.dirname, "../..");

/** daemonMessageTypes key -> wire name, from the protocol source. */
export function messageTypeNames(
  source = readFileSync(
    resolve(root, "packages/protocol/src/daemon-messages.ts"),
    "utf8",
  ),
) {
  const body = source.slice(
    source.indexOf("export const daemonMessageTypes"),
    source.indexOf(
      "} as const",
      source.indexOf("export const daemonMessageTypes"),
    ),
  );
  const names = new Map();
  for (const [, key, value] of body.matchAll(/^\s*(\w+):\s*"([a-z_]+)"/gm))
    names.set(key, value);
  return names;
}

function workerProgram() {
  const configPath = resolve(root, "packages/worker/tsconfig.json");
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  if (!config) throw new Error(`cannot read ${configPath}`);
  return ts.createProgram({
    rootNames: config.fileNames,
    options: { ...config.options, noEmit: true },
  });
}

/**
 * The worker's declared shapes.
 * @returns {{ checker: import("typescript").TypeChecker,
 *   messages: Map<string, {type: import("typescript").Type, text: string, where: string}>,
 *   rest: Map<string, {type: import("typescript").Type, text: string, where: string}>,
 *   untyped: Map<string, string> }}
 *   messages: by wire type (server -> device); rest: by "METHOD /path"
 *   with path parameters as {} ; untyped: handlers whose payload has no cast.
 */
export function loadWorkerShapes() {
  const program = workerProgram();
  const checker = program.getTypeChecker();
  const names = messageTypeNames();
  const messages = new Map();
  const rest = new Map();
  const untyped = new Map();
  const workerSrc = resolve(root, "packages/worker/src");
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(workerSrc)) continue;
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        handlerCall(node);
        restCall(node);
      }
      ts.forEachChild(node, visit);
    };
    const where = (node) => {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      return `${file.fileName.slice(root.length + 1)}:${line + 1}`;
    };
    const handlerCall = (call) => {
      const callee = call.expression;
      if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "on")
        return;
      const [typeArg, handler] = call.arguments;
      if (
        !typeArg ||
        !handler ||
        !ts.isPropertyAccessExpression(typeArg) ||
        typeArg.expression.getText() !== "daemonMessageTypes"
      )
        return;
      const wire = names.get(typeArg.name.text);
      if (!wire) return;
      const cast = payloadCast(
        checker,
        resolveFunction(checker, handler),
        0,
        0,
      );
      if (!cast) {
        untyped.set(wire, where(call));
        return;
      }
      const declared = checker.getTypeFromTypeNode(cast);
      messages.set(wire, {
        type: withoutUndefined(checker, declared),
        // `X | undefined`: the worker takes an envelope without a payload.
        optional:
          declared.isUnion() &&
          declared.types.some((t) => t.flags & ts.TypeFlags.Undefined),
        text: cast.getText(),
        where: where(cast),
      });
    };
    const restCall = (call) => {
      const callee = call.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (!["getJSON", "postJSON", "api"].includes(name)) return;
      if (!call.typeArguments?.length) return;
      const pathIndex = call.arguments.findIndex((arg) =>
        literalText(arg)?.startsWith("/api/"),
      );
      if (pathIndex < 0) return;
      const path = literalText(call.arguments[pathIndex]).split("?")[0];
      const method =
        name === "getJSON"
          ? "GET"
          : name === "postJSON"
            ? "POST"
            : call.arguments.length > pathIndex + 1
              ? "POST"
              : "GET";
      const typeNode = call.typeArguments[0];
      rest.set(`${method} ${path}`, {
        type: checker.getTypeFromTypeNode(typeNode),
        text: typeNode.getText(),
        where: where(typeNode),
      });
    };
    visit(file);
  }
  return { checker, messages, rest, untyped };
}

/** A string or template literal's text, `${…}` as {}. */
function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans.map((span) => "{}" + span.literal.text).join("")
    );
  return undefined;
}

function resolveFunction(checker, node) {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node))
    return undefined;
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias)
    symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) return undefined;
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration)
  )
    return declaration;
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  )
    return declaration.initializer;
  return undefined;
}

/**
 * The type node of `<param>.payload as X` in fn, where param is its
 * parameter at index; else the declared type of the parameter fn hands
 * `<param>.payload` to; else the same in a function fn hands the parameter
 * to, one call deep.
 */
function payloadCast(checker, fn, index, depth) {
  const param = fn?.parameters?.[index];
  if (!param || !ts.isIdentifier(param.name) || !fn.body) return undefined;
  const name = param.name.text;
  let found;
  const calls = [];
  const visit = (node) => {
    if (found) return;
    if (ts.isAsExpression(node) && readsPayload(node.expression, name)) {
      found = node.type;
      return;
    }
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  if (found || depth >= 1) return found;
  for (const call of calls) {
    // The payload handed to a function: its parameter's declared type.
    const given = call.arguments.findIndex((arg) => readsPayload(arg, name));
    const typed = resolveFunction(checker, call.expression)?.parameters?.[given]
      ?.type;
    if (given >= 0 && typed) return typed;
  }
  for (const call of calls) {
    const at = call.arguments.findIndex(
      (arg) => ts.isIdentifier(arg) && arg.text === name,
    );
    if (at < 0) continue;
    const cast = payloadCast(
      checker,
      resolveFunction(checker, call.expression),
      at,
      depth + 1,
    );
    if (cast) return cast;
  }
  return undefined;
}

/** `<name>.payload`, or `(<name>.payload ?? {})` and the like. */
function readsPayload(expression, name) {
  while (ts.isParenthesizedExpression(expression))
    expression = expression.expression;
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  )
    expression = expression.left;
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "payload" &&
    expression.expression.getText() === name
  );
}

function withoutUndefined(checker, type) {
  if (!type.isUnion()) return type;
  const kept = type.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined));
  return kept.length === 1 ? kept[0] : type;
}

const isPlaceholder = (value) =>
  typeof value === "string" && value.startsWith("‹");

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeOfProperty(checker, symbol) {
  return checker.getTypeOfSymbol
    ? checker.getTypeOfSymbol(symbol)
    : checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration);
}

/** Whether a value of this JSON type could be of type t at all. */
function compatible(checker, t, value) {
  const f = t.flags;
  if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  switch (jsonType(value)) {
    case "null":
      return Boolean(f & ts.TypeFlags.Null);
    case "string":
      return Boolean(f & ts.TypeFlags.StringLike);
    case "integer":
    case "number":
      return Boolean(f & ts.TypeFlags.NumberLike);
    case "boolean":
      return Boolean(f & ts.TypeFlags.BooleanLike);
    case "array":
      return checker.isArrayType(t) || checker.isTupleType(t);
    case "object":
      return (
        Boolean(f & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) &&
        !checker.isArrayType(t) &&
        !checker.isTupleType(t)
      );
  }
  return false;
}

/**
 * Checks a JSON value against a TypeScript type.
 * @returns {{kind: string, path: string, detail?: string}[]}
 */
export function checkTs(checker, type, value, path = "payload", depth = 0) {
  const issues = [];
  const add = (kind, detail, at = path) =>
    issues.push(detail ? { kind, path: at, detail } : { kind, path: at });
  if (depth > 24) return issues;
  const f = type.flags;
  if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return issues;
  const text = () => checker.typeToString(type);
  if (type.isUnion()) {
    const members = type.types.filter(
      (t) => !(t.flags & ts.TypeFlags.Undefined),
    );
    const fitting = members.filter((t) => compatible(checker, t, value));
    if (fitting.length === 0) {
      add(value === null ? "null" : "type", `${jsonType(value)} for ${text()}`);
      return issues;
    }
    if (
      fitting.every(
        (t) => t.isLiteral() || t.flags & ts.TypeFlags.BooleanLiteral,
      )
    ) {
      if (
        typeof value === "boolean" ||
        isPlaceholder(value) ||
        fitting.some((t) => t.value === value)
      )
        return issues;
      add("type", `${JSON.stringify(value)} for ${text()}`);
      return issues;
    }
    let best;
    for (const member of fitting) {
      const found = checkTs(checker, member, value, path, depth + 1);
      if (!best || found.length < best.length) best = found;
      if (found.length === 0) break;
    }
    return best;
  }
  if (!compatible(checker, type, value)) {
    add(value === null ? "null" : "type", `${jsonType(value)} for ${text()}`);
    return issues;
  }
  if (type.isLiteral() && !isPlaceholder(value) && type.value !== value) {
    add("type", `${JSON.stringify(value)} for ${text()}`);
    return issues;
  }
  if (Array.isArray(value)) {
    const [element] = checker.isArrayType(type)
      ? checker.getTypeArguments(type)
      : [undefined];
    if (element)
      for (const item of value)
        issues.push(...checkTs(checker, element, item, `${path}[]`, depth + 1));
    return issues;
  }
  if (value === null || typeof value !== "object") return issues;
  const properties = new Map(
    checker.getPropertiesOfType(type).map((p) => [p.name, p]),
  );
  const index = checker
    .getIndexInfosOfType(type)
    .find((info) => info.keyType.flags & ts.TypeFlags.String);
  for (const [name, child] of Object.entries(value)) {
    const property = properties.get(name);
    if (property) {
      issues.push(
        ...checkTs(
          checker,
          typeOfProperty(checker, property),
          child,
          `${path}.${name}`,
          depth + 1,
        ),
      );
    } else if (index) {
      issues.push(
        ...checkTs(checker, index.type, child, `${path}{}`, depth + 1),
      );
    } else {
      add("unknown", undefined, `${path}.${name}`);
    }
  }
  for (const [name, property] of properties) {
    if (name in value || property.flags & ts.SymbolFlags.Optional) continue;
    const propertyType = typeOfProperty(checker, property);
    if (
      propertyType.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Undefined)
    )
      continue;
    if (
      propertyType.isUnion() &&
      propertyType.types.some((t) => t.flags & ts.TypeFlags.Undefined)
    )
      continue;
    add("missing", checker.typeToString(propertyType), `${path}.${name}`);
  }
  return issues;
}
