import { useCallback, useState } from "react";
import type { ChatAttachment } from "@bd777/foundry-protocol";
import { uploadChatAttachments } from "../../api";
import { i18n } from "../../i18n";

export interface ChatAttachments {
  add: (files: File[]) => Promise<void>;
  attachments: ChatAttachment[];
  /** Empties the composer's attachments; an upload in flight still lands. */
  clear: () => void;
  remove: (id: string) => void;
  /** Drops the attachments a message just took with it. */
  removeSent: (sent: readonly ChatAttachment[]) => void;
  /** Forgets the attachments and any upload, as for another workspace. */
  reset: () => void;
  restore: (restored: ChatAttachment[]) => void;
  uploading: boolean;
}

/** The composer's uploaded attachments for the workspace's next message. */
export function useChatAttachments({
  notify,
  workspaceId,
}: {
  notify: (message: string) => Promise<void>;
  workspaceId: string;
}): ChatAttachments {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);

  const add = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0) {
        return;
      }
      if (!workspaceId) {
        await notify(i18n.t("chat:notices.attachNeedsWorkspace"));
        return;
      }
      try {
        setUploading(true);
        const uploaded = await uploadChatAttachments({ files, workspaceId });
        setAttachments((current) => [...current, ...uploaded]);
        const firstUpload = uploaded[0];
        await notify(
          uploaded.length === 1 && firstUpload
            ? i18n.t("chat:notices.attachedOne", { name: firstUpload.name })
            : i18n.t("chat:notices.attachedMany", { count: uploaded.length }),
        );
      } catch {
        await notify(i18n.t("chat:notices.attachFailed"));
      } finally {
        setUploading(false);
      }
    },
    [notify, workspaceId],
  );

  const remove = useCallback((id: string): void => {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== id),
    );
  }, []);

  const removeSent = useCallback((sent: readonly ChatAttachment[]): void => {
    const sentIds = new Set(sent.map((attachment) => attachment.id));
    setAttachments((current) =>
      current.filter((attachment) => !sentIds.has(attachment.id)),
    );
  }, []);

  const restore = useCallback((restored: ChatAttachment[]): void => {
    setAttachments((current) => {
      const existingIds = new Set(current.map((attachment) => attachment.id));
      const additions = restored.filter(
        (attachment) => !existingIds.has(attachment.id),
      );
      return additions.length > 0 ? [...current, ...additions] : current;
    });
  }, []);

  const clear = useCallback((): void => setAttachments([]), []);

  const reset = useCallback((): void => {
    setAttachments([]);
    setUploading(false);
  }, []);

  return {
    add,
    attachments,
    clear,
    remove,
    removeSent,
    reset,
    restore,
    uploading,
  };
}
