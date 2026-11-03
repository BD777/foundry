import bundle from "./evidence-schema.json" with { type: "json" };
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
/** A model of contracts/evidence.openapi.yaml. */
export type EvidenceModelName = keyof typeof bundle.$defs;
type Schema = Record<string, unknown>;
const definitions = bundle.$defs as Record<string, Schema>;

/** Only the selected model and its referenced definitions, for structured prompts. */
export function evidenceModelSchema(
  name: EvidenceModelName,
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const object = value as Record<string, unknown>;
    const ref =
      typeof object.$ref === "string"
        ? object.$ref.replace("#/$defs/", "")
        : undefined;
    if (ref && !selected[ref]) {
      selected[ref] = definitions[ref];
      visit(definitions[ref]);
    }
    Object.values(object).forEach(visit);
  };
  selected[name] = definitions[name];
  visit(definitions[name]);
  return selected;
}

/**
 * The same model as a self-contained standard JSON Schema, for providers that
 * constrain generation to a schema instead of trusting prose instructions.
 * Unions are plain `anyOf` and only standard formats remain, which strict
 * provider modes accept.
 */
export function evidenceJSONSchema(
  name: EvidenceModelName,
  omitProperties: string[] = [],
): Record<string, unknown> {
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key, entry]) =>
            key !== "discriminator" &&
            !(key === "format" && entry === "non-blank"),
        )
        .map(([key, entry]) => [
          key === "oneOf" ? "anyOf" : key,
          rewrite(entry),
        ]),
    );
  };
  const bundled = rewrite(evidenceModelSchema(name)) as Record<string, Schema>;
  const root = { ...bundled[name] };
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
  return { ...root, $defs: bundled };
}

let ajv: Ajv2020 | undefined;
const validators = new Map<string, ValidateFunction>();
/** Ajv compiles each model on first use from the bundled document. */
function wireValidator(name: EvidenceModelName): ValidateFunction {
  if (!ajv) {
    ajv = new Ajv2020({
      allErrors: true,
      discriminator: true,
      // Unions and allOf records leave `type: object` to their variants and parts.
      strictTypes: false,
      formats: { "non-blank": (value: string) => value.trim() !== "" },
    });
    ajv.addSchema(bundle, "evidence");
  }
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile({ $ref: `evidence#/$defs/${name}` });
    validators.set(name, validate);
  }
  return validate;
}

/**
 * Strict wire validation against the schema: unknown fields and null arrays
 * are errors. Rules the schema cannot state (cross-field, confirmation,
 * checker and selector rules) are the server's alone; ask
 * POST /api/issues/{id}/contracts/validate to have them checked.
 */
export function validateEvidenceModel(
  name: EvidenceModelName,
  value: unknown,
): string[] {
  const validate = wireValidator(name);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => {
    const field =
      error.params.additionalProperty ?? error.params.unevaluatedProperty;
    return `${name}${error.instancePath}: ${error.message}${field ? ` (${field})` : ""}`;
  });
}
