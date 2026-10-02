import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatAttachment,
  ContractContent,
  ContractDraftInput,
  Issue,
  IssueContract,
} from "@bd777/foundry-protocol";
import {
  clarifyContract,
  confirmContract,
  retryClarification,
  discardContract,
  importLegacyContract,
  listContracts,
  saveContract,
  uploadMaterial,
} from "./evidence-api";
import { useEvidenceUpdates } from "./use-evidence-updates";
import { i18n } from "../../i18n";

/** Images up to 25 MiB, PDFs up to 32 MiB (what Claude reads), text 512 KiB. */
export function referenceSizeLimit(file: { name: string; type: string }) {
  if (file.type.startsWith("image/")) return 25 * 1024 * 1024;
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name))
    return 32 * 1024 * 1024;
  return 512 * 1024;
}

export function contractContent(contract: IssueContract): ContractContent {
  const { goal, inScope, outOfScope, constraints, criteria } = contract;
  return { goal, inScope, outOfScope, constraints, criteria };
}

export function useIssueContract(
  issue: Issue,
  onRefresh: (id: string) => void,
) {
  const [contracts, setContracts] = useState<IssueContract[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingText, setPendingText] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const pending = useRef<
    | {
        signature: string;
        key: string;
        draft: IssueContract;
        reference?: { input: ContractDraftInput; key: string };
      }
    | undefined
  >(undefined);
  const initialStarted = useRef(false);
  const lock = useRef(false);
  const latest = contracts[0];
  const draft = latest?.status === "draft" ? latest : undefined;
  const confirmed = contracts.find(
    (c) => c.revision === issue.currentContractRevision,
  );
  const terminal = issue.status === "accepted" || issue.status === "abandoned";
  // The clarification session answers the person's latest message after the
  // send returns; its state travels with the Issue.
  const replying = issue.clarification?.status === "replying";
  const replyFailure =
    issue.clarification?.status === "failed"
      ? issue.clarification.error || i18n.t("issueDetail:conversation.noReply")
      : "";
  const load = useCallback(async () => {
    const result = await listContracts(issue.id);
    setContracts(result.items);
  }, [issue.id]);
  useEvidenceUpdates(issue.id, load, setError);
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, [load, issue.currentContractRevision, issue.draftContractRevision]);

  const perform = async (action: () => Promise<unknown>) => {
    if (lock.current)
      throw new Error(i18n.t("issueDetail:contractErrors.busy"));
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      // A completed mutation must not become a failed send when only refresh fails.
      await load().catch(() =>
        setError(i18n.t("issueDetail:contractErrors.savedNotRefreshed")),
      );
      onRefresh(issue.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      lock.current = false;
      setBusy(false);
      setPendingText("");
    }
  };

  const send = async (
    text: string,
    selected = attachments,
    initial = false,
  ) => {
    if (!draft)
      throw new Error(i18n.t("issueDetail:contractErrors.amendFirst"));
    const message =
      text.trim() ||
      // i18n-ignore: the message the clarifying Agent receives for bare uploads
      "请阅读我上传的参考，帮助明确目标和完成标准。";
    const signature = JSON.stringify([message, selected.map((a) => a.id)]);
    await perform(async () => {
      setPendingText(message);
      let attempt = pending.current;
      if (!attempt || attempt.signature !== signature) {
        const added = selected.filter(
          (a) => !draft.goal.media.some((m) => m.materialId === a.id),
        );
        attempt = {
          signature,
          draft,
          key: initial
            ? `initial-clarification-${issue.id}`
            : crypto.randomUUID(),
          reference: added.length
            ? {
                input: {
                  baseRevision: draft.revision,
                  changeReason:
                    // i18n-ignore: contract history recorded on the server
                    "用户在主对话中提供参考材料；不是执行结果证据。",
                  content: {
                    ...contractContent(draft),
                    goal: {
                      ...draft.goal,
                      media: [
                        ...draft.goal.media,
                        ...added.map((a) => ({
                          materialId: a.id,
                          role: "context" as const,
                          caption: a.name,
                        })),
                      ],
                    },
                  },
                },
                key: crypto.randomUUID(),
              }
            : undefined,
        };
        // Capture the exact body before any write. Response loss must replay it,
        // even if SSE has already advanced the visible draft.
        pending.current = attempt;
      }
      if (attempt.reference) {
        attempt.draft = await saveContract(
          issue.id,
          attempt.reference.input,
          attempt.reference.key,
        );
        attempt.reference = undefined;
      }
      await clarifyContract(
        issue.id,
        attempt.draft,
        message,
        initial
          ? // i18n-ignore: clarification reason recorded on the server
            "根据原始输入开始澄清，不授权执行。"
          : // i18n-ignore: clarification reason recorded on the server
            `主对话补充：${message.slice(0, 1000)}`,
        attempt.key,
      );
      pending.current = undefined;
      setAttachments((items) =>
        items.filter((a) => !selected.some((s) => s.id === a.id)),
      );
    });
    return "replied" as const;
  };

  // Mount/reload is idempotent. Do not auto-run old Issues or confirmed work.
  useEffect(() => {
    if (
      initialStarted.current ||
      terminal ||
      !draft ||
      draft.revision !== 1 ||
      issue.run ||
      issue.messages?.length ||
      !["claude", "codex"].includes(issue.runtime)
    )
      return;
    try {
      if (
        sessionStorage.getItem(`foundry.initial-clarification:${issue.id}`) !==
        "pending"
      )
        return;
      sessionStorage.removeItem(`foundry.initial-clarification:${issue.id}`);
    } catch {
      return;
    }
    initialStarted.current = true;
    void send(issue.sourceInput, [], true).catch(() => {});
  }, [draft?.id, terminal]);

  const addAttachments = async (files: File[]) => {
    setUploading(true);
    setError("");
    try {
      for (const file of files) {
        const supported = [
          "image/png",
          "image/jpeg",
          "image/gif",
          "text/plain",
          "application/json",
          "application/pdf",
        ];
        if (
          !supported.includes(file.type) &&
          !/\.(txt|md|json|pdf)$/i.test(file.name)
        )
          throw new Error(
            i18n.t("issueDetail:contractErrors.unsupportedReference"),
          );
        if (file.size > referenceSizeLimit(file))
          throw new Error(
            i18n.t("issueDetail:contractErrors.referenceTooLarge"),
          );
        const material = await uploadMaterial(
          issue.id,
          file,
          file.type.startsWith("image/") ? "image" : "document",
          crypto.randomUUID(),
        );
        setAttachments((items) => [
          ...items,
          {
            id: material.id,
            name: material.name,
            path: "",
            mimeType: material.mimeType,
            size: material.byteSize,
            kind: "file",
          },
        ]);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  };

  return {
    contracts,
    draft,
    confirmed,
    latest,
    busy,
    error,
    replying,
    replyFailure,
    pendingText,
    attachments,
    uploading,
    send,
    addAttachments,
    removeAttachment: (id: string) =>
      setAttachments((items) => items.filter((a) => a.id !== id)),
    confirm: (exact: IssueContract) =>
      perform(() =>
        confirmContract(
          issue.id,
          exact,
          `confirm-${exact.id}-${exact.contentDigest}`,
        ),
      ),
    beginAmendment: () =>
      perform(async () => {
        if (!latest) {
          await importLegacyContract(issue.id, crypto.randomUUID());
          return;
        }
        await saveContract(
          issue.id,
          {
            baseRevision: latest.revision,
            content: contractContent(confirmed ?? latest),
            // i18n-ignore: contract history recorded on the server
            changeReason: "用户选择调整完成标准；保持旧版本待新草案确认。",
          },
          crypto.randomUUID(),
        );
      }),
    discard: () =>
      perform(() => {
        if (!draft)
          throw new Error(
            i18n.t("issueDetail:contractErrors.nothingToDiscard"),
          );
        return discardContract(
          issue.id,
          draft,
          // i18n-ignore: contract history recorded on the server
          "用户撤回本次标准调整，保留上一版已确认标准。",
          `discard-${draft.id}`,
        );
      }),
    retryInitial: () => send(issue.sourceInput, [], true),
    retryReply: () =>
      perform(() => retryClarification(issue.id, crypto.randomUUID())),
  };
}

export type IssueContractController = ReturnType<typeof useIssueContract>;
