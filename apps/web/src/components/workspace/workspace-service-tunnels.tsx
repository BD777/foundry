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
 * liveness report yet; off: nothing to open. */
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
  // "auto" lets the Server pick https when the port answers TLS.
  const [protocol, setProtocol] = useState("auto");
  // A detected port ("18476") or "" for a port typed by hand.
  const [source, setSource] = useState("");
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
    setSource("");
    setProtocol("auto");
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
                targetWorkspaceId: workspaceId,
                visibility: "private",
                enabled: true,
              }
            : {
                name,
                port: Number(source || port),
                ...(protocol === "auto"
                  ? {}
                  : { protocol: protocol as "http" | "https" }),
                workId,
                targetWorkspaceId: workspaceId,
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
  const detected = inventory?.detected ?? [];
  const chosenPort = source || port;
  const listenerName = (found: DetectedService) =>
    found.process
      ? `${found.process} :${found.port}`
      : t("tunnels.portName", { port: found.port });
  return (
    <section className="fdy-service-tunnels" aria-label={t("tunnels.title")}>
      <div className="fdy-service-tunnels-heading">
        <h3>{t("tunnels.title")}</h3>
        {inventory?.canManage ? (
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={adding}
            onClick={() => {
              // Start from the first port found in this workspace, if any.
              const first = detected[0];
              if (!adding && first && !source && !port) {
                setSource(String(first.port));
                if (!name.trim()) setName(listenerName(first));
              }
              setAdding(!adding);
            }}
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
            {t("tunnels.listener")}
            <SelectMenu
              insideDialog
              ariaLabel={t("tunnels.listener")}
              value={source}
              onChange={(value) => {
                setSource(value);
                const found = detected.find((d) => String(d.port) === value);
                if (found && !name.trim()) setName(listenerName(found));
              }}
              options={[
                ...detected.map((found) => ({
                  value: String(found.port),
                  label: listenerName(found),
                })),
                { value: "", label: t("tunnels.otherPort") },
              ]}
            />
          </label>
          {source ? null : (
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
          )}
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
          <details className="fdy-service-tunnels-compat">
            <summary>{t("tunnels.advanced")}</summary>
            <div className="fdy-service-tunnels-advanced">
              <label>
                {t("tunnels.protocol")}
                <SelectMenu
                  insideDialog
                  ariaLabel={t("tunnels.protocol")}
                  value={protocol}
                  onChange={setProtocol}
                  options={[
                    { value: "auto", label: t("tunnels.protocolAuto") },
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
                    ...services.map((service) => ({
                      value: service.id,
                      label: service.title,
                    })),
                  ]}
                />
              </label>
              <p>{t("tunnels.compatibilityNote")}</p>
            </div>
          </details>
          <p className="fdy-workspace-services-note">
            {t("tunnels.privateNote")}
          </p>
          <Button
            type="submit"
            disabled={!!busy || !name.trim() || !chosenPort}
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
                          ...(item.visibility === "workspace"
                            ? {}
                            : {
                                confirm: {
                                  title: t("tunnels.shareTitle", {
                                    name: item.name,
                                  }),
                                  body: t("tunnels.shareBody", {
                                    port: item.port,
                                  }),
                                  action: t("tunnels.shareAction"),
                                },
                              }),
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
