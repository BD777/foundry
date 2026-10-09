import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  DeviceTool,
  SkillBundleTool,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";

/** Workers older than this capability cannot install programs. */
const toolInstallCapability = "tool_install";
/** Workers older than this cannot install npm or uv packages or run setup. */
const toolSourcesCapability = "tool_sources";
/** Workers older than this install npm tools only from registry.npmjs.org. */
const toolRegistryCapability = "tool_registry";

export type ToolInstallState =
  "current" | "older" | "foreign" | "missing" | "offline" | "unsupported";

export interface ToolInstallRow {
  device: DeviceProjection;
  state: ToolInstallState;
  /** The version the device reported, if any. */
  version?: string;
}

/**
 * Where a bundle's program stands on each of the person's devices. A device
 * that is offline, or whose worker cannot install programs, says so instead
 * of offering a button that would fail.
 */
export function toolInstallRows(
  tool: SkillBundleTool,
  devices: DeviceProjection[],
  deviceTools: DeviceTool[],
): ToolInstallRow[] {
  return devices
    .filter((device) => device.owned && device.status !== "removed")
    .map((device) => {
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
      if (installed === "current")
        return { device, state: installed, version: report?.version };
      const state: ToolInstallState =
        device.status !== "connected"
          ? "offline"
          : !device.capabilities?.includes(toolInstallCapability) ||
              (tool.source &&
                !device.capabilities?.includes(toolSourcesCapability)) ||
              (tool.registry &&
                !device.capabilities?.includes(toolRegistryCapability))
            ? "unsupported"
            : (installed ?? "missing");
      return { device, state, version: report?.version };
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
  disabled,
  install,
  setup,
}: {
  tool: SkillBundleTool;
  devices: DeviceProjection[];
  deviceTools: DeviceTool[];
  disabled: boolean;
  /** Installs the program on a device and refreshes the page's data. */
  install: (device: DeviceProjection) => Promise<void>;
  /** Runs the program's setup step on a device; resolves to its output. */
  setup?: (device: DeviceProjection) => Promise<string>;
}) {
  const { t } = useTranslation(["skills", "common"]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [settingUp, setSettingUp] = useState<Record<string, boolean>>({});
  const [setupDone, setSetupDone] = useState<Record<string, string>>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const rows = toolInstallRows(tool, devices, deviceTools);
  const installed = rows.filter((row) => row.state === "current").length;
  // An older version counts even where it cannot be updated right now.
  const older = rows.some(
    (row) => row.version !== undefined && row.version !== tool.version,
  );

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
    <div className="fdy-skill-bundle-tool">
      <small data-tone={older ? "warning" : undefined}>
        {t("library.bundle.toolSummary", {
          name: tool.name,
          version: tool.version,
          installed,
          count: rows.length,
        })}
        {older ? ` · ${t("library.bundle.toolOlder")}` : ""}
      </small>
      <Button
        disabled={disabled || rows.length === 0}
        onClick={() => {
          // A failure from an earlier visit may no longer hold (e.g. the
          // device has uv now); each visit starts from the devices' state.
          setErrors({});
          setSetupDone({});
          setOpen(true);
        }}
        ref={trigger}
        size="sm"
        variant="secondary"
      >
        {t("library.bundle.manageInstalls")}
      </Button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fdy-connection-assign-overlay" />
          <Dialog.Content
            className="fdy-connection-assign-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus();
            }}
          >
            <header className="fdy-connection-assign-header">
              <div>
                <Dialog.Title>
                  {t("library.bundle.installsTitle", {
                    name: tool.name,
                    version: tool.version,
                  })}
                </Dialog.Title>
                <Dialog.Description>
                  {description}
                  {tool.setup
                    ? ` ${t("library.bundle.setupHint", {
                        command: [
                          tool.setup.command || tool.name,
                          ...tool.setup.args,
                        ].join(" "),
                      })}`
                    : ""}
                  {tool.signIn?.length
                    ? ` ${t("library.bundle.signInHint", {
                        command: [tool.name, ...tool.signIn].join(" "),
                      })}`
                    : ""}
                </Dialog.Description>
              </div>
            </header>
            <ul className="fdy-skill-bundle-installs">
              {rows.map(({ device, state, version }) => (
                <li key={device.id}>
                  <span className="fdy-skill-bundle-install-copy">
                    <strong>{device.label}</strong>
                    <small>
                      {t(`library.bundle.toolState.${state}`, {
                        name: tool.name,
                        version: version ?? "",
                      })}
                    </small>
                    {settingUp[device.id] ? (
                      <small role="status">
                        {t("library.bundle.setupRunningNote")}
                      </small>
                    ) : setupDone[device.id] ? (
                      <small role="status">
                        {t("library.bundle.setupFinished", {
                          output: setupDone[device.id],
                        })}
                      </small>
                    ) : null}
                    {errors[device.id] ? (
                      <small className="fdy-skill-error" role="alert">
                        {errors[device.id]}
                      </small>
                    ) : null}
                  </span>
                  {state === "missing" ||
                  state === "older" ||
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
                </li>
              ))}
            </ul>
            <footer className="fdy-connection-assign-actions fdy-skill-dialog-actions">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                {t("common:actions.close")}
              </Button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
