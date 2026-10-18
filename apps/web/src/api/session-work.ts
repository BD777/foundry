import type {
  SessionWorkList,
  WorkControlInput,
  WorkOperation,
} from "@bd777/foundry-protocol";
import { request } from "./http";
export function listSessionWork(sessionId: string): Promise<SessionWorkList> {
  return request(
    "GET",
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/work`,
  );
}
export function controlSessionWork(
  sessionId: string,
  input: WorkControlInput,
): Promise<WorkOperation> {
  return request(
    "POST",
    `/api/agent-sessions/${encodeURIComponent(sessionId)}/work/operations`,
    { body: input },
  );
}
