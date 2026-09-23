import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatAttachment,
  ContractContent,
  ContractDraftInput,
  Issue,
  IssueContract,
} from "@foundry/protocol";
import {
  clarifyContract,
  confirmContract,
  discardContract,
  importLegacyContract,
  listContracts,
  saveContract,
  uploadMaterial,
} from "./evidence-api";
import { useEvidenceUpdates } from "./use-evidence-updates";

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
  const load = useCallback(async () => {
    const result = await listContracts(issue.id);
    setContracts(result.items);
  }, [issue.id]);
  useEvidenceUpdates(issue.id, load, setError);
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, [load, issue.currentContractRevision, issue.draftContractRevision]);

  const perform = async (action: () => Promise<unknown>) => {
    if (lock.current) throw new Error("上一项操作还在处理中，请稍候。");
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      // A completed mutation must not become a failed send when only refresh fails.
      await load().catch(() =>
        setError(
          "操作已保存，但页面暂时未能刷新。恢复连接后会自动更新，请勿重复提交。",
        ),
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
    if (!draft) throw new Error("请先发起标准调整，再讨论新的完成标准。");
    const message =
      text.trim() || "请阅读我上传的参考，帮助明确目标和完成标准。";
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
          ? "根据原始输入开始澄清，不授权执行。"
          : `主对话补充：${message.slice(0, 1000)}`,
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
        ];
        if (
          !supported.includes(file.type) &&
          !/\.(txt|md|json)$/i.test(file.name)
        )
          throw new Error(
            "本轮参考支持文本、JSON、PNG、JPEG 和 GIF；其他格式暂不能交给澄清 Agent。",
          );
        if (
          file.size >
          (file.type.startsWith("image/") ? 25 * 1024 * 1024 : 512 * 1024)
        )
          throw new Error("参考过大：图片最多 25 MiB，文本最多 512 KiB。");
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
            changeReason: "用户选择调整完成标准；保持旧版本待新草案确认。",
          },
          crypto.randomUUID(),
        );
      }),
    discard: () =>
      perform(() => {
        if (!draft) throw new Error("没有可撤回的草案。");
        return discardContract(
          issue.id,
          draft,
          "用户撤回本次标准调整，保留上一版已确认标准。",
          `discard-${draft.id}`,
        );
      }),
    retryInitial: () => send(issue.sourceInput, [], true),
  };
}

export type IssueContractController = ReturnType<typeof useIssueContract>;
