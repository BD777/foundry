import type { SessionFileRecord } from "@bd777/foundry-protocol";
import type { ConversationFileReference } from "../../components/conversation/conversation-types";
import type { ChatSessionFileItem } from "./chat-types";

/**
 * An answer's file links once the session's files are known. A file the
 * answer named before it existed links as an ordinary file as soon as the
 * session records one at its path (a background subagent wrote it, say);
 * until then it stays pending, read through the session that named it.
 */
export function settledFileReferences(
  references: ConversationFileReference[],
  recorded: ReadonlyMap<string, SessionFileRecord["op"]>,
  sessionId: string,
): ConversationFileReference[] {
  if (!references.some((reference) => reference.pending)) return references;
  return references.map((reference) => {
    if (!reference.pending) return reference;
    const op = recorded.get(reference.path);
    if (op && op !== "deleted") {
      const {
        pending: _pending,
        sessionId: _sessionId,
        ...settled
      } = reference;
      return settled;
    }
    return { ...reference, sessionId };
  });
}

/**
 * The side panel's row for a pending link no session file matches yet: read
 * through the ledger of the session that named it, so it shows the file if
 * it appeared some other way and says it does not exist yet otherwise.
 */
export function pendingSessionFile(
  reference: ConversationFileReference,
  sessionId: string,
  workspaceId: string,
): ChatSessionFileItem {
  return {
    id: reference.path,
    kind: "session-file",
    label:
      reference.path.split(/[\\/]/).filter(Boolean).pop() ?? reference.path,
    path: reference.path,
    origin: "reference",
    op: "referenced",
    inGitRepo: false,
    turnIds: [],
    sessionId,
    workspaceId,
    pending: true,
  };
}
