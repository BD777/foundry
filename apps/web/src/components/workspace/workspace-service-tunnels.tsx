import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DetectedService,
  ServiceTunnelList,
  ServiceTunnelView,
  SessionWork,
} from "@bd777/foundry-protocol";
import {
  listServiceTunnels,
  removeServiceTunnel,
  saveServiceTunnel,
} from "../../api/service-tunnels";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { Button } from "../ui/button";
import { TextInput } from "../ui/field";
import { SelectMenu } from "../ui/select-menu";
import { RowMenu } from "../ui/row-menu";
import { Alert } from "../ui/alert";
import "./workspace-service-tunnels.css";

/** running: the device reports the port listening; idle: reachable but no
 * liveness report (older Worker); off: nothing to open. */
function statusTone(item: ServiceTunnelView): "running" | "idle" | "off" {
  if (item.status !== "ready") return "off";
  return item.lastSeenAt ? "running" : "idle";
}

/** Registration observes an existing endpoint; it never starts or stops it. */
export function WorkspaceServiceTunnels({
  workspaceId,
  services,
  onCount,
}: {
  workspaceId: string;
  services: SessionWork[];
  onCount?: (count: number) => void;
}) {
  const { t } = useTranslation("workspaces");
  const [inventory, setInventory] = useState<ServiceTunnelList>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [protocol, setProtocol] = useState("http");
  const [targetWorkspaceId, setTargetWorkspaceId] = useState(workspaceId);
  const [workId, setWorkId] = useState("");
  const epoch = useRef(0);
  const inFlight = useRef<
    { epoch: number; promise: Promise<void> } | undefined
  >(undefined);
  const refresh = useCallback(async () => {
    const current = epoch.current;
    if (inFlight.current?.epoch === current) return inFlight.current.promise;
    const promise = (async () => {
      try {
        const result = await listServiceTunnels(workspaceId);
        if (
          !result ||
          !Array.isArray(result.items) ||
          !Array.isArray(result.targets)
        )
          throw new Error("Invalid service mapping inventory");
        if (current === epoch.current) {
          setInventory(result);
          onCount?.(result.items.length + (result.detected?.length ?? 0));
          setError("");
        }
      } catch (e) {
        if (current === epoch.current) setError(String(e));
      } finally {
        if (inFlight.current?.epoch === current) inFlight.current = undefined;
      }
    })();
    inFlight.current = { epoch: current, promise };
    return promise;
  }, [workspaceId, onCount]);
  useEffect(() => {
    epoch.current++;
    setInventory(undefined);
    setError("");
    setAdding(false);
    setBusy("");
    setName("");
    setPort("");
    setWorkId("");
    setTargetWorkspaceId(workspaceId);
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      epoch.current++;
      clearInterval(timer);
    };
  }, [refresh, workspaceId]);
  async function remove(item: ServiceTunnelView) {
    const current = epoch.current;
    setBusy(item.id);
    setError("");
    try {
      await removeServiceTunnel(workspaceId, item.id);
      if (current === epoch.current) await refresh();
    } catch (e) {
      if (current === epoch.current) setError(String(e));
    } finally {
      if (current === epoch.current) setBusy("");
    }
  }
  async function publish(found: DetectedService) {
    await save(undefined, undefined, {
      name: found.process
        ? `${found.process} :${found.port}`
        : t("tunnels.portName", { port: found.port }),
      port: found.port,
      key: `detected:${found.port}`,
    });
  }
  async function save(
    item?: ServiceTunnelView,
    share?: boolean,
    detected?: { name: string; port: number; key: string },
  ) {
    const current = epoch.current;
    setBusy(item?.id || detected?.key || "new");
    setError("");
    try {
      await saveServiceTunnel(
        workspaceId,
        item
          ? {
              name: item.name,
              port: item.port,
              protocol: item.protocol,
              workId: item.workId,
              targetWorkspaceId: item.targetWorkspaceId,
              visibility:
                share === undefined
                  ? item.visibility
                  : share
                    ? "workspace"
                    : "private",
              enabled: share === undefined ? !item.enabled : item.enabled,
              expectedRevision: item.revision,
            }
          : detected
            ? {
                name: detected.name.slice(0, 120),
                port: detected.port,
                protocol: "http",
                targetWorkspaceId: workspaceId,
                visibility: "private",
                enabled: true,
              }
            : {
                name,
                port: Number(port),
                protocol: protocol as "http" | "https",
                workId,
                targetWorkspaceId,
                visibility: "private",
                enabled: true,
              },
        item?.id,
      );
      if (current === epoch.current) {
        setAdding(false);
        if (inFlight.current?.epoch === current) await inFlight.current.promise;
        await refresh();
      }
    } catch (e) {
      if (current === epoch.current) setError(String(e));
    } finally {
      if (current === epoch.current) setBusy("");
    }
  }
  const selectedTarget = inventory?.targets.find(
    (target) => target.id === targetWorkspaceId,
  );
  const detected = inventory?.detected ?? [];
  return (
    <section className="fdy-service-tunnels" aria-label={t("tunnels.title")}>
      <div className="fdy-service-tunnels-heading">
        <h3>{t("tunnels.title")}</h3>
        {inventory?.canManage ? (
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={adding}
            onClick={() => setAdding(!adding)}
          >
            {adding ? t("tunnels.cancel") : t("tunnels.register")}
          </Button>
        ) : null}
      </div>
      {inventory && (!inventory.configured || !inventory.routed) ? (
        <p role="status" className="fdy-workspace-services-note">
          {t(
            inventory.configured ? "tunnels.unrouted" : "tunnels.unconfigured",
          )}
        </p>
      ) : null}
      {error ? (
        <Alert tone="error" title={t("tunnels.error")}>
          {error}
        </Alert>
      ) : null}
      {adding ? (
        <form
          className="fdy-service-tunnels-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="fdy-workspace-services-note">{t("tunnels.note")}</p>
          <label>
            {t("tunnels.name")}
            <TextInput
              tone="boxed"
              value={name}
              required
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t("tunnels.target")}
            <SelectMenu
              insideDialog
              ariaLabel={t("tunnels.target")}
              value={targetWorkspaceId}
              onChange={(value) => {
                setTargetWorkspaceId(value);
                setWorkId("");
              }}
              options={(inventory?.targets || []).map((target) => ({
                value: target.id,
                label: `${target.deviceLabel || target.deviceId} · ${target.name}`,
              }))}
            />
          </label>
          <label>
            {t("tunnels.port")}
            <TextInput
              tone="boxed"
              type="number"
              inputMode="numeric"
              min={1024}
              max={65535}
              value={port}
              required
              onChange={(event) => setPort(event.target.value)}
            />
          </label>
          <label>
            {t("tunnels.protocol")}
            <SelectMenu
              insideDialog
              ariaLabel={t("tunnels.protocol")}
              value={protocol}
              onChange={setProtocol}
              options={[
                { value: "http", label: "HTTP" },
                { value: "https", label: "HTTPS" },
              ]}
            />
          </label>
          <label>
            {t("tunnels.association")}
            <SelectMenu
              insideDialog
              ariaLabel={t("tunnels.association")}
              value={workId}
              onChange={setWorkId}
              options={[
                { value: "", label: t("tunnels.external") },
                ...services
                  .filter(
                    (service) => service.deviceId === selectedTarget?.deviceId,
                  )
                  .map((service) => ({
                    value: service.id,
                    label: service.title,
                  })),
              ]}
            />
          </label>
          <p className="fdy-workspace-services-note">
            {t("tunnels.privateNote")}
          </p>
          <details className="fdy-service-tunnels-compat">
            <summary>{t("tunnels.compatibility")}</summary>
            <p>{t("tunnels.compatibilityNote")}</p>
          </details>
          <Button
            type="submit"
            disabled={!!busy || !name.trim() || !port || !selectedTarget}
            aria-busy={busy === "new"}
          >
            {busy === "new" ? t("tunnels.saving") : t("tunnels.register")}
          </Button>
        </form>
      ) : null}
      {inventory?.items.map((item) => {
        const tone = statusTone(item);
        const seen = item.lastSeenAt
          ? t("tunnels.lastSeen", { when: relativeWhen(item.lastSeenAt) })
          : "";
        return (
          <article
            className="fdy-service-tunnel-row"
            key={item.id}
            data-tunnel-id={item.id}
          >
            <span
              className="fdy-service-tunnel-dot"
              data-tone={tone}
              aria-hidden="true"
            />
            <div className="fdy-service-tunnel-identity">
              <strong>{item.name}</strong>
              <span className="fdy-workspace-services-note">
                <span role="status">
                  {busy === item.id
                    ? t("tunnels.saving")
                    : t(
                        `tunnels.status.${tone === "idle" ? "available" : item.status}`,
                      )}
                </span>
                {" · "}
                {item.deviceLabel || item.deviceId}
                {item.targetWorkspaceId !== item.workspaceId
                  ? ` · ${item.targetWorkspaceName}`
                  : ""}{" "}
                · :{item.port}
                {seen && tone !== "running" ? (
                  <>
                    {" · "}
                    <span title={fullWhen(item.lastSeenAt)}>{seen}</span>
                  </>
                ) : null}
                {item.visibility === "workspace"
                  ? ` · ${t("tunnels.shared")}`
                  : ""}
              </span>
            </div>
            <div className="fdy-service-tunnels-actions">
              <Button
                size="sm"
                variant={tone === "off" ? "secondary" : "primary"}
                disabled={item.status !== "ready" || !item.url}
                onClick={() =>
                  window.open(item.url, "_blank", "noopener,noreferrer")
                }
              >
                {t("tunnels.open")}
              </Button>
              <RowMenu
                label={t("tunnels.actionsFor", { name: item.name })}
                disabled={!!busy}
                items={
                  item.canManage
                    ? [
                        {
                          key: "share",
                          label:
                            item.visibility === "workspace"
                              ? t("tunnels.unshare")
                              : t("tunnels.share"),
                          onSelect: () =>
                            void save(item, item.visibility !== "workspace"),
                        },
                        {
                          key: "access",
                          label: item.enabled
                            ? t("tunnels.disable")
                            : t("tunnels.enable"),
                          onSelect: () => void save(item),
                        },
                        {
                          key: "remove",
                          label: t("tunnels.remove"),
                          tone: "danger",
                          onSelect: () => void remove(item),
                          confirm: {
                            title: t("tunnels.removeTitle", {
                              name: item.name,
                            }),
                            body: t("tunnels.removeBody"),
                            action: t("tunnels.remove"),
                          },
                        },
                      ]
                    : []
                }
              />
            </div>
          </article>
        );
      })}
      {inventory &&
      inventory.items.length === 0 &&
      !detected.length &&
      !adding ? (
        <p className="fdy-workspace-services-note">{t("tunnels.empty")}</p>
      ) : null}
      {detected.length ? (
        <div
          className="fdy-service-tunnels-detected"
          role="group"
          aria-label={t("tunnels.detected")}
        >
          <h4>{t("tunnels.detected")}</h4>
          <p className="fdy-workspace-services-note">
            {t("tunnels.detectedNote")}
          </p>
          {detected.map((found) => (
            <div
              className="fdy-service-tunnel-row"
              key={found.port}
              data-detected-port={found.port}
            >
              <span
                className="fdy-service-tunnel-dot"
                data-tone="running"
                aria-hidden="true"
              />
              <div className="fdy-service-tunnel-identity">
                <strong>{found.process || t("tunnels.unknownProcess")}</strong>
                <span className="fdy-workspace-services-note">
                  {t("tunnels.listeningOn", { port: found.port })}
                </span>
              </div>
              <div className="fdy-service-tunnels-actions">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!!busy}
                  aria-busy={busy === `detected:${found.port}`}
                  onClick={() => void publish(found)}
                >
                  {t("tunnels.publish")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
