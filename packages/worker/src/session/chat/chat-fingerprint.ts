import { createHash } from "node:crypto";
import type { ChatThread } from "@bd777/foundry-protocol";

/** A chat's content: its time is its last activity, never a label. */
export function chatFingerprint(chat: ChatThread): string {
  return createHash("sha256").update(JSON.stringify(chat)).digest("hex");
}
