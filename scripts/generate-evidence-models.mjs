// Mechanical generation from the shared TS contract. No hand-maintained Go DTO drift.
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const file = ts.createSourceFile(
  "evidence.ts",
  readFileSync(resolve(root, "packages/protocol/src/evidence.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const declarations = new Map(
  file.statements
    .filter((n) => ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n))
    .map((n) => [n.name.text, n]),
);
const definitions = {};
const goTypes = new Map();
const goName = (s) =>
  s
    .replace(/(^|_)(\w)/g, (_, _p, c) => c.toUpperCase())
    .replace(/Id(s?)$/g, "ID$1")
    .replace(/Uri$/, "URI");
function properties(n) {
  const inherited = (n.heritageClauses ?? []).flatMap((h) =>
    h.types.flatMap((t) => properties(declarations.get(t.expression.text))),
  );
  return [...inherited, ...(n.members ?? [])];
}
function shape(members) {
  const props = {};
  const required = [];
  for (const p of members) {
    if (ts.isIndexSignatureDeclaration(p))
      return { type: "object", additionalProperties: schema(p.type) };
    props[p.name.text] = schema(p.type);
    if (!p.questionToken) required.push(p.name.text);
  }
  return {
    type: "object",
    properties: props,
    required,
    additionalProperties: false,
  };
}
function schema(n) {
  if (ts.isParenthesizedTypeNode(n)) return schema(n.type);
  if (ts.isTypeLiteralNode(n)) return shape(n.members);
  if (ts.isArrayTypeNode(n))
    return { type: "array", items: schema(n.elementType) };
  if (ts.isTypeReferenceNode(n)) {
    if (n.typeName.text === "Record")
      return {
        type: "object",
        additionalProperties: schema(n.typeArguments[1]),
      };
    return { $ref: n.typeName.text };
  }
  if (ts.isUnionTypeNode(n)) return { anyOf: n.types.map(schema) };
  if (ts.isLiteralTypeNode(n))
    return { const: JSON.parse(n.literal.getText(file)) };
  return {
    type: {
      [ts.SyntaxKind.StringKeyword]: "string",
      [ts.SyntaxKind.NumberKeyword]: "number",
      [ts.SyntaxKind.BooleanKeyword]: "boolean",
    }[n.kind],
  };
}
function fields(s, context) {
  return Object.entries(s.properties)
    .map(([name, type]) => {
      const optional = !s.required.includes(name);
      let mapped = goType(type, context + goName(name));
      if (
        optional &&
        !mapped.startsWith("[]") &&
        !mapped.startsWith("map[") &&
        mapped !== "any"
      )
        mapped = "*" + mapped;
      return `\t${goName(name)} ${mapped} \`json:"${name}${optional ? ",omitempty" : ""}"\``;
    })
    .join("\n");
}
function goType(s, context) {
  if (s.$ref) return s.$ref;
  if ("const" in s)
    return s.const === null
      ? "any"
      : typeof s.const === "number"
        ? "int"
        : typeof s.const === "boolean"
          ? "bool"
          : "string";
  if (s.anyOf) {
    // Variants that repeat the same shape (a field present in several union
    // members) describe one Go type, not a merged struct.
    const distinct = [
      ...new Map(s.anyOf.map((x) => [JSON.stringify(x), x])).values(),
    ];
    if (distinct.length === 1) return goType(distinct[0], context);
    if (s.anyOf.every((x) => x.type === "object" && x.properties)) {
      const properties = Object.assign({}, ...s.anyOf.map((x) => x.properties));
      const required = (s.anyOf[0].required ?? []).filter((k) =>
        s.anyOf.every((x) => (x.required ?? []).includes(k)),
      );
      for (const key of Object.keys(properties)) {
        const variants = s.anyOf.map((x) => x.properties[key]).filter(Boolean);
        if (variants.length > 1) properties[key] = { anyOf: variants };
      }
      return goType({ type: "object", properties, required }, context);
    }
    const variants = new Set(s.anyOf.map((x) => goType(x, context)));
    return variants.size === 1 ? [...variants][0] : "any";
  }
  if (s.type === "object" && s.properties) {
    goTypes.set(context, `type ${context} struct {\n${fields(s, context)}\n}`);
    return context;
  }
  if (s.type === "object")
    return "map[string]" + goType(s.additionalProperties, context + "Value");
  if (s.type === "array") return "[]" + goType(s.items, context + "Item");
  if (s.type === "integer") return "int";
  if (s.type === "number") return "float64";
  return { string: "string", boolean: "bool" }[s.type] ?? "any";
}
for (const [name, n] of declarations) {
  definitions[name] = ts.isInterfaceDeclaration(n)
    ? shape(properties(n))
    : schema(n.type);
}
// Wire constraints shared by both language validators.
function refine(s, name = "") {
  if (s.type === "number") {
    s.type = /^(x|y|width|height)$/.test(name) ? "number" : "integer";
    if (
      /^(revision|version|minimumCount|minimumAssertions|timeoutMs|maxEvidenceAgeSeconds|sequence|page|start|end)$/.test(
        name,
      )
    )
      s.minimum = 1;
    if (/^(byteSize|environmentRevision|startMs|endMs)$/.test(name))
      s.minimum = 0;
    if (/^(x|y|width|height)$/.test(name)) {
      s.minimum = 0;
      s.maximum = 1;
    }
  }
  if (
    s.type === "string" &&
    /^(id|materialId|criterionId|requirementId|title|statement|description|executable|targetName|name)$/.test(
      name,
    )
  )
    s.minLength = 1;
  if (s.properties)
    for (const [k, v] of Object.entries(s.properties)) refine(v, k);
  if (s.items) refine(s.items);
  if (s.anyOf) s.anyOf.forEach((x) => refine(x, name));
}
Object.values(definitions).forEach((s) => refine(s));
definitions.Digest = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" };
definitions.DateTime = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$",
};
// The schema validates wire discriminators; Go union structs are decoded only after validation.
for (const [name, s] of Object.entries(definitions)) {
  if (name === "JSONValue") {
    goTypes.set(name, "type JSONValue = any");
    continue;
  }
  if (name === "DateTime" || name === "Digest") {
    goTypes.set(name, `type ${name} = string`);
    continue;
  }
  const mapped = goType(s, name);
  if (mapped !== name) goTypes.set(name, `type ${name} = ${mapped}`);
}
const json = JSON.stringify(definitions, null, 2) + "\n";
const unionMarshal = [
  "MaterialSelector",
  "CheckConfiguration",
  "VerifierIdentity",
]
  .map(
    (name) =>
      `func (v ${name}) MarshalJSON() ([]byte, error) {
  type plain ${name}
  raw, err := json.Marshal(plain(v))
  if err != nil { return nil, err }
  return marshalEvidenceUnion("${name}", v.Kind, raw)
}`,
  )
  .join("\n\n");
const goSource =
  '// Code generated by scripts/generate-evidence-models.mjs; DO NOT EDIT.\npackage store\nimport "encoding/json"\n\n' +
  [...goTypes.values()].join("\n\n") +
  "\n\n" +
  unionMarshal +
  "\n";
const outputs = [
  ["packages/protocol/src/evidence-schema.json", json],
  ["apps/server/internal/store/evidence-schema.json", json],
  [
    "apps/server/internal/store/evidence_models_generated.go",
    execFileSync("gofmt", { input: goSource, encoding: "utf8" }),
  ],
  [
    "docs/evidence-and-verify-v1-fields.md",
    "# Evidence & Verify v1：完整字段清单\n\n" +
      "<!-- Generated by scripts/generate-evidence-models.mjs; edit the TS contract, not this file. -->\n\n" +
      "本清单从 `packages/protocol/src/evidence.ts` 生成，包含继承字段、嵌套类型与联合分支。业务约束、可信字段来源及支持范围见 [设计与实施说明](evidence-and-verify-v1.md)。`?` 为可省略；数组不可用 null 替代；所有时间为 UTC RFC3339；Digest 为 sha256 内容摘要。\n\n" +
      [...declarations]
        .map(([name, n]) => {
          if (ts.isTypeAliasDeclaration(n))
            return `## ${name}\n\n\`\`\`typescript\ntype ${name} = ${n.type.getText(file)};\n\`\`\`\n`;
          return (
            `## ${name}\n\n| 字段 | 类型 | 必填 |\n| --- | --- | --- |\n` +
            properties(n)
              .map(
                (p) =>
                  `| \`${p.name.text}\` | \`${p.type.getText(file).replace(/\s+/g, " ").replaceAll("|", "\\|")}\` | ${p.questionToken ? "否" : "是"} |`,
              )
              .join("\n") +
            "\n"
          );
        })
        .join("\n"),
  ],
];
for (const [name, content] of outputs) {
  const path = resolve(root, name);
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== content)
      throw new Error(`Stale generated file: ${name}`);
  } else writeFileSync(path, content);
}
