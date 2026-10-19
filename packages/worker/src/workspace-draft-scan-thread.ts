/** Hashing project methods must not block the control connection's heartbeats. */
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import { materializeSessionSkills } from "./skill-materializer.js";
import type { SessionSkillRef } from "@bd777/foundry-protocol";
import type { WorkspaceDraftSkill } from "@bd777/foundry-protocol";
import { snapshotWorkspaceDrafts } from "./workspace-draft-skills.js";
const pending = new Map<string, Promise<WorkspaceDraftSkill[]>>();
export function scanWorkspaceDrafts(
  ...args: Parameters<typeof snapshotWorkspaceDrafts>
): Promise<WorkspaceDraftSkill[]> {
  return startScan(args);
}
export function scanWorkspaceDraftsFromRefs(
  args: Parameters<typeof snapshotWorkspaceDrafts>,
  refs: SessionSkillRef[],
  serverURL: string,
) {
  return startScan(args, { refs, serverURL });
}
function startScan(
  args: Parameters<typeof snapshotWorkspaceDrafts>,
  library?: { refs: SessionSkillRef[]; serverURL: string },
): Promise<WorkspaceDraftSkill[]> {
  const key = JSON.stringify([args, library]),
    known = pending.get(key);
  if (known) return known;
  const result = new Promise<WorkspaceDraftSkill[]>((resolve, reject) => {
    const thread = new Worker(new URL(import.meta.url), {
      workerData: { workspaceDraftArgs: args, library },
    });
    let answered = false;
    const timer = setTimeout(() => {
      void thread.terminate();
      reject(
        new Error(
          "Workspace draft scan timed out; reduce the draft package size and retry.",
        ),
      );
    }, 55000);
    thread.once(
      "message",
      (reply: { skills?: WorkspaceDraftSkill[]; error?: string }) => {
        answered = true;
        clearTimeout(timer);
        reply.error
          ? reject(new Error(reply.error))
          : resolve(reply.skills ?? []);
      },
    );
    thread.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    thread.once("exit", (code) => {
      clearTimeout(timer);
      if (!answered)
        reject(
          new Error(`Workspace draft scan ended without a result (${code}).`),
        );
    });
  });
  pending.set(key, result);
  void result
    .finally(() => {
      if (pending.get(key) === result) pending.delete(key);
    })
    .catch(() => {});
  return result;
}
if (!isMainThread && parentPort && workerData?.workspaceDraftArgs) {
  try {
    const args = workerData.workspaceDraftArgs as Parameters<
      typeof snapshotWorkspaceDrafts
    >;
    if (workerData.library)
      args[4] = await materializeSessionSkills(
        workerData.library.refs,
        workerData.library.serverURL,
        args[2],
      );
    parentPort.postMessage({ skills: await snapshotWorkspaceDrafts(...args) });
  } catch (error) {
    parentPort.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
