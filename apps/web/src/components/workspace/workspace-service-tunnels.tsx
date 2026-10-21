import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ServiceTunnelList,
  ServiceTunnelView,
  SessionWork,
} from "@bd777/foundry-protocol";
import {
  listServiceTunnels,
  saveServiceTunnel,
} from "../../api/service-tunnels";
import { Button } from "../ui/button";
import { TextInput, Checkbox } from "../ui/field";
import { SelectMenu } from "../ui/select-menu";
import { Alert } from "../ui/alert";
import "./workspace-service-tunnels.css";

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
          onCount?.(result.items.length);
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
  async function save(item?: ServiceTunnelView, share?: boolean) {
    const current = epoch.current;
    setBusy(item?.id || "new");
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
  return (
    <section className="fdy-service-tunnels" aria-label={t("tunnels.title")}>
      <div className="fdy-service-tunnels-heading">
        <h3>{t("tunnels.title")}</h3>
        {inventory?.canManage ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAdding(!adding)}
          >
            {adding ? t("tunnels.cancel") : t("tunnels.register")}
          </Button>
        ) : null}
      </div>
      <p className="fdy-workspace-services-note">{t("tunnels.note")}</p>
      {inventory && !inventory.configured ? (
        <p role="status" className="fdy-workspace-services-note">
          {t("tunnels.status.preview_domain_unconfigured")}
        </p>
      ) : null}
      <details className="fdy-workspace-service-details">
        <summary>{t("tunnels.compatibility")}</summary>
        <p>{t("tunnels.compatibilityNote")}</p>
      </details>
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
          <Button
            type="submit"
            disabled={!!busy || !name.trim() || !port || !selectedTarget}
            aria-busy={busy === "new"}
          >
            {busy === "new" ? t("tunnels.saving") : t("tunnels.register")}
          </Button>
        </form>
      ) : null}
      {inventory?.items.map((item) => (
        <div
          className="fdy-service-tunnel-row"
          key={item.id}
          data-tunnel-id={item.id}
        >
          <strong>{item.name}</strong>
          <span className="fdy-workspace-services-note">
            {item.deviceLabel || item.deviceId} · {item.targetWorkspaceName} ·{" "}
            {item.protocol}://127.0.0.1:{item.port}
          </span>
          <span className="fdy-workspace-services-note">
            {t(`tunnels.status.${item.status}`)} ·{" "}
            {item.workId ? t("tunnels.linked") : t("tunnels.external")}
          </span>
          <div className="fdy-service-tunnels-actions">
            <Button
              size="sm"
              disabled={item.status !== "ready"}
              onClick={() =>
                window.open(item.url, "_blank", "noopener,noreferrer")
              }
            >
              {t("tunnels.open")}
            </Button>
            {item.canManage ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={!!busy}
                aria-busy={busy === item.id}
                onClick={() => void save(item)}
              >
                {item.enabled ? t("tunnels.disable") : t("tunnels.enable")}
              </Button>
            ) : null}
          </div>
          {item.canManage ? (
            <label className="fdy-service-tunnels-sharing">
              <Checkbox
                checked={item.visibility === "workspace"}
                disabled={!!busy}
                onChange={(event) => void save(item, event.target.checked)}
              />
              {t("tunnels.share")}
            </label>
          ) : (
            <span className="fdy-workspace-services-note">
              {t("tunnels.shared")}
            </span>
          )}
        </div>
      ))}
      {inventory && inventory.items.length === 0 && !adding ? (
        <p className="fdy-workspace-services-note">{t("tunnels.empty")}</p>
      ) : null}
    </section>
  );
}
