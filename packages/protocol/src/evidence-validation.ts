import definitions from "./evidence-schema.json" with { type: "json" };
import type {
  ContractContent,
  IssueContract,
  MaterialSelector,
  Verification,
} from "./evidence.js";

type Schema = {
  $ref?: string;
  type?: string;
  const?: unknown;
  anyOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
};
const schemas = definitions as unknown as Record<string, Schema>;

/** Only the selected model and its referenced definitions, for structured prompts. */
export function evidenceModelSchema(
  name: keyof typeof definitions,
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === "string" && !selected[object.$ref]) {
      selected[object.$ref] = schemas[object.$ref];
      visit(schemas[object.$ref]);
    }
    Object.values(object).forEach(visit);
  };
  selected[name] = schemas[name];
  visit(schemas[name]);
  return selected;
}

/**
 * The same model as a self-contained standard JSON Schema, for providers that
 * constrain generation to a schema instead of trusting prose instructions.
 */
export function evidenceJSONSchema(
  name: keyof typeof definitions,
  omitProperties: string[] = [],
): Record<string, unknown> {
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) =>
        key === "$ref" && typeof entry === "string"
          ? [key, `#/$defs/${entry}`]
          : [key, rewrite(entry)],
      ),
    );
  };
  const bundle = rewrite(evidenceModelSchema(name)) as Record<
    string,
    Record<string, unknown>
  >;
  const root = { ...bundle[name] };
  if (omitProperties.length) {
    root.properties = Object.fromEntries(
      Object.entries((root.properties ?? {}) as Record<string, unknown>).filter(
        ([key]) => !omitProperties.includes(key),
      ),
    );
    root.required = ((root.required ?? []) as string[]).filter(
      (key) => !omitProperties.includes(key),
    );
  }
  return { ...root, $defs: bundle };
}

/** Strict wire validation: unknown fields and null arrays are errors. */
export function validateEvidenceModel(
  name: keyof typeof definitions,
  value: unknown,
): string[] {
  const errors = check(schemas[name]!, value, name, 0);
  if (errors.length) return errors;
  errors.push(...nestedSelectors(value));
  if (name === "ContractContent")
    errors.push(...validateContractContent(value as ContractContent));
  if (name === "IssueContract") {
    const contract = value as IssueContract;
    errors.push(
      ...validateContractContent(contract, contract.status === "confirmed"),
    );
    if (
      contract.status === "confirmed" &&
      (!contract.confirmation ||
        contract.confirmation.contentDigest !== contract.contentDigest ||
        !["user", "local_owner"].includes(contract.confirmation.actor.kind))
    )
      errors.push("Confirmed contract requires exact human confirmation");
    if (
      ["draft", "discarded"].includes(contract.status) &&
      contract.confirmation
    )
      errors.push("Unconfirmed draft cannot carry a confirmation");
  }
  if (name === "MaterialSelector")
    errors.push(...validateSelector(value as MaterialSelector));
  if (name === "Verification") {
    const v = value as Verification;
    if ((v.status === "completed") !== !!v.result)
      errors.push("Only completed verification has a result");
    if (v.mode === "deterministic" && v.executor.kind !== "program")
      errors.push("Deterministic verification requires program");
    if (v.mode === "agent" && v.executor.kind !== "agent")
      errors.push("Agent verification requires isolated agent");
    if (v.status === "failed" && !v.error)
      errors.push("Failed verification requires technical error");
  }
  return errors;
}
function nestedSelectors(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedSelectors);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const errors = [
    "text_lines",
    "page",
    "time_range",
    "image_region",
    "json_pointer",
  ].includes(String(object.kind))
    ? validateSelector(value as MaterialSelector)
    : [];
  return [...errors, ...Object.values(object).flatMap(nestedSelectors)];
}

function check(s: Schema, v: unknown, path: string, depth: number): string[] {
  if (depth > 80) return [`${path}: nesting limit exceeded`];
  if (s.$ref) return check(schemas[s.$ref]!, v, path, depth + 1);
  if (s.anyOf)
    return s.anyOf.some((b) => check(b, v, path, depth + 1).length === 0)
      ? []
      : [`${path}: invalid union variant`];
  if ("const" in s)
    return v === s.const
      ? []
      : [`${path}: expected ${JSON.stringify(s.const)}`];
  if (s.type === "object") {
    if (!v || typeof v !== "object" || Array.isArray(v))
      return [`${path}: expected object`];
    const object = v as Record<string, unknown>;
    const errors = (s.required ?? [])
      .filter((k) => !Object.hasOwn(object, k))
      .map((k) => `${path}.${k}: required`);
    for (const [k, value] of Object.entries(object)) {
      if (value === undefined && s.properties?.[k] && !s.required?.includes(k))
        continue;
      const field =
        s.properties?.[k] ??
        (typeof s.additionalProperties === "object"
          ? s.additionalProperties
          : undefined);
      if (!field) errors.push(`${path}.${k}: unknown field`);
      else errors.push(...check(field, value, `${path}.${k}`, depth + 1));
    }
    return errors;
  }
  if (s.type === "array")
    return Array.isArray(v)
      ? v.flatMap((x, i) => check(s.items!, x, `${path}[${i}]`, depth + 1))
      : [`${path}: expected array`];
  if (s.type === "string") {
    if (typeof v !== "string") return [`${path}: expected string`];
    if (s.minLength && !v.trim()) return [`${path}: empty string`];
    if (s.pattern && !new RegExp(s.pattern).test(v))
      return [`${path}: invalid format`];
  } else if (s.type === "boolean") {
    if (typeof v !== "boolean") return [`${path}: expected boolean`];
  } else if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    (s.type === "integer" && !Number.isSafeInteger(v)) ||
    (s.minimum !== undefined && v < s.minimum) ||
    (s.maximum !== undefined && v > s.maximum)
  ) {
    return [`${path}: invalid number`];
  }
  return [];
}

export function validateSelector(s: MaterialSelector): string[] {
  if (s.kind === "text_lines" && s.end < s.start)
    return ["Reversed line range"];
  if (s.kind === "time_range" && s.endMs <= s.startMs)
    return ["Empty or reversed time range"];
  if (
    s.kind === "image_region" &&
    (s.width <= 0 || s.height <= 0 || s.x + s.width > 1 || s.y + s.height > 1)
  )
    return ["Image region out of bounds"];
  if (s.kind === "json_pointer" && !/^(?:\/(?:[^~]|~[01])*)*$/.test(s.pointer))
    return ["Invalid JSON Pointer"];
  return [];
}

export function validateContractContent(
  content: ContractContent,
  confirming = false,
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  if (
    confirming &&
    (!content.goal.text.trim() || !content.criteria.some((c) => c.required))
  )
    errors.push(
      "Confirmation requires a goal and at least one required criterion",
    );
  for (const c of content.criteria) {
    if (ids.has(c.id)) errors.push(`Duplicate criterion ${c.id}`);
    ids.add(c.id);
    if (!c.statement.trim() || !c.rubric.text.trim())
      errors.push(`${c.id}: observable statement and rubric required`);
    if (c.proofKind === "other" && !c.proofKindLabel?.trim())
      errors.push(`${c.id}: proofKindLabel required`);
    if (!c.evidenceRequirements.length)
      errors.push(`${c.id}: evidence requirement required`);
    const requirements = new Set<string>();
    for (const r of c.evidenceRequirements) {
      if (requirements.has(r.id))
        errors.push(`${c.id}: duplicate requirement ${r.id}`);
      requirements.add(r.id);
      if (!r.acceptedCarriers.length)
        errors.push(`${c.id}: accepted carriers required`);
      if (
        c.evaluationMode === "deterministic" &&
        r.bindingPolicy !== "system_observed"
      )
        errors.push(`${c.id}: deterministic evidence must be system observed`);
    }
    if (c.evaluationMode === "agent" && c.checker)
      errors.push(`${c.id}: agent criterion cannot have checker`);
    if (c.checker?.configuration.kind === "command") {
      const config = c.checker.configuration;
      for (const path of [config.cwdRelativePath, config.entrypoint]) {
        if (
          !path ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path.split("/").includes("..")
        )
          errors.push(`${c.id}: unsafe checker path`);
      }
      if (!config.expectedExitCodes.length)
        errors.push(`${c.id}: expected exit codes required`);
    }
    for (const media of c.rubric.media)
      if (media.selector) errors.push(...validateSelector(media.selector));
  }
  for (const media of content.goal.media)
    if (media.selector) errors.push(...validateSelector(media.selector));
  return errors;
}
