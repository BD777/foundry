import type {
  ArchiveBlocker,
  ArchiveChatsInput,
  WorkOperation,
} from "@bd777/foundry-protocol";
import {
  cancelAgentSession,
  controlSessionWork,
  getAgentSession,
  getChatLayout,
  listSessionWork,
  saveChatLayout,
} from "../../api";
import { i18n } from "../../i18n";

export interface ArchiveBlockerResolution {
  state: WorkOperation["state"];
  operationId?: string;
}
export function archiveBlockerKey(blocker: ArchiveBlocker): string {
  return [blocker.id, blocker.code, blocker.workId || blocker.workTitle].join(
    ":",
  );
}
export function canResolveArchiveBlocker(
  blocker: ArchiveBlocker,
  input: ArchiveChatsInput,
): boolean {
  switch (blocker.action) {
    case "stop_session":
      return Boolean(blocker.id);
    case "stop_work":
    case "unlink_work":
      return Boolean(blocker.workId && blocker.workSessionId);
    case "remove_from_folder":
      return Boolean(input.groupId);
    default:
      return false;
  }
}
export function archiveBlockerActionLabel(blocker: ArchiveBlocker): string {
  switch (blocker.action) {
    case "stop_session":
      return i18n.t("chat:archive.actionStopSession");
    case "stop_work":
      return i18n.t("chat:archive.actionStopWork");
    case "unlink_work":
      return i18n.t("chat:archive.actionUnlinkWork");
    case "remove_from_folder":
      return i18n.t("chat:archive.actionRemoveFromFolder");
    default:
      return i18n.t("chat:archive.actionUnavailable");
  }
}

/** Only an explicitly offered action is sent, and only verified receipts clear it. */
export async function resolveArchiveBlocker(
  blocker: ArchiveBlocker,
  input: ArchiveChatsInput,
): Promise<ArchiveBlockerResolution> {
  if (!canResolveArchiveBlocker(blocker, input))
    throw new Error(i18n.t("chat:archive.actionNotAllowed"));
  if (blocker.action === "stop_session") {
    const session = await cancelAgentSession(blocker.id);
    return {
      state: ["queued", "running"].includes(session.status)
        ? "pending"
        : "verified",
    };
  }
  if (blocker.action === "remove_from_folder") {
    const layout = await getChatLayout(input.workspaceId);
    const positions = layout.positions.map((position) =>
      position.chatId === blocker.id && position.groupId === input.groupId
        ? { ...position, groupId: "" }
        : position,
    );
    if (
      positions.some((position, index) => position !== layout.positions[index])
    )
      await saveChatLayout(input.workspaceId, { ...layout, positions });
    return { state: "verified" };
  }
  const operation = await controlSessionWork(blocker.workSessionId!, {
    id: blocker.workId,
    action: blocker.action === "unlink_work" ? "unlink" : "stop",
    ...(blocker.action === "unlink_work"
      ? { relatedSessionId: blocker.id }
      : {}),
    expectedRevision: blocker.workRevision,
    expectedReferenceRevision: blocker.workReferenceRevision,
    idempotencyKey: crypto.randomUUID(),
  });
  return { state: operation.state, operationId: operation.id };
}

export async function checkArchiveBlockerResolution(
  blocker: ArchiveBlocker,
  receipt: ArchiveBlockerResolution,
): Promise<ArchiveBlockerResolution> {
  if (receipt.state === "verified" || receipt.state === "failed")
    return receipt;
  if (blocker.action === "stop_session") {
    const session = await getAgentSession(blocker.id);
    return {
      state: ["queued", "running"].includes(session.status)
        ? "pending"
        : "verified",
    };
  }
  if (!blocker.workSessionId || !receipt.operationId) return receipt;
  const work = await listSessionWork(blocker.workSessionId);
  const current = (work.operations ?? []).find(
    (operation) => operation.id === receipt.operationId,
  );
  return current ? { ...receipt, state: current.state } : receipt;
}
