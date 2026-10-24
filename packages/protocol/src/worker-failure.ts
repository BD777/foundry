/** Shared, side-effect-free Worker failure policy. No filesystem, UI or transport. */
export const workerFailurePolicies = {
  execution_host_stopped: { location: "device", recovery: "inspect_device" },
  disk_full: { location: "device", recovery: "free_space" },
  model_rate_limit: { location: "provider", recovery: "wait_for_quota" },
  skill_preparation_timeout: { location: "device", recovery: "check_skills" },
  turn_limit: { location: "runtime", recovery: "continue_turn" },
  unknown: { location: "unknown", recovery: "inspect_details" },
} as const;

export type WorkerFailureCode = keyof typeof workerFailurePolicies;
export interface WorkerFailure {
  version: 1;
  code: WorkerFailureCode;
  /** Bind diagnostics to a dispatch, never to an earlier turn of the chat. */
  inputId?: string;
}

export const executionHostStoppedError =
  "The execution host stopped. Its previous execution processes were stopped; retry explicitly to start a new execution.";

/** Only terminal errors belong here; never pass user/model prose or tool output. */
export function diagnoseWorkerFailure(error: string): WorkerFailure {
  let code: WorkerFailureCode = "unknown";
  if (error === executionHostStoppedError) code = "execution_host_stopped";
  else if (/\bENOSPC\b|\bno space left on device\b/i.test(error))
    code = "disk_full";
  else if (
    /user tpm rate limit exceeded|throttle by model gateway|rate_limit_exceeded/i.test(
      error,
    )
  )
    code = "model_rate_limit";
  else if (
    /Workspace draft scan timed out|Skill preparation timed out/i.test(error)
  )
    code = "skill_preparation_timeout";
  else if (/maximum number of turns(?:\s*\(\d+\))?/i.test(error))
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
    event.label === "Notice" &&
    event.level === "warning" &&
    /^Codex [\w.-]+ background inventory unavailable:.*\bENOSPC\b/s.test(
      event.detail,
    )
  );
}
