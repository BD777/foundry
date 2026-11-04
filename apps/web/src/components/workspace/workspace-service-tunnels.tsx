import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
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
} from "../../api";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { Button } from "../ui/button";
import { TextInput } from "../ui/field";
import { SelectMenu } from "../ui/select-menu";
import { RowMenu } from "../ui/row-menu";
import { Alert } from "../ui/alert";
import { cn } from "../../lib/cn";
import { ServiceNote } from "./service-note";

/** running: the device reports the port listening; idle: reachable but no
 * liveness report yet; off: nothing to open. */
function statusTone(item: ServiceTunnelView): "running" | "idle" | "off" {
  if (item.status !== "ready") return "off";
  return item.lastSeenAt ? "running" : "idle";
}

const autoFitColumns =
  "grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3.5";

/** A labelled control of the registration form. */
function TunnelField({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label className="grid min-w-0 gap-1.5 text-xs">
      {label}
      {children}
    </label>
  );
}

const dotTone = {
  running: "bg-success-text",
  idle: "bg-ink-muted",
  off: "bg-ink-faint",
} as const;

/**
 * One flat row: status dot, name over a muted fact line, actions. The
 * actions drop under the name when the row is narrow.
 */
function TunnelRow({
  actions,
  as: Component = "article",
  facts,
  name,
  tone,
  ...props
}: HTMLAttributes<HTMLElement> & {
  actions: ReactNode;
  as?: "article" | "div";
  facts: ReactNode;
  name: ReactNode;
  tone: keyof typeof dotTone;
}) {
  return (
    <Component
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-line pt-3 max-[520px]:grid-cols-[auto_minmax(0,1fr)]"
      {...props}
    >
      <span
        className={cn("size-2 rounded-full", dotTone[tone])}
        data-tone={tone}
        aria-hidden="true"
      />
      <div className="grid min-w-0 gap-0.5 wrap-anywhere">
        <strong className="text-md text-ink">{name}</strong>
        {facts}
      </div>
      <div className="flex flex-wrap items-center gap-2 max-[520px]:col-start-2">
        {actions}
      </div>
    </Component>
  );
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
    <section className="grid min-w-0 gap-3" aria-label={t("tunnels.title")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-md">{t("tunnels.title")}</h3>
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
        <ServiceNote role="status">
          {t(
            inventory.configured ? "tunnels.unrouted" : "tunnels.unconfigured",
          )}
        </ServiceNote>
      ) : null}
      {error ? (
        <Alert tone="error" title={t("tunnels.error")}>
          {error}
        </Alert>
      ) : null}
      {adding ? (
        <form
          className={autoFitColumns}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <ServiceNote className="col-span-full">
            {t("tunnels.note")}
          </ServiceNote>
          <TunnelField label={t("tunnels.listener")}>
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
          </TunnelField>
          {source ? null : (
            <TunnelField label={t("tunnels.port")}>
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
            </TunnelField>
          )}
          <TunnelField label={t("tunnels.name")}>
            <TextInput
              tone="boxed"
              value={name}
              required
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
          </TunnelField>
          <details className="col-span-full min-w-0 text-xs leading-[1.6] text-ink-muted wrap-anywhere">
            <summary className="w-fit cursor-pointer text-ink">
              {t("tunnels.advanced")}
            </summary>
            <div className={cn(autoFitColumns, "pt-2.5")}>
              <TunnelField label={t("tunnels.protocol")}>
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
              </TunnelField>
              <TunnelField label={t("tunnels.association")}>
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
              </TunnelField>
              <p className="col-span-full m-0">
                {t("tunnels.compatibilityNote")}
              </p>
            </div>
          </details>
          <ServiceNote className="col-span-full">
            {t("tunnels.privateNote")}
          </ServiceNote>
          <Button
            className="justify-self-start"
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
          <TunnelRow
            key={item.id}
            data-tunnel-id={item.id}
            tone={tone}
            name={item.name}
            facts={
              <ServiceNote as="span">
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
              </ServiceNote>
            }
            actions={
              <>
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
              </>
            }
          />
        );
      })}
      {inventory &&
      inventory.items.length === 0 &&
      !detected.length &&
      !adding ? (
        <ServiceNote>{t("tunnels.empty")}</ServiceNote>
      ) : null}
      {detected.length ? (
        <div
          className="grid min-w-0 gap-2 pt-2"
          role="group"
          aria-label={t("tunnels.detected")}
        >
          <h4 className="m-0 text-md">{t("tunnels.detected")}</h4>
          <ServiceNote>{t("tunnels.detectedNote")}</ServiceNote>
          {detected.map((found) => (
            <TunnelRow
              as="div"
              key={found.port}
              data-detected-port={found.port}
              tone="running"
              name={found.process || t("tunnels.unknownProcess")}
              facts={
                <ServiceNote as="span">
                  {t("tunnels.listeningOn", { port: found.port })}
                </ServiceNote>
              }
              actions={
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!!busy}
                  aria-busy={busy === `detected:${found.port}`}
                  onClick={() => void publish(found)}
                >
                  {t("tunnels.publish")}
                </Button>
              }
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
