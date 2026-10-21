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
import { EmptyState } from "../ui/empty-state";
import { Panel, PanelHeader } from "../ui/panel";
import "./workspace-services.css";

/** Workspace inventory remains reachable after creator/consumer sessions end. */
export function WorkspaceServices({
  workspaceId,
  canControl = true,
  embedded = false,
}: {
  workspaceId: string;
  canControl?: boolean;
  embedded?: boolean;
}) {
  const { t } = useTranslation(["chat", "workspaces"]);
  const [items, setItems] = useState<SessionWork[]>();
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState("");
  const epoch = useRef(0);
  const inFlight = useRef<
    { epoch: number; promise: Promise<void> } | undefined
  >(undefined);
  const retry = useRef<
    { item: SessionWork; input: WorkControlInput } | undefined
  >(undefined);
  const refresh = useCallback(
    async (foreground = false) => {
      const current = epoch.current;
      if (foreground) setRefreshing(true);
      try {
        if (inFlight.current?.epoch !== current) {
          const promise = (async () => {
            try {
              const result = await listWorkspaceServices(workspaceId);
              if (!Array.isArray(result))
                throw new Error("Invalid workspace service inventory");
              if (current === epoch.current) {
                setItems(result);
                setLoadError("");
              }
            } catch (e) {
              if (current === epoch.current) setLoadError(String(e));
            } finally {
              if (inFlight.current?.epoch === current)
                inFlight.current = undefined;
            }
          })();
          inFlight.current = { epoch: current, promise };
        }
        await inFlight.current.promise;
      } finally {
        if (foreground && current === epoch.current) setRefreshing(false);
      }
    },
    [workspaceId],
  );
  useEffect(() => {
    epoch.current++;
    setItems(undefined);
    setError("");
    setLoadError("");
    setRefreshing(false);
    setBusy("");
    retry.current = undefined;
    void refresh(true);
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
  const Container = embedded ? "section" : Panel;
  return (
    <Container
      className={`fdy-workspace-services${embedded ? "" : " fdy-workspace-services-panel"}`}
      role="region"
      aria-label={t("work.workspaceServices")}
    >
      <PanelHeader>
        <div>
          {!embedded ? <h2>{t("workspaces:services")}</h2> : null}
          <p>{t("work.workspaceServicesNote")}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={refreshing}
          aria-busy={refreshing}
          onClick={() => void refresh(true)}
        >
          {refreshing ? t("work.refreshingServices") : t("work.refresh")}
        </Button>
      </PanelHeader>
      {!canControl ? (
        <p className="fdy-workspace-services-note">
          {t("work.servicesReadOnly")}
        </p>
      ) : null}
      {loadError ? (
        <Alert tone="error" title={t("work.loadFailed")}>
          {loadError}
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="error" title={t("work.controlFailed")}>
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
      {!items && !loadError ? (
        <p className="fdy-workspace-services-note" role="status">
          {t("work.loadingServices")}
        </p>
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
              <div className="fdy-workspace-service-identity">
                <strong>{item.title}</strong>
                <span role="status">
                  {busy === item.id ? t("work.applying") : statusLabel}
                </span>
              </div>
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
            <p className="fdy-workspace-services-note">
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
              <Alert tone="error" title={t("work.serviceStatusUnconfirmed")}>
                {item.observation.error}
              </Alert>
            ) : null}
            <details className="fdy-workspace-service-details">
              <summary>{t("work.serviceDetails")}</summary>
              <p>{t("work.serviceExecutionNote")}</p>
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
      {items?.length === 0 ? (
        <EmptyState
          title={t("work.noWorkspaceServices")}
          body={t("work.emptyServicesBody")}
        />
      ) : null}
    </Container>
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
      description=""
      onClose={onClose}
    >
      <WorkspaceServices
        workspaceId={workspaceId}
        canControl={canControl}
        embedded
      />
    </Dialog>
  );
}
