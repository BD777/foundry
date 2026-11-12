import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Search, ShieldCheck } from "lucide-react";
import type {
  AssistantSummary,
  DeviceProjection,
  PermissionIdentityResources,
  PermissionListRule,
  PermissionPackage,
  ResourceInstance,
  ResourceList,
  ResourceState,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import {
  getAssistantPermissionPackage,
  listResources,
  setAssistantPermissionPackage,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../components/ui/command";
import { Dialog } from "../../components/ui/dialog";
import { CheckLabel } from "../../components/ui/check-label";
import { Checkbox, FieldHint } from "../../components/ui/field";
import { LoadingState } from "../../components/ui/loading";
import { SectionHeader } from "../../components/ui/page-header";
import { SelectMenu } from "../../components/ui/select-menu";
import { ToastFeedback } from "../../components/ui/toast";
import { deviceConnection } from "../../lib/device-connection";
import { serverErrorText } from "../../lib/errors";
import { SettingsGroup } from "./settings-field";

interface WorkspaceGroup {
  deviceId: string;
  label: string;
  online: boolean;
  workspaces: WorkspaceProjection[];
}

interface IdentityResourceGroup {
  sourceId: string;
  label: string;
  online: boolean;
  resources: ResourceInstance[];
}

const identityResourceTypes = new Set([
  "browser",
  "computer_use",
  "account",
  "mobile_device",
]);

function identitySelection(identity: PermissionIdentityResources): Set<string> {
  return new Set(identity.scope === "all" ? [] : identity.allowed);
}

function normalizeIdentity(
  identity: PermissionIdentityResources,
): PermissionIdentityResources {
  return identity.scope === "all"
    ? { scope: "all", allowed: [] }
    : {
        scope: "listed",
        allowed: [...new Set(identity.allowed)].sort(),
      };
}

function sameIdentity(
  left: PermissionIdentityResources,
  right: PermissionIdentityResources,
): boolean {
  const normalizedLeft = normalizeIdentity(left);
  const normalizedRight = normalizeIdentity(right);
  return (
    normalizedLeft.scope === normalizedRight.scope &&
    normalizedLeft.allowed.join("\n") === normalizedRight.allowed.join("\n")
  );
}

function resourceStateTone(state: ResourceState) {
  switch (state) {
    case "available":
      return "online";
    case "busy":
      return "brass";
    case "unready":
      return "warn";
    case "offline":
      return "neutral";
    case "reconnecting":
    case "gone":
      return "neutral";
  }
}

function ruleSelection(rule: PermissionListRule): Set<string> {
  const excluded = new Set(rule.exclude);
  return new Set(
    rule.include.filter((workspaceId) => !excluded.has(workspaceId)),
  );
}

function normalizeRule(rule: PermissionListRule): PermissionListRule {
  return (rule.scope ?? "all") === "all"
    ? { scope: "all", include: [], exclude: [] }
    : {
        scope: "listed",
        include: [...new Set(rule.include)].sort(),
        exclude: [...new Set(rule.exclude)].sort(),
      };
}

function sameRule(
  left: PermissionListRule,
  right: PermissionListRule,
): boolean {
  const normalizedLeft = normalizeRule(left);
  const normalizedRight = normalizeRule(right);
  return (
    normalizedLeft.scope === normalizedRight.scope &&
    normalizedLeft.include.join("\n") === normalizedRight.include.join("\n") &&
    normalizedLeft.exclude.join("\n") === normalizedRight.exclude.join("\n")
  );
}

/**
 * The projects this assistant may reach. It lives with "where it works"
 * because device placement and workspace reach answer the same question.
 */
export function WorkspaceAccessEditor({
  assistantId,
  assistants,
  devices,
  workspaces,
  onNotice,
}: {
  assistantId?: string;
  assistants: AssistantSummary[];
  devices: DeviceProjection[];
  workspaces: WorkspaceProjection[];
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const { t: resourceT } = useTranslation("resources");
  const [permissionPackage, setPermissionPackage] =
    useState<PermissionPackage>();
  const [savedRule, setSavedRule] = useState<PermissionListRule>();
  const [draft, setDraft] = useState<PermissionListRule>();
  const [savedIdentity, setSavedIdentity] =
    useState<PermissionIdentityResources>();
  const [identityDraft, setIdentityDraft] =
    useState<PermissionIdentityResources>();
  const [resources, setResources] = useState<ResourceList>();
  const [resourceError, setResourceError] = useState("");
  const [resourceReading, setResourceReading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [copyOpen, setCopyOpen] = useState(false);
  const [copySourceId, setCopySourceId] = useState("");
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [pendingCopy, setPendingCopy] = useState<{
    label: string;
    ids: string[];
  }>();

  const available = useMemo(
    () =>
      workspaces.filter(
        (workspace) =>
          workspace.kind !== "personal_agent" && !workspace.archivedAt,
      ),
    [workspaces],
  );

  useEffect(() => {
    let current = true;
    setPermissionPackage(undefined);
    setSavedIdentity(undefined);
    setIdentityDraft(undefined);
    setLoadError("");
    getAssistantPermissionPackage(assistantId).then(
      (pkg) => {
        if (!current) return;
        const workspaces = normalizeRule(pkg.workspaces);
        const identityResources = normalizeIdentity(pkg.identityResources);
        setPermissionPackage(pkg);
        setSavedRule(workspaces);
        setDraft(workspaces);
        setSavedIdentity(identityResources);
        setIdentityDraft(identityResources);
      },
      (reason: unknown) => {
        if (current) setLoadError(serverErrorText(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [assistantId]);

  useEffect(() => {
    let current = true;
    setResourceReading(true);
    setResourceError("");
    listResources().then(
      (list) => {
        if (!current) return;
        setResources(list);
        setResourceReading(false);
      },
      (reason: unknown) => {
        if (!current) return;
        setResourceError(serverErrorText(reason));
        setResourceReading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [assistantId]);

  const scope = draft?.scope ?? "all";
  const selected = draft ? ruleSelection(draft) : new Set<string>();
  const selectedAvailable = available.filter((workspace) =>
    selected.has(workspace.id),
  );
  const identityScope = identityDraft?.scope ?? "all";
  const identitySelected = identityDraft
    ? identitySelection(identityDraft)
    : new Set<string>();
  const workspaceDirty =
    draft !== undefined &&
    savedRule !== undefined &&
    !sameRule(draft, savedRule);
  const identityDirty =
    identityDraft !== undefined &&
    savedIdentity !== undefined &&
    !sameIdentity(identityDraft, savedIdentity);
  const dirty = workspaceDirty || identityDirty;
  const needle = query.trim().toLocaleLowerCase();
  const matches = (workspace: WorkspaceProjection) =>
    !needle ||
    workspace.name.toLocaleLowerCase().includes(needle) ||
    workspace.localPath.toLocaleLowerCase().includes(needle);

  const groups = useMemo<WorkspaceGroup[]>(() => {
    const groups = new Map<string, WorkspaceGroup>();
    for (const device of devices) {
      groups.set(device.id, {
        deviceId: device.id,
        label: device.label,
        online: deviceConnection(device) === "online",
        workspaces: [],
      });
    }
    for (const workspace of available) {
      const deviceId = workspace.deviceId ?? "";
      const group = groups.get(deviceId) ?? {
        deviceId,
        label:
          workspace.deviceLabel ||
          devices.find((device) => device.id === deviceId)?.label ||
          deviceId ||
          t("settings.workspaceAccess.unknownDevice"),
        online: false,
        workspaces: [],
      };
      group.workspaces.push(workspace);
      groups.set(deviceId, group);
    }
    return [...groups.values()].filter((group) => group.workspaces.length > 0);
  }, [available, devices, t]);
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      shown: group.workspaces.filter(matches),
    }))
    .filter((group) => group.shown.length > 0);
  const identityGroups = useMemo<IdentityResourceGroup[]>(() => {
    const statusById = new Map(
      (resources?.sources ?? []).map((source) => [source.id, source]),
    );
    const groups = new Map<string, IdentityResourceGroup>();
    for (const resource of resources?.instances ?? []) {
      if (
        !identityResourceTypes.has(resource.type) ||
        resource.state === "gone"
      )
        continue;
      const group = groups.get(resource.source.id) ?? {
        sourceId: resource.source.id,
        label: resource.source.label,
        online: statusById.get(resource.source.id)?.online ?? false,
        resources: [],
      };
      group.resources.push(resource);
      groups.set(resource.source.id, group);
    }
    return [...groups.values()]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((group) => ({
        ...group,
        resources: [...group.resources].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      }));
  }, [resources]);

  const copyOptions = assistants
    .filter((assistant) => assistant.id !== assistantId)
    .map((assistant) => ({
      value: assistant.id,
      label: assistant.name.trim() || t("defaultName"),
    }));
  const source =
    copyOptions.find((option) => option.value === copySourceId) ??
    copyOptions[0];

  function setListed(ids: Iterable<string>) {
    const allowed = new Set(available.map((workspace) => workspace.id));
    setDraft({
      scope: "listed",
      include: [...new Set(ids)].filter((workspaceId) =>
        allowed.has(workspaceId),
      ),
      exclude: [],
    });
    setSaveError("");
  }

  function toggle(workspaceId: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(workspaceId);
    else next.delete(workspaceId);
    setListed(next);
  }

  function setIdentityListed(ids: Iterable<string>) {
    setIdentityDraft(
      normalizeIdentity({
        scope: "listed",
        allowed: [...ids],
      }),
    );
    setSaveError("");
  }

  function toggleIdentity(resourceId: string, checked: boolean) {
    const next = new Set(identitySelected);
    if (checked) next.add(resourceId);
    else next.delete(resourceId);
    setIdentityListed(next);
  }

  function setDevice(device: WorkspaceGroup, checked: boolean) {
    const next = new Set(selected);
    for (const workspace of device.workspaces) {
      if (checked) next.add(workspace.id);
      else next.delete(workspace.id);
    }
    setListed(next);
  }

  async function save() {
    if (!permissionPackage || !draft || !identityDraft) return;
    setSaving(true);
    setSaveError("");
    try {
      const next = await setAssistantPermissionPackage(assistantId, {
        ...permissionPackage,
        workspaces:
          scope === "all"
            ? { scope: "all", include: [], exclude: [] }
            : {
                scope: "listed",
                include: available
                  .map((workspace) => workspace.id)
                  .filter((workspaceId) => selected.has(workspaceId)),
                exclude: [],
              },
        identityResources:
          identityScope === "all"
            ? { scope: "all", allowed: [] }
            : {
                scope: "listed",
                allowed: [...identitySelected],
              },
      });
      const workspaces = normalizeRule(next.workspaces);
      const identityResources = normalizeIdentity(next.identityResources);
      setPermissionPackage(next);
      setSavedRule(workspaces);
      setDraft(workspaces);
      setSavedIdentity(identityResources);
      setIdentityDraft(identityResources);
      onNotice(t("settings.workspaceAccess.saved"));
    } catch (reason) {
      setSaveError(serverErrorText(reason));
    } finally {
      setSaving(false);
    }
  }

  async function chooseCopy() {
    if (!source) return;
    setCopyBusy(true);
    setCopyError("");
    try {
      const sourcePackage = await getAssistantPermissionPackage(source.value);
      const sourceAllowed =
        (sourcePackage.workspaces.scope ?? "all") === "all"
          ? available.map((workspace) => workspace.id)
          : sourcePackage.workspaces.include;
      const excluded = new Set(sourcePackage.workspaces.exclude);
      const ids = sourceAllowed.filter(
        (workspaceId) =>
          !excluded.has(workspaceId) &&
          available.some((workspace) => workspace.id === workspaceId),
      );
      setCopyOpen(false);
      setPendingCopy({ label: source.label, ids });
    } catch (reason) {
      setCopyError(serverErrorText(reason));
    } finally {
      setCopyBusy(false);
    }
  }

  if (loadError) {
    return (
      <Alert tone="error" title={t("settings.workspaceAccess.loadFailed")}>
        <p>{loadError}</p>
        <Button
          onClick={() => {
            setLoadError("");
            setPermissionPackage(undefined);
            getAssistantPermissionPackage(assistantId).then(
              (pkg) => {
                setPermissionPackage(pkg);
                const workspaces = normalizeRule(pkg.workspaces);
                const identityResources = normalizeIdentity(
                  pkg.identityResources,
                );
                setSavedRule(workspaces);
                setDraft(workspaces);
                setSavedIdentity(identityResources);
                setIdentityDraft(identityResources);
              },
              (reason: unknown) => setLoadError(serverErrorText(reason)),
            );
          }}
          size="sm"
        >
          {t("retry")}
        </Button>
      </Alert>
    );
  }
  if (!draft || !permissionPackage || !identityDraft) {
    return <LoadingState label={t("loading")} layout="block" />;
  }

  return (
    <>
      <SettingsGroup title={t("settings.workspaceAccess.title")}>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="grid max-w-[680px] gap-1">
            <p className="text-sm leading-[1.55] text-ink-muted">
              {scope === "all"
                ? t("settings.workspaceAccess.allDescription")
                : t("settings.workspaceAccess.listedDescription")}
            </p>
            <FieldHint>
              {t("settings.workspaceAccess.newAssistantHint")}
            </FieldHint>
          </div>
          <Badge
            tone={
              scope === "all" || selectedAvailable.length ? "brass" : "neutral"
            }
          >
            {scope === "all"
              ? t("settings.workspaceAccess.allBadge")
              : t("settings.workspaceAccess.selectedCount", {
                  count: selectedAvailable.length,
                })}
          </Badge>
        </div>

        {scope === "all" ? (
          <div className="grid justify-items-start gap-2 rounded-lg bg-control-ghost-hover p-3">
            <ButtonRow gap="wide">
              <ShieldCheck aria-hidden="true" size={16} />
              <strong className="text-sm text-ink">
                {t("settings.workspaceAccess.allTitle")}
              </strong>
            </ButtonRow>
            <p className="text-xs leading-[1.5] text-ink-muted">
              {t("settings.workspaceAccess.allBody")}
            </p>
            <Button
              onClick={() =>
                setListed(
                  available
                    .map((workspace) => workspace.id)
                    .filter(
                      (workspaceId) =>
                        !(draft.exclude ?? []).includes(workspaceId),
                    ),
                )
              }
              size="sm"
            >
              {t("settings.workspaceAccess.chooseSome")}
            </Button>
          </div>
        ) : (
          <>
            <Command
              className="min-h-0 overflow-hidden rounded-lg shadow-hairline"
              shouldFilter={false}
            >
              <div className="relative border-b border-line-soft">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-2.5 left-2.5 text-ink-faint"
                  size={15}
                />
                <CommandInput
                  aria-label={t("settings.workspaceAccess.search")}
                  className="pl-8"
                  onValueChange={setQuery}
                  placeholder={t("settings.workspaceAccess.searchPlaceholder")}
                  value={query}
                />
              </div>
              <CommandList className="max-h-[360px]">
                <CommandEmpty>
                  {t("settings.workspaceAccess.noMatches")}
                </CommandEmpty>
                {visibleGroups.map((group) => {
                  const allSelected = group.workspaces.every((workspace) =>
                    selected.has(workspace.id),
                  );
                  return (
                    <section
                      aria-label={group.label}
                      className="border-b border-line-soft px-1.5 py-1.5 last:border-b-0"
                      key={group.deviceId || "unknown"}
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2 px-1 py-1">
                        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
                          {group.label}
                        </span>
                        <Badge tone={group.online ? "online" : "neutral"}>
                          {group.online
                            ? t("settings.status.online")
                            : t("settings.status.offline")}
                        </Badge>
                        <Button
                          aria-pressed={allSelected}
                          onClick={() => setDevice(group, !allSelected)}
                          size="sm"
                          variant="ghost"
                        >
                          {allSelected
                            ? t("settings.workspaceAccess.clearDevice")
                            : t("settings.workspaceAccess.selectDevice")}
                        </Button>
                      </div>
                      <CommandGroup>
                        {group.shown.map((workspace) => {
                          const checked = selected.has(workspace.id);
                          return (
                            <CommandItem
                              aria-label={t(
                                "settings.workspaceAccess.workspaceLabel",
                                { name: workspace.name },
                              )}
                              key={workspace.id}
                              onSelect={() => toggle(workspace.id, !checked)}
                              value={`${group.deviceId}:${workspace.id}`}
                            >
                              <Checkbox
                                aria-hidden="true"
                                checked={checked}
                                readOnly
                                tabIndex={-1}
                              />
                              <span className="grid min-w-0 flex-1 gap-0.5">
                                <span className="truncate text-sm text-ink">
                                  {workspace.name}
                                </span>
                                <span className="truncate text-2xs text-ink-faint">
                                  {workspace.localPath}
                                </span>
                              </span>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </section>
                  );
                })}
              </CommandList>
            </Command>
            {!available.length ? (
              <Alert tone="info" title={t("settings.workspaceAccess.empty")}>
                {t("settings.workspaceAccess.emptyBody")}
              </Alert>
            ) : null}
          </>
        )}

        <div className="grid min-w-0 gap-3 border-t border-line pt-4">
          <SectionHeader
            level={3}
            title={t("settings.workspaceAccess.identityTitle")}
          />
          {identityScope === "all" ? (
            <div className="grid justify-items-start gap-2 rounded-lg bg-control-ghost-hover p-3">
              <ButtonRow gap="wide">
                <ShieldCheck aria-hidden="true" size={16} />
                <strong className="text-sm text-ink">
                  {t("settings.workspaceAccess.identityAllBadge")}
                </strong>
              </ButtonRow>
              <p className="text-xs leading-[1.5] text-ink-muted">
                {t("settings.workspaceAccess.identityAll")}
              </p>
              <Button
                disabled={resourceReading || !resources}
                onClick={() =>
                  setIdentityListed(
                    (resources?.instances ?? [])
                      .filter(
                        (resource) =>
                          identityResourceTypes.has(resource.type) &&
                          resource.state !== "gone",
                      )
                      .map((resource) => resource.id),
                  )
                }
                size="sm"
              >
                {t("settings.workspaceAccess.identityChooseSome")}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <p className="max-w-[680px] text-sm leading-[1.55] text-ink-muted">
                  {t("settings.workspaceAccess.identityListed")}
                </p>
                <Badge tone="neutral">
                  {t("settings.workspaceAccess.identitySelectedCount", {
                    count: identitySelected.size,
                  })}
                </Badge>
              </div>
              {resourceReading && !resources ? (
                <LoadingState label={t("loading")} layout="block" />
              ) : resourceError ? (
                <Alert
                  tone="error"
                  title={t("settings.workspaceAccess.identityLoadFailed")}
                >
                  <p>{resourceError}</p>
                  <Button
                    onClick={() => {
                      setResourceReading(true);
                      setResourceError("");
                      listResources().then(
                        (list) => {
                          setResources(list);
                          setResourceReading(false);
                        },
                        (reason: unknown) => {
                          setResourceError(serverErrorText(reason));
                          setResourceReading(false);
                        },
                      );
                    }}
                    size="sm"
                  >
                    {t("retry")}
                  </Button>
                </Alert>
              ) : identityGroups.length ? (
                <div className="grid min-w-0 gap-3">
                  {identityGroups.map((group) => (
                    <section
                      aria-label={group.label}
                      className="grid min-w-0 gap-2 border-b border-line-soft pb-3 last:border-b-0 last:pb-0"
                      key={group.sourceId}
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <strong className="min-w-0 flex-1 truncate text-xs text-ink">
                          {group.label}
                        </strong>
                        <Badge tone={group.online ? "online" : "neutral"}>
                          {group.online
                            ? t("settings.status.online")
                            : t("settings.status.offline")}
                        </Badge>
                      </div>
                      <div className="grid min-w-0 gap-2">
                        {group.resources.map((resource) => (
                          <CheckLabel key={resource.id}>
                            <Checkbox
                              aria-label={t(
                                "settings.workspaceAccess.identityResourceLabel",
                                { name: resource.name },
                              )}
                              checked={identitySelected.has(resource.id)}
                              onChange={(event) =>
                                toggleIdentity(
                                  resource.id,
                                  event.target.checked,
                                )
                              }
                            />
                            <span>
                              <span className="text-sm text-ink">
                                {resource.name}
                              </span>
                              <Badge tone={resourceStateTone(resource.state)}>
                                {resourceT(`states.${resource.state}`)}
                              </Badge>
                            </span>
                          </CheckLabel>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <Alert
                  tone="info"
                  title={t("settings.workspaceAccess.identityEmpty")}
                >
                  {t("settings.workspaceAccess.identityEmptyBody")}
                </Alert>
              )}
            </>
          )}
          <FieldHint className="mt-0">
            {t("settings.workspaceAccess.identityExplanation")}
          </FieldHint>
          <FieldHint className="mt-0">
            {t("settings.workspaceAccess.identityLimitation")}
          </FieldHint>
        </div>

        {saveError ? (
          <ToastFeedback
            tone="error"
            title={t("settings.workspaceAccess.saveFailed")}
          >
            {saveError}
          </ToastFeedback>
        ) : null}
        <ButtonRow gap="wide">
          <Button
            aria-busy={saving}
            disabled={saving || !dirty}
            onClick={() => void save()}
            size="sm"
            variant="primary"
          >
            {saving
              ? t("settings.workspaceAccess.saving")
              : t("settings.workspaceAccess.save")}
          </Button>
          <Button
            disabled={saving || !dirty}
            onClick={() => {
              setDraft(savedRule);
              setIdentityDraft(savedIdentity);
              setSaveError("");
            }}
            size="sm"
            variant="ghost"
          >
            {t("settings.discard")}
          </Button>
          <Button
            disabled={saving || copyOptions.length === 0}
            onClick={() => {
              setCopySourceId(source?.value ?? "");
              setCopyError("");
              setCopyOpen(true);
            }}
            size="sm"
            variant="ghost"
          >
            <Copy aria-hidden="true" size={14} />
            {t("settings.workspaceAccess.copy")}
          </Button>
        </ButtonRow>
      </SettingsGroup>

      <Dialog
        footer={
          <>
            <Button onClick={() => setCopyOpen(false)} variant="secondary">
              {t("settings.workspaceAccess.cancel")}
            </Button>
            <Button
              aria-busy={copyBusy}
              disabled={copyBusy || !source}
              onClick={() => void chooseCopy()}
              variant="primary"
            >
              {copyBusy
                ? t("settings.workspaceAccess.copying")
                : t("settings.workspaceAccess.continue")}
            </Button>
          </>
        }
        layout="compact"
        onClose={() => setCopyOpen(false)}
        open={copyOpen}
        title={t("settings.workspaceAccess.copyTitle")}
      >
        <p className="text-sm leading-[1.55] text-ink-muted">
          {t("settings.workspaceAccess.copyBody")}
        </p>
        <SelectMenu
          ariaLabel={t("settings.workspaceAccess.copySource")}
          insideDialog
          onChange={setCopySourceId}
          options={copyOptions}
          value={source?.value ?? ""}
        />
        {copyError ? (
          <ToastFeedback
            tone="error"
            title={t("settings.workspaceAccess.copyFailed")}
          >
            {copyError}
          </ToastFeedback>
        ) : null}
      </Dialog>

      <Dialog
        description={t("settings.workspaceAccess.copyConfirmBody", {
          assistant: pendingCopy?.label ?? "",
          count: pendingCopy?.ids.length ?? 0,
        })}
        footer={
          <>
            <Button
              onClick={() => setPendingCopy(undefined)}
              variant="secondary"
            >
              {t("settings.workspaceAccess.cancel")}
            </Button>
            <Button
              onClick={() => {
                if (pendingCopy) setListed(pendingCopy.ids);
                setPendingCopy(undefined);
              }}
              variant="primary"
            >
              {t("settings.workspaceAccess.replace")}
            </Button>
          </>
        }
        layout="compact"
        onClose={() => setPendingCopy(undefined)}
        open={Boolean(pendingCopy)}
        title={t("settings.workspaceAccess.copyConfirmTitle")}
      />
    </>
  );
}
