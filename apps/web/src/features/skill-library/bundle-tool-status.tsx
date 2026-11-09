import { FieldHint } from "../../components/ui/field";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  BundleDeviceVersion,
  DeviceProjection,
  DeviceTool,
  SkillBundleTool,
  SkillRepository,
} from "@bd777/foundry-protocol";
import {
  bundleDeviceStatus,
  bundleDeviceStatusLabel,
  deviceSkillsText,
  type BundleDeviceStatus,
} from "../../lib/bundle-versions";
import {
  BundleStateBadge,
  deviceStatusLook,
} from "../../components/skills/bundle-state-badge";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { RowCard } from "../../components/ui/row-card";
import { SkillNote } from "../../components/skills/skill-note";

export type ToolInstallState =
  "current" | "older" | "foreign" | "missing" | "offline";

export interface ToolInstallRow {
  device: DeviceProjection;
  state: ToolInstallState;
  /** The version the device reported, if any. */
  version?: string;
  /** Where the device stands with the bundle, where Foundry installed it. */
  bundle?: BundleDeviceVersion;
  status?: BundleDeviceStatus;
}

/** What a bundle says about its devices' versions and its rollout. */
export type BundleVersionsView = Pick<
  SkillRepository,
  "deviceVersions" | "rollout"
>;

/**
 * Where a bundle's program stands on each of the person's devices. A device
 * that is offline says so instead of offering a button that would fail.
 */
export function toolInstallRows(
  tool: SkillBundleTool,
  devices: DeviceProjection[],
  deviceTools: DeviceTool[],
  repo: BundleVersionsView = {},
): ToolInstallRow[] {
  return devices
    .filter((device) => device.owned)
    .map((device) => {
      const bundle = repo.deviceVersions?.find(
        (entry) =>
          entry.deviceId === device.id && entry.tools[tool.name] !== undefined,
      );
      const versions = bundle
        ? { bundle, status: bundleDeviceStatus(bundle, repo) }
        : {};
      const report = deviceTools.find(
        (row) => row.deviceId === device.id && row.tool === tool.name,
      );
      const installed: ToolInstallState | undefined =
        report?.version === tool.version
          ? "current"
          : report?.version
            ? "older"
            : report?.available
              ? "foreign"
              : undefined;
      const version = bundle?.tools[tool.name] ?? report?.version;
      if (installed === "current")
        return { device, state: installed, version, ...versions };
      const state: ToolInstallState =
        device.status !== "connected" ? "offline" : (installed ?? "missing");
      return { device, state, version, ...versions };
    });
}

const lastLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";

/**
 * A bundle's program, summarized on the card ("installed on 1 of 6
 * devices"); its devices, with Install and Update, open in a dialog. A
 * program with a setup step (e.g. downloading the browser it drives) offers
 * it per device once installed. Nothing runs unless the person asks.
 */
export function BundleToolStatus({
  tool,
  devices,
  deviceTools,
  repo,
  disabled,
  install,
  setup,
  named = false,
}: {
  tool: SkillBundleTool;
  devices: DeviceProjection[];
  deviceTools: DeviceTool[];
  /** The bundle's device versions and rollout. */
  repo?: BundleVersionsView;
  disabled: boolean;
  /** Installs the program on a device and refreshes the page's data. */
  install: (device: DeviceProjection) => Promise<void>;
  /** Runs the program's setup step on a device; resolves to its output. */
  setup?: (device: DeviceProjection) => Promise<string>;
  /** Names the program, for a bundle with more than one. */
  named?: boolean;
}) {
  const { t } = useTranslation(["skills", "common"]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [settingUp, setSettingUp] = useState<Record<string, boolean>>({});
  const [setupDone, setSetupDone] = useState<Record<string, string>>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const rows = toolInstallRows(tool, devices, deviceTools, repo);
  const installed = rows.filter((row) => row.state === "current").length;
  // An older version counts even where it cannot be updated right now.
  const older = rows.some(
    (row) => row.version !== undefined && row.version !== tool.version,
  );
  const mismatched = rows.some((row) => row.status === "mismatch");

  const run = async (device: DeviceProjection) => {
    setBusy((current) => ({ ...current, [device.id]: true }));
    setErrors((current) => ({ ...current, [device.id]: "" }));
    try {
      await install(device);
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        [device.id]: cause instanceof Error ? cause.message : String(cause),
      }));
    } finally {
      setBusy((current) => ({ ...current, [device.id]: false }));
    }
  };

  const source = { package: tool.package ?? tool.name, version: tool.version };
  const description =
    tool.source === "npm" && tool.registry === "device"
      ? t("library.bundle.installsDescriptionNpmDevice", source)
      : tool.source === "npm" && tool.registry
        ? t("library.bundle.installsDescriptionNpmRegistry", {
            ...source,
            registry: tool.registry.replace(/^https:\/\//, ""),
          })
        : tool.source === "npm"
          ? t("library.bundle.installsDescriptionNpm", source)
          : tool.source === "uv"
            ? t("library.bundle.installsDescriptionUv", source)
            : t("library.bundle.installsDescription");

  const runSetup = async (device: DeviceProjection) => {
    if (!setup) return;
    setSettingUp((current) => ({ ...current, [device.id]: true }));
    setErrors((current) => ({ ...current, [device.id]: "" }));
    setSetupDone((current) => ({ ...current, [device.id]: "" }));
    try {
      const output = await setup(device);
      setSetupDone((current) => ({
        ...current,
        [device.id]: lastLine(output) || t("library.bundle.setupDone"),
      }));
    } catch (cause) {
      setErrors((current) => ({
        ...current,
        [device.id]: cause instanceof Error ? cause.message : String(cause),
      }));
    } finally {
      setSettingUp((current) => ({ ...current, [device.id]: false }));
    }
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className="text-sm text-ink">
        {named ? `${tool.name} · ` : ""}
        {rows.length
          ? t("library.bundle.facts.installed", {
              installed,
              count: rows.length,
            })
          : t("library.bundle.facts.noDevices")}
      </span>
      {older || mismatched ? (
        <SkillNote data-tone="warning">
          {[
            older ? t("library.bundle.toolOlder") : "",
            mismatched ? t("library.versions.mismatchSummary") : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </SkillNote>
      ) : null}
      {rows.length ? (
        <Button
          disabled={disabled}
          onClick={() => {
            // A failure from an earlier visit may no longer hold (e.g. the
            // device has uv now); each visit starts from the devices' state.
            setErrors({});
            setSetupDone({});
            setOpen(true);
          }}
          aria-label={t("library.bundle.installsTitle", {
            name: tool.name,
            version: tool.version,
          })}
          ref={trigger}
          size="sm"
          variant="ghost"
        >
          {t("library.bundle.facts.manage")}
        </Button>
      ) : null}
      <Dialog
        description={[
          description,
          repo?.deviceVersions ? t("library.versions.followsUpdates") : "",
          tool.setup
            ? t("library.bundle.setupHint", {
                command: [
                  tool.setup.command || tool.name,
                  ...tool.setup.args,
                ].join(" "),
              })
            : "",
          tool.signIn?.length
            ? t("library.bundle.signInHint", {
                command: [tool.name, ...tool.signIn].join(" "),
              })
            : "",
        ]
          .filter(Boolean)
          .join(" ")}
        footer={
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {t("common:actions.close")}
          </Button>
        }
        layout="compact"
        onClose={() => setOpen(false)}
        open={open}
        returnFocusTo={trigger.current}
        title={t("library.bundle.installsTitle", {
          name: tool.name,
          version: tool.version,
        })}
      >
        <ul className="grid gap-2">
          {rows.map(({ device, state, version, bundle, status }) => (
            <RowCard
              as="li"
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2.75 py-2.25"
              key={device.id}
              tone="ring"
            >
              <span className="grid min-w-0 gap-0.5 text-sm">
                <strong>{device.label}</strong>
                {bundle && status ? (
                  <>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <BundleStateBadge look={deviceStatusLook[status]}>
                        {bundleDeviceStatusLabel(status)}
                      </BundleStateBadge>
                      <SkillNote>
                        {[
                          t("library.versions.installed", {
                            tool: `${tool.name} ${version ?? ""}`.trim(),
                          }),
                          deviceSkillsText(bundle),
                          state === "offline"
                            ? t("library.versions.offline")
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </SkillNote>
                    </span>
                    {status === "mismatch" || status === "unchecked" ? (
                      <FieldHint
                        as="small"
                        className="mt-0"
                        tone={status === "mismatch" ? "warning" : "muted"}
                      >
                        {t(`library.versions.statusNote.${status}`)}
                      </FieldHint>
                    ) : null}
                  </>
                ) : (
                  <SkillNote>
                    {t(`library.bundle.toolState.${state}`, {
                      name: tool.name,
                      version: version ?? "",
                    })}
                  </SkillNote>
                )}
                {settingUp[device.id] ? (
                  <SkillNote role="status">
                    {t("library.bundle.setupRunningNote")}
                  </SkillNote>
                ) : setupDone[device.id] ? (
                  <SkillNote role="status">
                    {t("library.bundle.setupFinished", {
                      output: setupDone[device.id],
                    })}
                  </SkillNote>
                ) : null}
                {errors[device.id] ? (
                  <FieldHint as="small" tone="error" role="alert">
                    {errors[device.id]}
                  </FieldHint>
                ) : null}
              </span>
              {state === "missing" ||
              (state === "older" && !bundle) ||
              state === "foreign" ? (
                <Button
                  aria-busy={busy[device.id]}
                  disabled={busy[device.id]}
                  onClick={() => void run(device)}
                  size="sm"
                  variant="secondary"
                >
                  {busy[device.id]
                    ? t("library.bundle.installing")
                    : state === "older"
                      ? t("library.bundle.update")
                      : t("library.bundle.install")}
                </Button>
              ) : null}
              {state === "current" && tool.setup && setup ? (
                <Button
                  aria-busy={settingUp[device.id]}
                  disabled={settingUp[device.id]}
                  onClick={() => void runSetup(device)}
                  size="sm"
                  variant="secondary"
                >
                  {settingUp[device.id]
                    ? t("library.bundle.settingUp")
                    : t("library.bundle.runSetup")}
                </Button>
              ) : null}
            </RowCard>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
