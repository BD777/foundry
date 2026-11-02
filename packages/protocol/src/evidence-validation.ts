import bundle from "./evidence-schema.json" with { type: "json" };
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type {
  ActorRef,
  ContractContent,
  IssueContract,
  MaterialSelector,
  Verification,
} from "./evidence.js";

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

/** A person, not an agent, daemon or the system: who may confirm or accept. */
export function isHumanActor(actor: ActorRef): boolean {
  return (
    actor.id !== "" && (actor.kind === "user" || actor.kind === "local_owner")
  );
}

/** Strict wire validation: unknown fields and null arrays are errors. */
export function validateEvidenceModel(
  name: EvidenceModelName,
  value: unknown,
): string[] {
  const validate = wireValidator(name);
  if (!validate(value))
    return (validate.errors ?? []).map((error) => {
      const field =
        error.params.additionalProperty ?? error.params.unevaluatedProperty;
      return `${name}${error.instancePath}: ${error.message}${field ? ` (${field})` : ""}`;
    });
  const errors: string[] = [];
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
        !isHumanActor(contract.confirmation.actor))
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
    // A deterministic criterion without its checker can never be verified;
    // confirming one would deadlock acceptance.
    if (confirming && c.evaluationMode === "deterministic" && !c.checker)
      errors.push(
        `${c.id}: deterministic criterion requires a runnable checker`,
      );
    const config = c.checker?.configuration;
    if (config?.kind === "command" || config?.kind === "project_command") {
      const paths =
        config.kind === "command"
          ? [config.cwdRelativePath, config.entrypoint]
          : [config.cwdRelativePath];
      for (const path of paths) {
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
      if (!config.executable.trim())
        errors.push(`${c.id}: checker executable required`);
    }
    for (const media of c.rubric.media)
      if (media.selector) errors.push(...validateSelector(media.selector));
  }
  for (const media of content.goal.media)
    if (media.selector) errors.push(...validateSelector(media.selector));
  return errors;
}
