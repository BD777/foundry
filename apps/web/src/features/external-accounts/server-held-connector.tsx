import type {
  ConnectorDescriptor,
  ConnectorField,
  ConnectorOption,
  ConnectorPackageView,
  ConnectorServerHeldDevice,
  ConnectorServerHeldInstance,
  ConnectorServerHeldInstanceInput,
  ConnectorServerHeldNetworkPath,
  ConnectorServerHeldProbeResult,
  EdgeAccessRequired,
} from "@bd777/foundry-protocol";
import { ArrowLeft, Plus } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  checkServerHeldInstance,
  createServerHeldInstance,
  deleteServerHeldInstance,
  getExternalAccounts,
  getServerHeldInstances,
  probeServerHeldInstance,
  replaceServerHeldInstance,
  revokeServerHeldInstance,
} from "../../api";
import { MarkdownContent } from "../../components/conversation/markdown-content";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { Dialog } from "../../components/ui/dialog";
import { FieldHint, TextInput } from "../../components/ui/field";
import {
  FieldLabel,
  FormFieldGroup,
  FormLayout,
} from "../../components/ui/form-field";
import { Skeleton } from "../../components/ui/loading";
import { SelectMenu } from "../../components/ui/select-menu";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { MutedText } from "../../components/ui/text";
import type { ToastTone } from "../../components/ui/toast";
import { errorText } from "./account-format";
import { ConnectorSection } from "./connector-section";
import {
  connectorDescription,
  connectorName,
  localized,
} from "./connector-text";
import { CredentialHolding } from "./credential-holding";
import {
  EdgeAccessRequiredNotice,
  edgeAccessRequiredOf,
} from "./edge-access-required";
import { DeviceAvailability } from "./server-held-device-state";
import { ServerHeldInstanceList } from "./server-held-instance-list";

type FailureCategory =
  "credential" | "input" | "network" | "response" | "service";

interface Failure {
  category: FailureCategory;
  detail?: string;
}

export interface ServerHeldConnectorProps {
  connector: ConnectorDescriptor;
  currentUserId: string;
  onNotice: (message: string, tone?: ToastTone) => void;
  /** The connector's package enablement, to show where each instance's package is enabled. */
  packageView?: ConnectorPackageView;
  onPackageChanged?: (view: ConnectorPackageView) => void;
  /** Called after instances were added, changed or revoked, so the package view can follow. */
  onInstancesChanged?: () => void;
}

/**
 * The API already classifies probe failures server-side; its response keeps
 * the human sentence, not the class. Recover the category here so every
 * locale gives the reason the person can act on (credential, URL/network,
 * upstream shape, Foundry availability or form input).
 */
export function probeFailureCategory(cause: unknown): FailureCategory {
  const message = errorText(cause).toLowerCase();
  if (
    message.includes("rejected the credential") ||
    message.includes("refused this credential") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    (cause instanceof ApiError &&
      (cause.status === 401 || cause.status === 403))
  )
    return "credential";
  if (
    message.includes("non-json") ||
    message.includes("bad_response") ||
    message.includes("no route directory") ||
    message.includes("response is larger") ||
    message.includes("refused the probe")
  )
    return "response";
  if (
    message.includes("could not reach") ||
    message.includes("could not resolve") ||
    message.includes("resolve to no address") ||
    message.includes("tls") ||
    message.includes("certificate") ||
    message.includes("timeout") ||
    message.includes("redirect") ||
    message.includes("not ready") ||
    message.includes("try again shortly") ||
    (cause instanceof ApiError &&
      (cause.status === 502 || cause.status === 504))
  )
    return "network";
  if (
    message.includes("required") ||
    message.includes("does not match") ||
    message.includes("not one of") ||
    message.includes("must use https") ||
    message.includes("enter a complete") ||
    message.includes("longer than") ||
    message.includes("unknown field") ||
    (cause instanceof ApiError && cause.status === 400)
  )
    return "input";
  return cause instanceof ApiError && cause.status >= 500
    ? "service"
    : "network";
}

function FailureAlert({ failure }: { failure: Failure }) {
  const { t } = useTranslation("externalAccounts");
  const actionable = failure.detail?.trim();
  return (
    <Alert
      details={failure.detail}
      title={t(`serverHeld.errors.${failure.category}.title`)}
      tone="error"
    >
      {failure.category === "input" && actionable
        ? actionable
        : t(`serverHeld.errors.${failure.category}.body`)}
    </Alert>
  );
}

function failureOf(cause: unknown): Failure {
  const category = probeFailureCategory(cause);
  const message = errorText(cause).trim();
  return { category, detail: message || undefined };
}

function fieldVisible(
  field: ConnectorField,
  values: Record<string, string>,
): boolean {
  return (
    !field.showWhen ||
    field.showWhen.equals.includes(values[field.showWhen.field] ?? "")
  );
}

function optionLabel(option: ConnectorOption): string {
  return localized(option.label, option.labels);
}

function FieldHelp({
  field,
  id,
  className,
}: {
  field: ConnectorField;
  id: string;
  className?: string;
}) {
  const help = field.help ? localized(field.help, field.helps) : undefined;
  if (!help) return null;
  return (
    <div
      className={`mt-1.5 min-w-0 text-xs leading-[1.55] text-ink-muted [&_p]:m-0 [&_p+p]:mt-1.5 ${className ?? ""}`}
      id={id}
    >
      <MarkdownContent>{help}</MarkdownContent>
    </div>
  );
}

/**
 * A server-held connector supplied by an extension: its instances, generic
 * validation/revocation actions, and a form generated entirely from the
 * reported fields and steps.
 */
export function ServerHeldConnector({
  connector,
  currentUserId,
  onNotice,
  packageView,
  onPackageChanged,
  onInstancesChanged,
}: ServerHeldConnectorProps) {
  const { t } = useTranslation("externalAccounts");
  const { t: tCommon } = useTranslation("common");
  const [descriptor, setDescriptor] = useState(connector);
  const [instances, setInstances] = useState<ConnectorServerHeldInstance[]>([]);
  const [devices, setDevices] = useState<ConnectorServerHeldDevice[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<Failure>();
  const [actionFailure, setActionFailure] = useState<Failure>();
  const [actionEdgeAccess, setActionEdgeAccess] =
    useState<EdgeAccessRequired>();
  const [editor, setEditor] = useState<ConnectorServerHeldInstance>();
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState<string>();
  const [revoking, setRevoking] = useState<ConnectorServerHeldInstance>();
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [deleting, setDeleting] = useState<ConnectorServerHeldInstance>();
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function refresh() {
    const [view, external] = await Promise.all([
      getServerHeldInstances(connector.kind),
      getExternalAccounts().catch(() => undefined),
    ]);
    setDescriptor(view.descriptor);
    setInstances(view.instances);
    setDevices(view.devices);
    if (external) setConfigured(external.secretsConfigured);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailure(undefined);
    refresh()
      .catch((cause) => {
        if (!cancelled) setLoadFailure(failureOf(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connector.kind, currentUserId]);

  async function check(instance: ConnectorServerHeldInstance) {
    setChecking(instance.id);
    setActionFailure(undefined);
    setActionEdgeAccess(undefined);
    try {
      const saved = await checkServerHeldInstance(connector.kind, instance.id);
      setInstances((current) =>
        current.map((entry) => (entry.id === saved.id ? saved : entry)),
      );
      onNotice(t("serverHeld.checked", { name: saved.label }));
      onInstancesChanged?.();
    } catch (cause) {
      const required = edgeAccessRequiredOf(cause);
      setActionEdgeAccess(required);
      if (!required) setActionFailure(failureOf(cause));
      await refresh().catch(() => undefined);
    } finally {
      setChecking(undefined);
    }
  }

  async function revoke() {
    if (!revoking) return;
    setRevokeBusy(true);
    setActionFailure(undefined);
    setActionEdgeAccess(undefined);
    try {
      const saved = await revokeServerHeldInstance(connector.kind, revoking.id);
      setInstances((current) =>
        current.map((entry) => (entry.id === saved.id ? saved : entry)),
      );
      onNotice(t("serverHeld.revokedNotice", { name: saved.label }));
      setRevoking(undefined);
      onInstancesChanged?.();
    } catch (cause) {
      setActionFailure(failureOf(cause));
    } finally {
      setRevokeBusy(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setDeleteBusy(true);
    setActionFailure(undefined);
    setActionEdgeAccess(undefined);
    try {
      await deleteServerHeldInstance(connector.kind, deleting.id);
      setInstances((current) =>
        current.filter((entry) => entry.id !== deleting.id),
      );
      onNotice(t("serverHeld.deletedNotice", { name: deleting.label }));
      setDeleting(undefined);
      onInstancesChanged?.();
    } catch (cause) {
      setActionFailure(failureOf(cause));
      await refresh().catch(() => undefined);
    } finally {
      setDeleteBusy(false);
    }
  }

  function saved(instance: ConnectorServerHeldInstance) {
    const replacing = Boolean(editor);
    setInstances((current) =>
      replacing
        ? current.map((entry) => (entry.id === instance.id ? instance : entry))
        : [...current, instance],
    );
    setAdding(false);
    setEditor(undefined);
    onInstancesChanged?.();
    onNotice(
      t(replacing ? "serverHeld.updatedNotice" : "serverHeld.savedNotice", {
        name: instance.label,
      }),
    );
  }

  const serverHeld = descriptor.serverHeld;
  const atLimit = serverHeld?.instances === "one" && instances.length > 0;
  const name = connectorName(descriptor);
  const description = connectorDescription(descriptor);

  return (
    <ConnectorSection
      actions={
        <Button
          disabled={!configured || loading || atLimit}
          onClick={() => setAdding(true)}
          size="sm"
          variant="primary"
        >
          <Plus aria-hidden="true" size={14} />
          {t("serverHeld.add")}
        </Button>
      }
      description={description}
      holding={<CredentialHolding holding="server_held" name={name} />}
      name={name}
    >
      {!configured ? (
        <Alert
          title={t("serverHeld.noSecretStore", { connector: name })}
          tone="warning"
        />
      ) : null}
      {loadFailure ? <FailureAlert failure={loadFailure} /> : null}
      {actionEdgeAccess ? (
        <EdgeAccessRequiredNotice
          onProvisioned={() => void refresh()}
          required={actionEdgeAccess}
        />
      ) : null}
      {actionFailure ? <FailureAlert failure={actionFailure} /> : null}
      {loading ? (
        <Skeleton
          label={t("serverHeld.loading", { connector: name })}
          rows={2}
          variant="rows"
        />
      ) : instances.length === 0 ? (
        <MutedText>{t("serverHeld.empty", { connector: name })}</MutedText>
      ) : serverHeld ? (
        <ServerHeldInstanceList
          checking={checking}
          instances={instances}
          onCheck={(instance) => void check(instance)}
          onDelete={setDeleting}
          onEdit={setEditor}
          onNotice={onNotice}
          onPackageChanged={onPackageChanged}
          onRevoke={setRevoking}
          packageView={packageView}
          serverHeld={serverHeld}
        />
      ) : null}
      {adding || editor ? (
        <ServerHeldInstanceDialog
          descriptor={descriptor}
          devices={devices}
          instance={editor}
          onEdgeAccessProvisioned={() => void refresh()}
          onClose={() => {
            setAdding(false);
            setEditor(undefined);
          }}
          onSaved={saved}
        />
      ) : null}
      {revoking ? (
        <Dialog
          busy={revokeBusy}
          description={t("serverHeld.revokeDescription", {
            name: revoking.label,
          })}
          footer={
            <ButtonRow align="end">
              <Button
                disabled={revokeBusy}
                onClick={() => setRevoking(undefined)}
                size="sm"
                variant="ghost"
              >
                {tCommon("actions.cancel")}
              </Button>
              <Button
                busy={revokeBusy}
                onClick={() => void revoke()}
                size="sm"
                variant="danger"
              >
                {t("serverHeld.revokeConfirm")}
              </Button>
            </ButtonRow>
          }
          onClose={() => setRevoking(undefined)}
          title={t("serverHeld.revokeTitle", { name: revoking.label })}
        >
          <MutedText>{t("serverHeld.revokeBody")}</MutedText>
        </Dialog>
      ) : null}
      {deleting ? (
        <Dialog
          busy={deleteBusy}
          description={t("serverHeld.deleteDescription", {
            name: deleting.label,
          })}
          footer={
            <ButtonRow align="end">
              <Button
                disabled={deleteBusy}
                onClick={() => setDeleting(undefined)}
                size="sm"
                variant="ghost"
              >
                {tCommon("actions.cancel")}
              </Button>
              <Button
                busy={deleteBusy}
                onClick={() => void remove()}
                size="sm"
                variant="danger"
              >
                {t("serverHeld.deleteConfirm")}
              </Button>
            </ButtonRow>
          }
          onClose={() => setDeleting(undefined)}
          title={t("serverHeld.deleteTitle", { name: deleting.label })}
        >
          <MutedText>{t("serverHeld.deleteBody")}</MutedText>
        </Dialog>
      ) : null}
    </ConnectorSection>
  );
}

function ServerHeldInstanceDialog({
  descriptor,
  devices,
  instance,
  onEdgeAccessProvisioned,
  onClose,
  onSaved,
}: {
  descriptor: ConnectorDescriptor;
  devices: ConnectorServerHeldDevice[];
  instance?: ConnectorServerHeldInstance;
  onEdgeAccessProvisioned?: () => void;
  onClose: () => void;
  onSaved: (instance: ConnectorServerHeldInstance) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const { t: tCommon } = useTranslation("common");
  const id = useId();
  const serverHeld = descriptor.serverHeld;
  const fields = serverHeld?.fields ?? [];
  const steps =
    serverHeld?.steps.length && serverHeld.steps.length > 0
      ? serverHeld.steps
      : [fields.map((field) => field.id)];
  const holdings = serverHeld?.network.holdings ?? ["server"];
  const firstOnline = devices.find((device) => device.online)?.deviceId ?? "";
  const [step, setStep] = useState(0);
  const [network, setNetwork] = useState<ConnectorServerHeldNetworkPath>(
    instance?.network ?? holdings[0] ?? "server",
  );
  const [deviceId, setDeviceId] = useState(
    instance?.probeDeviceId ?? firstOnline,
  );
  const [label, setLabel] = useState(instance?.label ?? "");
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of fields) {
      initial[field.id] = instance?.values[field.id] ?? field.default ?? "";
    }
    return initial;
  });
  const [probe, setProbe] = useState<ConnectorServerHeldProbeResult>();
  const [failure, setFailure] = useState<Failure>();
  const [edgeAccessRequired, setEdgeAccessRequired] =
    useState<EdgeAccessRequired>();
  const [busy, setBusy] = useState(false);
  const replacing = Boolean(instance);
  const total = steps.length + 1;
  const formStep = step - 1;
  const currentIDs = new Set(steps[formStep] ?? []);
  const currentFields = fields.filter(
    (field) => currentIDs.has(field.id) && fieldVisible(field, values),
  );

  function setField(field: ConnectorField, value: string) {
    setValues((current) => ({ ...current, [field.id]: value }));
    setFailure(undefined);
    setEdgeAccessRequired(undefined);
    if (formStep === 0) setProbe(undefined);
  }

  function inputFor(): ConnectorServerHeldInstanceInput {
    return {
      label: label.trim(),
      fields: values,
      network,
      ...(network === "device" ? { deviceId } : {}),
    };
  }

  function checkNetwork() {
    if (network !== "device") return "";
    const device = devices.find((entry) => entry.deviceId === deviceId);
    if (!device) return t("serverHeld.chooseDevice");
    if (!device.online)
      return t("serverHeld.deviceOffline", { device: device.name });
    return "";
  }

  function checkRequired() {
    for (const field of currentFields) {
      const value = values[field.id]?.trim() ?? "";
      const sealed =
        field.type === "secret" && instance?.secretFields.includes(field.id);
      if (field.required && !value && !sealed)
        return t("serverHeld.fieldRequired", {
          field: localized(field.label, field.labels),
        });
      if (field.type === "url" && value && !/^https?:\/\/[^\s]+$/i.test(value))
        return t("serverHeld.fieldUrl", {
          field: localized(field.label, field.labels),
        });
    }
    return "";
  }

  async function validate() {
    const networkMessage = checkNetwork();
    if (networkMessage) {
      setFailure({ category: "input", detail: networkMessage });
      return;
    }
    const message = checkRequired();
    if (message) {
      setFailure({ category: "input", detail: message });
      return;
    }
    setBusy(true);
    setFailure(undefined);
    setEdgeAccessRequired(undefined);
    try {
      const result = await probeServerHeldInstance(descriptor.kind, inputFor());
      setProbe(result);
      if (steps.length > 1) setStep(2);
    } catch (cause) {
      const required = edgeAccessRequiredOf(cause);
      setEdgeAccessRequired(required);
      if (!required) setFailure(failureOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const networkMessage = checkNetwork();
    if (networkMessage) {
      setFailure({ category: "input", detail: networkMessage });
      return;
    }
    setBusy(true);
    setFailure(undefined);
    setEdgeAccessRequired(undefined);
    try {
      const saved = replacing
        ? await replaceServerHeldInstance(
            descriptor.kind,
            instance!.id,
            inputFor(),
          )
        : await createServerHeldInstance(descriptor.kind, inputFor());
      onSaved(saved);
    } catch (cause) {
      const required = edgeAccessRequiredOf(cause);
      setEdgeAccessRequired(required);
      if (!required) setFailure(failureOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLElement>) {
    event.preventDefault();
    if (busy) return;
    if (step === 0) {
      const message = checkNetwork();
      if (message) {
        setFailure({ category: "input", detail: message });
        return;
      }
      setFailure(undefined);
      setStep(1);
      return;
    }
    if (!probe) {
      await validate();
      return;
    }
    if (formStep < steps.length - 1) {
      setStep((current) => current + 1);
      return;
    }
    await save();
  }

  const title = replacing
    ? t("serverHeld.replaceTitle", { connector: connectorName(descriptor) })
    : t("serverHeld.addTitle", { connector: connectorName(descriptor) });
  const primary =
    step === 0
      ? t("serverHeld.continue")
      : !probe && formStep === 0
        ? t("serverHeld.validate")
        : formStep < steps.length - 1
          ? t("serverHeld.continue")
          : t(replacing ? "serverHeld.update" : "serverHeld.save");
  const primaryBusy = busy
    ? t(probe ? "serverHeld.saving" : "serverHeld.validating")
    : primary;

  return (
    <Dialog
      busy={busy}
      description={t(
        replacing
          ? "serverHeld.replaceDescription"
          : "serverHeld.addDescription",
      )}
      footer={
        <ButtonRow align="end">
          {step > 0 ? (
            <Button
              disabled={busy}
              onClick={() => {
                setFailure(undefined);
                setEdgeAccessRequired(undefined);
                setStep((current) => Math.max(0, current - 1));
              }}
              size="sm"
              variant="ghost"
            >
              <ArrowLeft aria-hidden="true" size={14} />
              {t("serverHeld.back")}
            </Button>
          ) : null}
          <Button disabled={busy} onClick={onClose} size="sm" variant="ghost">
            {tCommon("actions.cancel")}
          </Button>
          <Button
            busy={busy}
            form={`${id}-form`}
            size="sm"
            type="submit"
            variant="primary"
          >
            {primaryBusy}
          </Button>
        </ButtonRow>
      }
      layout="compact"
      onClose={onClose}
      title={title}
    >
      <FormLayout
        as="form"
        id={`${id}-form`}
        onSubmit={(event) => void submit(event)}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
          <span>{t("serverHeld.step", { current: step + 1, total })}</span>
          {probe?.routeCount !== undefined ? (
            <span>
              ·{" "}
              {t("serverHeld.probePassed", {
                version: probe.version
                  ? t("serverHeld.version", { version: probe.version })
                  : "",
                routes: t("serverHeld.routeCount", {
                  count: probe.routeCount,
                }),
              })}
            </span>
          ) : null}
        </div>
        {probe && probe.network === "device" ? (
          <div className="grid gap-1 text-xs text-ink-muted">
            <DeviceAvailability
              devices={probe.availableDevices}
              probeDeviceId={probe.probeDeviceId}
            />
          </div>
        ) : null}
        {step === 0 ? (
          <FormFieldGroup>
            <FieldLabel as="span">{t("serverHeld.whereTitle")}</FieldLabel>
            <SegmentedControl
              aria-label={t("serverHeld.whereTitle")}
              fill
              onValueChange={(value) => {
                setNetwork(value);
                setProbe(undefined);
                setFailure(undefined);
                setEdgeAccessRequired(undefined);
                if (value === "device" && !deviceId) setDeviceId(firstOnline);
              }}
              options={[
                ...(holdings.includes("server")
                  ? [
                      {
                        value: "server" as const,
                        label: t("serverHeld.networkServer"),
                      },
                    ]
                  : []),
                ...(holdings.includes("device")
                  ? [
                      {
                        value: "device" as const,
                        label: t("serverHeld.networkDevice"),
                      },
                    ]
                  : []),
              ]}
              size="sm"
              value={network}
            />
            <FieldHint as="small">
              {t(
                network === "device"
                  ? "serverHeld.networkDeviceHelp"
                  : "serverHeld.networkServerHelp",
              )}
            </FieldHint>
            {network === "device" ? (
              <>
                <FieldLabel as="span">{t("serverHeld.probeDevice")}</FieldLabel>
                <SelectMenu
                  ariaLabel={t("serverHeld.probeDevice")}
                  insideDialog
                  onChange={(value) => {
                    setDeviceId(value);
                    setFailure(undefined);
                    setEdgeAccessRequired(undefined);
                  }}
                  options={devices.map((device) => ({
                    disabled: !device.online,
                    detail: device.online
                      ? undefined
                      : t("serverHeld.deviceOffline", {
                          device: device.name,
                        }),
                    label: device.name,
                    value: device.deviceId,
                  }))}
                  placeholder={t("serverHeld.chooseDevice")}
                  value={deviceId}
                />
              </>
            ) : null}
          </FormFieldGroup>
        ) : null}
        {step > 0 && formStep === 0 ? (
          <FormFieldGroup>
            <FieldLabel htmlFor={`${id}-label`}>
              {t("serverHeld.labelLabel")}
            </FieldLabel>
            <TextInput
              autoComplete="off"
              id={`${id}-label`}
              maxLength={160}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t("serverHeld.labelPlaceholder")}
              tone="boxed"
              value={label}
            />
            <FieldHint as="small">{t("serverHeld.labelHelp")}</FieldHint>
          </FormFieldGroup>
        ) : null}
        {step > 0
          ? currentFields.map((field) => {
              const helpID = `${id}-${field.id}-help`;
              const fieldLabel = localized(field.label, field.labels);
              const options =
                field.options ??
                (probe?.fieldOptions[field.id] as
                  ConnectorOption[] | undefined) ??
                [];
              const sealed =
                field.type === "secret" &&
                instance?.secretFields.includes(field.id);
              return (
                <FormFieldGroup key={field.id}>
                  <FieldLabel
                    as={field.type === "select" ? "span" : "label"}
                    htmlFor={
                      field.type === "select" ? undefined : `${id}-${field.id}`
                    }
                  >
                    {fieldLabel}
                    {field.required ? <span aria-hidden="true"> *</span> : null}
                  </FieldLabel>
                  {field.type === "select" ? (
                    <SelectMenu
                      ariaLabel={fieldLabel}
                      disabled={busy || (Boolean(field.optionsFrom) && !probe)}
                      insideDialog
                      onChange={(value) => setField(field, value)}
                      options={options.map((option) => ({
                        label: optionLabel(option),
                        value: option.value,
                      }))}
                      placeholder={
                        field.optionsFrom && !probe
                          ? t("serverHeld.validateForOptions")
                          : t("serverHeld.chooseOption")
                      }
                      value={values[field.id] ?? ""}
                    />
                  ) : (
                    <TextInput
                      aria-describedby={field.help ? helpID : undefined}
                      aria-required={field.required || undefined}
                      autoComplete={field.type === "secret" ? "off" : undefined}
                      disabled={busy}
                      id={`${id}-${field.id}`}
                      maxLength={field.type === "secret" ? 8192 : undefined}
                      onChange={(event) => setField(field, event.target.value)}
                      placeholder={
                        sealed ? t("serverHeld.secretKeep") : field.placeholder
                      }
                      tone="boxed"
                      type={field.type === "secret" ? "password" : "text"}
                      value={values[field.id] ?? ""}
                    />
                  )}
                  {field.type === "secret" && sealed ? (
                    <FieldHint as="small">
                      {t("serverHeld.secretSealed")}
                    </FieldHint>
                  ) : null}
                  <FieldHelp field={field} id={helpID} />
                </FormFieldGroup>
              );
            })
          : null}
        {edgeAccessRequired ? (
          <EdgeAccessRequiredNotice
            onProvisioned={onEdgeAccessProvisioned}
            required={edgeAccessRequired}
          />
        ) : failure ? (
          <FailureAlert failure={failure} />
        ) : null}
      </FormLayout>
    </Dialog>
  );
}
