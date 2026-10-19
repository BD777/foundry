import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  SessionWork,
  WorkAction,
  WorkControlInput,
} from "@bd777/foundry-protocol";
import {
  listWorkspaceServices,
  controlWorkspaceService,
} from "../../api/session-work";
import { workActions, needsConfirmation } from "../../lib/session-work-state";
import { navigateToChat } from "../../lib/in-app-navigation";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { RowMenu } from "../ui/row-menu";
import { WorkStatusIcon } from "../work/work-status-icon";
import { Alert } from "../ui/alert";

/** Workspace inventory remains reachable after creator/consumer sessions end. */
export function WorkspaceServices({
  workspaceId,
  canControl = true,
  showDescription = true,
}: {
  workspaceId: string;
  canControl?: boolean;
  showDescription?: boolean;
}) {
  const { t } = useTranslation("chat");
  const [items, setItems] = useState<SessionWork[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const epoch = useRef(0);
  const retry = useRef<
    { item: SessionWork; input: WorkControlInput } | undefined
  >(undefined);
  const refresh = useCallback(async () => {
    const current = epoch.current;
    try {
      const result = await listWorkspaceServices(workspaceId);
      if (!Array.isArray(result))
        throw new Error("Invalid workspace service inventory");
      if (current === epoch.current) setItems(result);
    } catch (e) {
      if (current === epoch.current) setError(String(e));
    }
  }, [workspaceId]);
  useEffect(() => {
    epoch.current++;
    setItems(undefined);
    setError("");
    setBusy("");
    retry.current = undefined;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      epoch.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  async function control(item: SessionWork, action: WorkAction) {
    const current = epoch.current;
    const input =
      retry.current?.item.id === item.id &&
      retry.current.input.action === action &&
      retry.current.input.expectedRevision === item.revision &&
      retry.current.input.expectedReferenceRevision === item.referenceRevision
        ? retry.current.input
        : {
            id: item.id,
            action,
            expectedRevision: item.revision,
            expectedReferenceRevision: item.referenceRevision,
            idempotencyKey: crypto.randomUUID(),
          };
    retry.current = { item, input };
    setBusy(item.id);
    setError("");
    try {
      await controlWorkspaceService(workspaceId, item.id, input);
      if (current !== epoch.current) return;
      retry.current = undefined;
      await refresh();
    } catch (e) {
      if (current === epoch.current) setError(String(e));
    } finally {
      if (current === epoch.current) setBusy("");
    }
  }
  return (
    <section
      className="fdy-workspace-services"
      aria-label={t("work.workspaceServices")}
    >
      {showDescription ? <p>{t("work.workspaceServicesNote")}</p> : null}
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          setError("");
          void refresh();
        }}
      >
        {t("work.refresh")}
      </Button>
      {error ? (
        <Alert
          tone="error"
          title={t(retry.current ? "work.controlFailed" : "work.loadFailed")}
        >
          {error}
          {retry.current ? (
            <Button
              size="sm"
              variant="link"
              disabled={Boolean(busy)}
              onClick={() =>
                void control(
                  retry.current!.item,
                  retry.current!.input.action as WorkAction,
                )
              }
            >
              {t("work.retryControl")}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {!items && !error ? (
        <p role="status">{t("work.loadingServices")}</p>
      ) : null}
      {items?.map((item) => {
        const pending = needsConfirmation(item);
        const statusLabel = pending
          ? t("work.pending")
          : t(`work.status.${item.observation.status}`);
        const count =
          (item.sharedSessionCount ?? item.relatedSessionIds?.length ?? 0) + 1;
        return (
          <article
            key={item.id}
            className="fdy-workspace-service-row"
            data-service-id={item.id}
          >
            <div className="fdy-workspace-service-heading">
              <WorkStatusIcon
                kind="process"
                status={pending ? "pending" : item.observation.status}
                label={`${t("work.service")} · ${statusLabel}`}
              />
              <strong>{item.title}</strong>
              <RowMenu
                label={t("work.actionsFor", { title: item.title })}
                disabled={Boolean(busy)}
                items={
                  canControl
                    ? workActions(item).map((action) => ({
                        key: action,
                        label: t(`work.action.${action}`),
                        onSelect: () => void control(item, action),
                        ...(count > 1 &&
                        ["stop", "pause", "resume"].includes(action)
                          ? {
                              confirm: {
                                title: t("work.sharedActionTitle", {
                                  action: t(`work.action.${action}`),
                                }),
                                body: t("work.sharedActionBody", { count }),
                                action: t(`work.action.${action}`),
                              },
                            }
                          : {}),
                      }))
                    : []
                }
              />
            </div>
            <p>
              {count > 1
                ? t("work.sharedService", { count })
                : t("work.workspaceOwnedService")}
            </p>
            <Button
              variant="link"
              size="sm"
              onClick={() => navigateToChat(item.sessionId, item.workspaceId)}
            >
              {t("work.creatorSession")}
            </Button>
            {item.observation.error ? (
              <p role="status">{item.observation.error}</p>
            ) : null}
            <details>
              <summary>{t("work.serviceDetails")}</summary>
              <p>
                {t("work.identity")}: <code>{item.id}</code>
              </p>
              <pre>{item.spec.argv?.join(" ")}</pre>
              {item.relatedSessionIds?.map((id) => (
                <Button
                  key={id}
                  size="sm"
                  variant="link"
                  onClick={() => navigateToChat(id, item.workspaceId)}
                >
                  {id}
                </Button>
              ))}
            </details>
          </article>
        );
      })}
      {items?.length === 0 ? <p>{t("work.noWorkspaceServices")}</p> : null}
    </section>
  );
}
export function WorkspaceServicesDialog({
  workspaceId,
  onClose,
  canControl = true,
}: {
  workspaceId: string;
  onClose: () => void;
  canControl?: boolean;
}) {
  const { t } = useTranslation("chat");
  return (
    <Dialog
      title={t("work.workspaceServices")}
      description={t("work.workspaceServicesNote")}
      onClose={onClose}
    >
      <WorkspaceServices
        workspaceId={workspaceId}
        canControl={canControl}
        showDescription={false}
      />
    </Dialog>
  );
}
