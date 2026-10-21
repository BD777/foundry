import { useTranslation } from "react-i18next";
import type {
  KnowledgeMutation,
  KnowledgeEntry,
} from "@bd777/foundry-protocol";
import { ConfirmButton } from "../../components/ui/confirm-button";

export function PendingKnowledgeWrites({
  jobs,
  vaultId,
  entries,
  busy,
  onForget,
  sourceState,
  sourceReason,
}: {
  jobs: KnowledgeMutation[];
  vaultId?: string;
  entries: KnowledgeEntry[];
  busy: boolean;
  onForget: (job: KnowledgeMutation) => Promise<void>;
  sourceState: (value: string) => string;
  sourceReason: (value: string) => string;
}) {
  const { t } = useTranslation("personalAgent");
  return (
    <>
      {jobs
        .filter(
          (job) =>
            job.vaultId === vaultId &&
            !["applied", "superseded"].includes(job.status),
        )
        .map((job) => (
          <div key={job.id}>
            <p role="status">
              {t("knowledge.pending", {
                title: job.title || t("knowledge.forget"),
                state: sourceState(job.status),
                reason: sourceReason(job.reason ?? ""),
              })}
            </p>
            {job.action !== "forget" &&
            !entries.some((entry) => entry.id === job.entryId) ? (
              <ConfirmButton
                size="sm"
                disabled={busy}
                confirmLabel={t("knowledge.forgetPendingConfirm")}
                onConfirm={() => void onForget(job)}
              >
                {t("knowledge.forgetPending")}
              </ConfirmButton>
            ) : null}
          </div>
        ))}
    </>
  );
}
