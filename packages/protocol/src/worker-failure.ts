/** Shared, side-effect-free Worker failure policy. No filesystem, UI or transport. */
import { processLabels } from "./process-labels.js";
import type { WorkerFailure, WorkerFailureCode } from "./contract.gen.js";
export type { WorkerFailure, WorkerFailureCode } from "./contract.gen.js";
export const workerFailurePolicies = {
  execution_host_stopped: { location: "device", recovery: "inspect_device" },
  disk_full: { location: "device", recovery: "free_space" },
  model_rate_limit: { location: "provider", recovery: "wait_for_quota" },
  model_quota_exhausted: { location: "provider", recovery: "restore_quota" },
  skill_preparation_timeout: { location: "device", recovery: "check_skills" },
  turn_limit: { location: "runtime", recovery: "continue_turn" },
  unknown: { location: "unknown", recovery: "inspect_details" },
} as const satisfies Record<WorkerFailureCode, unknown>;

export const executionHostStoppedError =
  "The execution host stopped. Its previous execution processes were stopped; retry explicitly to start a new execution.";

const modelQuotaText =
  /\b(?:insufficient|exceeded|exhausted)[ _-]*(?:quota|credits?)\b|\b(?:quota|credits?)[ _-]?(?:usage )?limit\b|\b(?:usage limit|quota exhausted|quota exceeded|credit balance|out of credits?)\b|\bupstream account quota\b|\bbilling(?:[ _-](?:error|limit|hard limit))?\b/i;
const modelRateLimitText =
  /user tpm rate limit exceeded|throttle by model gateway|rate_limit_(?:exceeded|error)|exceeded retry limit|too many requests/i;
const model429Text = /\b(?:status|http|error|code|api error)\D{0,12}429\b/i;
const modelContext =
  /\b(?:model|provider|gateway|tokenhub|anthropic|openai|claude|codex|quota|token)\b/i;
const quotaContext = /\b(?:quota|credit|billing)\b/i;

const quotaCodes = new Set([
  "billing_error",
  "billing_hard_limit_reached",
  "credit_balance_too_low",
  "insufficient_quota",
  "quota_exceeded",
  "quota_exhausted",
]);
const rateLimitCodes = new Set([
  "model_rate_limit",
  "rate_limit",
  "rate_limit_error",
  "rate_limit_exceeded",
  "tpm_rate_limit_exceeded",
]);

interface FailureSignals {
  codes: string[];
  statuses: string[];
  text: string[];
}

function normalizedCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * Reads only known structured error fields. It never stringifies an arbitrary
 * object, which could turn user/model prose or a large request body into a
 * failure signal.
 */
function collectFailureSignals(
  value: unknown,
  signals: FailureSignals,
  seen: Set<object>,
  depth = 0,
): void {
  if (typeof value === "string") {
    signals.text.push(value);
    return;
  }
  if (!value || typeof value !== "object" || depth > 3 || seen.has(value)) {
    return;
  }
  seen.add(value);
  const record = value as Record<string, unknown>;
  const add = (target: string[], field: string, item: unknown): void => {
    if (typeof item === "string" && item.trim()) {
      target.push(field === "status" ? item : normalizedCode(item));
    } else if (typeof item === "number" && Number.isFinite(item)) {
      target.push(String(item));
    }
  };
  for (const field of [
    "code",
    "type",
    "error",
    "errorCode",
    "error_code",
    "reason",
    "stop_reason",
  ]) {
    add(signals.codes, field, record[field]);
  }
  for (const field of [
    "status",
    "statusCode",
    "status_code",
    "httpStatus",
    "http_status",
    "error_status",
  ]) {
    add(signals.statuses, field, record[field]);
  }
  for (const field of ["message", "text", "detail", "result", "errors"]) {
    const item = record[field];
    if (typeof item === "string") signals.text.push(item);
    else if (Array.isArray(item)) {
      for (const entry of item) {
        if (typeof entry === "string") signals.text.push(entry);
      }
    }
  }
  for (const field of [
    "error",
    "cause",
    "details",
    "data",
    "response",
    "body",
  ]) {
    const item = record[field];
    if (item && typeof item === "object") {
      collectFailureSignals(item, signals, seen, depth + 1);
    }
  }
}

/** Only terminal errors belong here; never pass user/model prose or tool output. */
export function diagnoseWorkerFailure(error: unknown): WorkerFailure {
  const signals: FailureSignals = { codes: [], statuses: [], text: [] };
  collectFailureSignals(error, signals, new Set());
  const text = signals.text.join("\n");
  const structured429 = signals.statuses.some(
    (status) => status.trim() === "429",
  );
  const quotaCode = signals.codes.some((code) => quotaCodes.has(code));
  const rateCode = signals.codes.some((code) => rateLimitCodes.has(code));
  let code: WorkerFailureCode = "unknown";
  if (error === executionHostStoppedError) code = "execution_host_stopped";
  else if (/\bENOSPC\b|\bno space left on device\b/i.test(text))
    code = "disk_full";
  else if (
    quotaCode ||
    modelQuotaText.test(text) ||
    (structured429 && quotaContext.test(text))
  )
    code = "model_quota_exhausted";
  else if (
    rateCode ||
    modelRateLimitText.test(text) ||
    (structured429 && (modelContext.test(text) || signals.codes.length > 0)) ||
    (model429Text.test(text) && modelContext.test(text))
  )
    code = "model_rate_limit";
  else if (
    /Workspace draft scan timed out|Skill preparation timed out/i.test(text)
  )
    code = "skill_preparation_timeout";
  else if (/maximum number of turns(?:\s*\(\d+\))?/i.test(text))
    code = "turn_limit";
  return { version: 1, code };
}

/** Unknown versions/codes fall back to terminal-error classification. */
export function isWorkerFailure(value: unknown): value is WorkerFailure {
  if (!value || typeof value !== "object") return false;
  const failure = value as WorkerFailure;
  return (
    failure.version === 1 &&
    Object.hasOwn(workerFailurePolicies, failure.code) &&
    (failure.inputId === undefined || typeof failure.inputId === "string")
  );
}

/** A specific Worker-generated warning is evidence, not a proved crash cause. */
export function isWorkerDiskObservation(event: {
  label: string;
  level: string;
  detail: string;
}): boolean {
  return (
    event.label === processLabels.notice &&
    event.level === "warning" &&
    /^Codex [\w.-]+ background inventory unavailable:.*\bENOSPC\b/s.test(
      event.detail,
    )
  );
}
