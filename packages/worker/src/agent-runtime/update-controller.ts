/** Provider-independent update state machine; no model inference. */
import { tryMaintainRuntime } from "./maintenance.js";
import {
  runtimeUpdateState,
  saveRuntimeUpdate,
  type RuntimeUpdateState,
} from "./state.js";
import { redactSecrets } from "../secret-redaction.js";

export interface UpdatePlan {
  current: string;
  target: string;
  sdkTarget?: string;
  needed: boolean;
  external?: string;
  /** Install a Foundry-managed copy even when the found one is the target. */
  managed?: boolean;
}
export interface AgentUpdateAdapter {
  id: string;
  inspect(): Promise<UpdatePlan | undefined>;
  update(plan: UpdatePlan): Promise<void>;
}
export interface UpdateDependencies {
  maintain: typeof tryMaintainRuntime;
  read: typeof runtimeUpdateState;
  write: typeof saveRuntimeUpdate;
  now: () => number;
  busy: () => boolean;
}
const defaults: UpdateDependencies = {
  maintain: tryMaintainRuntime,
  read: runtimeUpdateState,
  write: saveRuntimeUpdate,
  now: Date.now,
  busy: () => false,
};
export async function updateAgentRuntime(
  adapter: AgentUpdateAdapter,
  overrides: Partial<UpdateDependencies> = {},
): Promise<void> {
  const deps = { ...defaults, ...overrides };
  const previous = deps.read(adapter.id);
  if ((previous?.nextCheckAt ?? 0) > deps.now()) return;
  let state: RuntimeUpdateState = {
    ...previous,
    state: "checking",
    checkedAt: new Date(deps.now()).toISOString(),
  };
  const save = (change: Partial<RuntimeUpdateState>) => {
    state = { ...state, ...change };
    deps.write(adapter.id, state);
  };
  let release: (() => void) | undefined;
  try {
    save({ detail: undefined });
    const plan = await adapter.inspect();
    const nextCheckAt =
      deps.now() + 6 * 60 * 60_000 + Math.floor(Math.random() * 300_000);
    if (!plan) {
      save({
        state: "external",
        detail:
          "Runtime is not installed; automatic updates do not install new agents.",
        nextCheckAt,
      });
      return;
    }
    save({
      current: plan.current,
      target: plan.target,
      sdkTarget: plan.sdkTarget,
    });
    if (plan.external) {
      save({ state: "external", detail: plan.external, nextCheckAt });
      return;
    }
    if (!plan.needed) {
      save({
        state: "current",
        detail: undefined,
        failureCount: 0,
        nextCheckAt,
      });
      return;
    }
    release = await deps.maintain(adapter.id);
    if (!release) {
      save({
        state: "waiting_idle",
        detail: "Active agent work is still using this runtime.",
        nextCheckAt: deps.now() + 60_000,
      });
      return;
    }
    // Another controller may have activated the target while we discovered it.
    const latest = deps.read(adapter.id);
    if (
      latest?.state === "current" &&
      latest.target === plan.target &&
      latest.sdkTarget === plan.sdkTarget
    )
      return;
    if (deps.busy()) {
      save({
        state: "waiting_idle",
        detail: "Existing native or background processes are still active.",
        nextCheckAt: deps.now() + 60_000,
      });
      return;
    }
    save({ state: "updating", nextCheckAt: undefined });
    await adapter.update(plan);
    save({
      state: "current",
      failureCount: 0,
      current: plan.target,
      detail: undefined,
      nextCheckAt,
    });
  } catch (error) {
    save({
      state: "failed",
      detail: redactSecrets(String(error)).slice(0, 1000),
      failureCount: (previous?.failureCount ?? 0) + 1,
      nextCheckAt:
        deps.now() +
        Math.min(6 * 60, 30 * 2 ** Math.min(previous?.failureCount ?? 0, 4)) *
          60_000,
    });
  } finally {
    release?.();
  }
}
