import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ResourceInstance,
  ResourceOperationRecord,
} from "@bd777/foundry-protocol";
import { isAbortError, listResourceOperations } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { WorkspaceDialog } from "../../components/workspace/workspace-dialog";
import { navigateToChat } from "../../lib/in-app-navigation";
import { fullWhen, relativeWhen } from "../../lib/relative-time";

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
        <p className="fdy-res-status" role="status">
          {t("activity.loading")}
        </p>
      ) : operations.length === 0 ? (
        <EmptyState
          title={t("activity.emptyTitle")}
          body={t("activity.emptyBody")}
        />
      ) : (
        <ol
          aria-label={t("activity.list", { name: instance.name })}
          className="fdy-res-ops"
        >
          {operations.map((operation) => (
            <li
              className="fdy-res-op"
              data-status={operation.status}
              key={operation.id}
            >
              <div className="fdy-res-op-head">
                <strong>{operation.op}</strong>
                <span className="fdy-res-op-status">
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
              <p className="fdy-res-meta">
                {argsText(operation.args) || t("activity.noArgs")}
              </p>
            </li>
          ))}
        </ol>
      )}
    </WorkspaceDialog>
  );
}
