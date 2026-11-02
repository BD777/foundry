import type {
  NativeWorkInfo,
  SessionWork,
  WorkObservation,
  WorkSpec,
} from "@bd777/foundry-protocol";

/** A native task owns its identity and capabilities independently of Foundry controls. */
export interface NativeWorkTask {
  id: string;
  kind: SessionWork["kind"];
  title: string;
  native: NativeWorkInfo;
  spec?: WorkSpec;
  observation: Omit<WorkObservation, "confirmedRevision">;
}
export type NativeWorkSink = (task: NativeWorkTask) => void;
export function nativeWorkInfo(
  runtime: NativeWorkInfo["runtime"],
  version: string,
  sessionId: string,
  taskId: string,
  discovery: string,
  stop: NativeWorkInfo["controls"]["stop"] = "unavailable",
): NativeWorkInfo {
  return {
    runtime,
    version,
    sessionId,
    taskId,
    discovery,
    observation: "available",
    controls: { stop, pause: "unsupported", resume: "unsupported" },
  };
}

export interface NativeWorkController {
  inventoryError?(): string | undefined;
  inspect(id: string): WorkObservation["status"];
  canStop(id: string): boolean;
  stop(id: string): Promise<void>;
}
const controllers = new Map<string, NativeWorkController>();
export function registerNativeWorkController(
  sessionId: string,
  controller: NativeWorkController,
): () => void {
  controllers.set(sessionId, controller);
  return () => {
    if (controllers.get(sessionId) === controller)
      controllers.delete(sessionId);
  };
}
export function nativeWorkController(
  sessionId: string,
): NativeWorkController | undefined {
  return controllers.get(sessionId);
}
