import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ResourceInstance,
  ResourceOperationRecord,
} from "@bd777/foundry-protocol";
import { isAbortError, listResourceOperations } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { MutedText } from "../../components/ui/text";
import { EmptyState } from "../../components/ui/empty-state";
import { WorkspaceDialog } from "../../components/workspace/workspace-dialog";
import { navigateToChat } from "../../lib/in-app-navigation";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { Skeleton } from "../../components/ui/loading";

/** "x: 120, y: 48, text: 12": the server's summary of an operation's arguments. */
function argsText(args: ResourceOperationRecord["args"]): string {
  return Object.entries(args ?? {})
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join(", ");
}

/** The latest operations sessions ran on an instance (its audit). */
export function ResourceActivityDialog({
  instance,
  onClose,
}: {
  instance: ResourceInstance;
  onClose: () => void;
}) {
  const { t } = useTranslation("resources");
  const [operations, setOperations] = useState<ResourceOperationRecord[]>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setError("");
    listResourceOperations(instance.id, 50, { signal: controller.signal })
      .then((list) => {
        if (!cancelled) setOperations(list.operations);
      })
      .catch((cause: unknown) => {
        if (cancelled || isAbortError(cause)) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [instance.id, attempt]);

  const holderWorkspace = (sessionId: string) =>
    instance.holder?.sessionId === sessionId
      ? instance.holder.workspaceId
      : undefined;

  return (
    <WorkspaceDialog
      description={t("activity.description")}
      size="wide"
      title={t("activity.title", { name: instance.name })}
      onClose={onClose}
    >
      {error ? (
        <Alert tone="error" title={t("activity.failed")}>
          <p>{error}</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAttempt((count) => count + 1)}
          >
            {t("retry")}
          </Button>
        </Alert>
      ) : !operations ? (
        <Skeleton label={t("activity.loading")} rows={3} variant="rows" />
      ) : operations.length === 0 ? (
        <EmptyState
          title={t("activity.emptyTitle")}
          body={t("activity.emptyBody")}
        />
      ) : (
        <ol
          aria-label={t("activity.list", { name: instance.name })}
          className="fdy-res-ops grid min-w-0 divide-y divide-line-soft"
        >
          {operations.map((operation) => (
            <li
              className="fdy-res-op group/op grid min-w-0 gap-0.5 py-2"
              data-status={operation.status}
              key={operation.id}
            >
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-ink-muted">
                <strong className="font-mono text-xs text-ink">
                  {operation.op}
                </strong>
                <span className="text-ink group-data-[status=error]/op:text-error-text">
                  {operation.status === "ok"
                    ? t("activity.ok")
                    : operation.errorCode
                      ? t("activity.error", { code: operation.errorCode })
                      : t("activity.errorNoCode")}
                </span>
                <span>
                  {t("activity.duration", { ms: operation.durationMs })}
                </span>
                <time
                  dateTime={operation.startedAt}
                  title={fullWhen(operation.startedAt)}
                >
                  {relativeWhen(operation.startedAt)}
                </time>
                <Button
                  size="inline"
                  title={operation.sessionId}
                  variant="link"
                  onClick={() => {
                    onClose();
                    navigateToChat(
                      operation.sessionId,
                      holderWorkspace(operation.sessionId),
                    );
                  }}
                >
                  {t("activity.openSession")}
                </Button>
              </div>
              <MutedText className="fdy-res-meta leading-normal">
                {argsText(operation.args) || t("activity.noArgs")}
              </MutedText>
            </li>
          ))}
        </ol>
      )}
    </WorkspaceDialog>
  );
}
