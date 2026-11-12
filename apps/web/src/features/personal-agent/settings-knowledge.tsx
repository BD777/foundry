import { toast } from "../../components/ui/toast";
import {
  KnowledgeDeviceStatus,
  useKnowledgeStateLabels,
} from "./settings-knowledge-location";
import { ownedDeviceCandidates } from "../../lib/devices";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
  WorkspaceProjection,
  KnowledgeVault,
  KnowledgeEntry,
  KnowledgeMutation,
  KnowledgePublication,
  KnowledgeMigration,
  KnowledgeReplicaForget,
  MemoryLayerEntry,
} from "@bd777/foundry-protocol";
import {
  createKnowledgeVault,
  repairKnowledgeIndex,
  resetPendingKnowledgeLocation,
  listKnowledgeMigrations,
  beginKnowledgeMigration,
  cancelKnowledgeMigration,
  listKnowledgeReplicaCleanup,
  listKnowledgeVaults,
  listKnowledgeEntries,
  listKnowledgeMutations,
  listKnowledgePublications,
  readKnowledgeEntry,
  inspectKnowledgeSource,
  writeKnowledgeEntry,
  publishKnowledge,
  revokeKnowledgePublication,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { Dialog } from "../../components/ui/dialog";
import { FieldHint, TextInput, Textarea } from "../../components/ui/field";
import { SelectMenu } from "../../components/ui/select-menu";
import { serverErrorText } from "../../lib/errors";
import { PendingKnowledgeWrites } from "./settings-knowledge-pending";
import { KnowledgeRecallSection } from "./settings-knowledge-recall";
import { MemorySection } from "./settings-memory";
import { SettingsField, SettingsGroup } from "./settings-field";
import { Skeleton } from "../../components/ui/loading";
import { PaMuted } from "./pa-muted";
import { DividedList } from "../../components/ui/divided-list";

export function KnowledgeSection({
  assistantId,
  devices,
  workspaces,
  profiles,
}: {
  assistantId?: string;
  devices: DeviceProjection[];
  workspaces: WorkspaceProjection[];
  profiles: AgentProfileProjection[];
}) {
  const { t } = useTranslation("personalAgent");
  const { sourceState, sourceReason } = useKnowledgeStateLabels();
  const [vaults, setVaults] = useState<KnowledgeVault[]>();
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [jobs, setJobs] = useState<KnowledgeMutation[]>([]);
  const [publications, setPublications] = useState<KnowledgePublication[]>([]);
  const [moves, setMoves] = useState<KnowledgeMigration[]>([]);
  const [cleanup, setCleanup] = useState<KnowledgeReplicaForget[]>([]);
  const [moveDevice, setMoveDevice] = useState("");
  const [moveWorkspace, setMoveWorkspace] = useState("");
  const [movePath, setMovePath] = useState("knowledge");
  const [selected, setSelected] = useState("");
  const [device, setDevice] = useState(
    ownedDeviceCandidates(devices)[0]?.id ?? "",
  );
  const [workspace, setWorkspace] = useState("new");
  const [folder, setFolder] = useState("knowledge");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [entry, setEntry] = useState<KnowledgeEntry>();
  const [entryAction, setEntryAction] = useState<"edit" | "publish">();
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [reviewHash, setReviewHash] = useState("");
  const [expiry, setExpiry] = useState("");
  const [target, setTarget] = useState("");
  const [profile, setProfile] = useState("");
  const [purpose, setPurpose] = useState("");
  const [domain, setDomain] = useState("");
  const [retryFolder, setRetryFolder] = useState("");
  const readVersion = useRef(0);
  const requests = useRef(new Map<string, string>());
  const requestId = (key: string) => {
    let id = requests.current.get(key);
    if (!id) {
      id = crypto.randomUUID();
      requests.current.set(key, id);
    }
    return id;
  };
  const active =
    vaults?.find((v) => v.id === selected) ??
    vaults?.find((v) => v.kind === "memory");
  const primary = vaults?.find((v) => v.kind === "memory");
  const read = useCallback(async () => {
    const version = ++readVersion.current;
    try {
      const [roots, operations, grants, migrations, copyCleanup] =
        await Promise.all([
          listKnowledgeVaults(assistantId),
          listKnowledgeMutations(assistantId),
          listKnowledgePublications(assistantId),
          listKnowledgeMigrations(assistantId),
          listKnowledgeReplicaCleanup(assistantId),
        ]);
      const root =
        roots.find((v) => v.id === selected) ??
        roots.find((v) => v.kind === "memory");
      if (version !== readVersion.current) return;
      setMoves(migrations);
      setCleanup(copyCleanup);
      setVaults(roots);
      setJobs(operations);
      setPublications(grants);
      setEntries([]);
      const sourceEntries = root
        ? await listKnowledgeEntries(assistantId, root.id)
        : [];
      if (version === readVersion.current) setError("");
      if (version === readVersion.current) setEntries(sourceEntries);
    } catch (reason) {
      if (version === readVersion.current) throw reason;
    }
  }, [assistantId, selected]);
  useEffect(() => {
    let current = true;
    void read().catch((reason) => {
      if (current) setError(sourceReason(serverErrorText(reason)));
    });
    return () => {
      current = false;
    };
  }, [read]);
  const waiting =
    vaults?.some((v) => v.state === "waiting" || v.state === "pending") ||
    jobs.some((j) => ["pending", "waiting", "writing"].includes(j.status)) ||
    moves.some((m) => !["complete", "cancelled"].includes(m.state)) ||
    cleanup.some((j) => j.state !== "complete");
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(
      () =>
        void read().catch((reason) =>
          setError(sourceReason(serverErrorText(reason))),
        ),
      3000,
    );
    return () => clearInterval(timer);
  }, [waiting, read]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await read();
      return true;
    } catch (reason) {
      toast({
        tone: "error",
        title: t("knowledge.failed"),
        description: sourceReason(serverErrorText(reason)),
      });
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function locate() {
    await run(() =>
      createKnowledgeVault(assistantId, {
        kind: "memory",
        deviceId: device,
        workspaceId: workspace === "new" ? "" : workspace,
        rootPath: folder,
        createNew: workspace === "new",
      }),
    );
  }
  async function sourceEntry(item: Pick<KnowledgeEntry, "id" | "vaultId">) {
    const sourceEntries = await listKnowledgeEntries(assistantId, item.vaultId);
    const source = sourceEntries.find((candidate) => candidate.id === item.id);
    if (!source) throw new Error("knowledge entry was not found");
    return source;
  }
  async function open(item: Pick<KnowledgeEntry, "id" | "vaultId">) {
    await run(async () => {
      const source = await sourceEntry(item);
      const doc = await readKnowledgeEntry(
        assistantId,
        source.vaultId,
        source.id,
      );
      setReviewHash("");
      setEntry(source);
      setEntryAction("edit");
      setTitle(source.title);
      setBody(doc.body);
      setExpiry(doc.expiresAt ?? "");
    });
  }
  async function reviewSource(item: Pick<KnowledgeEntry, "id" | "vaultId">) {
    await run(async () => {
      const source = await sourceEntry(item);
      const reviewed = await inspectKnowledgeSource(
        assistantId,
        source.vaultId,
        source.id,
      );
      setEntry(source);
      setEntryAction("edit");
      setTitle(source.title);
      setBody(reviewed.body);
      setExpiry(source.expiresAt ?? "");
      setReviewHash(reviewed.rawHash);
    });
  }
  async function publishEntry(item: Pick<KnowledgeEntry, "id" | "vaultId">) {
    await run(async () => {
      const source = await sourceEntry(item);
      setEntry(source);
      setEntryAction("publish");
      setReviewHash("");
      setTarget("");
      setProfile("");
      setPurpose("");
    });
  }
  async function save() {
    if (!entry) return;
    const input = {
      entryId: entry.id,
      action: reviewHash ? ("adopt" as const) : ("write" as const),
      expectedRawHash: reviewHash || undefined,
      title,
      body,
      expectedRevision: entry.revision,
      expectedHash: entry.hash,
      sourceRef: entry.sourceRef,
      sourceVersion: entry.sourceVersion,
      expiresAt: expiry,
    };
    const key = JSON.stringify([entry.vaultId, input]);
    if (
      await run(() =>
        writeKnowledgeEntry(assistantId, entry.vaultId, {
          ...input,
          requestId: requestId(key),
        }),
      )
    ) {
      requests.current.delete(key);
      setReviewHash("");
      setEntry(undefined);
      setEntryAction(undefined);
      setTitle("");
      setBody("");
      setExpiry("");
      setMemoryRefresh((value) => value + 1);
    }
  }
  async function forgetPending(job: KnowledgeMutation) {
    const key = `forget-pending:${job.id}`;
    if (
      await run(async () => {
        const current = (
          await listKnowledgeEntries(assistantId, job.vaultId)
        ).find((entry) => entry.id === job.entryId);
        if (current && ["forgetting", "forgotten"].includes(current.state))
          return;
        await writeKnowledgeEntry(assistantId, job.vaultId, {
          requestId: requestId(key),
          action: "forget",
          entryId: job.entryId,
          expectedRevision: current?.revision ?? 0,
          expectedHash: current?.hash ?? "",
        });
      })
    )
      requests.current.delete(key);
  }
  async function publish() {
    if (!entry || reviewHash) return;
    const input = {
      vaultId: entry.vaultId,
      entryId: entry.id,
      sourceEpoch: entry.epoch,
      sourceRevision: entry.revision,
      sourceHash: entry.hash,
      targetWorkspaceId: target,
      profileId: profile,
      purpose,
    };
    const key = JSON.stringify(input);
    if (
      await run(() =>
        publishKnowledge(assistantId, {
          ...input,
          requestId: requestId(key),
        }),
      )
    ) {
      requests.current.delete(key);
      setEntry(undefined);
      setEntryAction(undefined);
      setMemoryRefresh((value) => value + 1);
    }
  }
  function closeEntryAction() {
    setEntry(undefined);
    setEntryAction(undefined);
    setTitle("");
    setBody("");
    setExpiry("");
    setReviewHash("");
  }
  const targetWorkspace = workspaces.find((w) => w.id === target);
  const entrySource = entry?.sourceRef.includes("user-input:")
    ? t("knowledge.sourceConversation")
    : entry?.sourceRef.startsWith("user-review:")
      ? t("knowledge.sourceReview")
      : t("knowledge.sourceFile");
  return (
    <div className="grid gap-6">
      <MemorySection
        assistantId={assistantId}
        entryActionBusy={busy}
        onCorrect={(item: MemoryLayerEntry) => void open(item)}
        onPublish={(item: MemoryLayerEntry) => void publishEntry(item)}
        onReviewSource={(item: MemoryLayerEntry) => void reviewSource(item)}
        refreshToken={memoryRefresh}
      />
      <SettingsGroup title={t("knowledge.title")}>
        <PaMuted className="max-w-[680px] leading-[1.6]" size="sm">
          {t("knowledge.intro")}
        </PaMuted>
        <FieldHint>{t("knowledge.isolationHint")}</FieldHint>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void run(async () => {})}
        >
          {t("maintenance.refresh")}
        </Button>
        {error ? (
          <Alert tone="error" title={t("knowledge.failed")}>
            {error}
            <Button size="sm" onClick={() => void run(async () => {})}>
              {t("retry")}
            </Button>
          </Alert>
        ) : null}
        {!vaults ? (
          <Skeleton label={t("loading")} rows={3} />
        ) : !primary ? (
          <>
            <SettingsField
              label={t("knowledge.device")}
              hint={t("knowledge.independent")}
            >
              <SelectMenu
                ariaLabel={t("knowledge.device")}
                value={device}
                disabled={busy}
                onChange={(value) => {
                  setDevice(value);
                  setWorkspace("new");
                }}
                options={ownedDeviceCandidates(devices).map((d) => ({
                  value: d.id,
                  label: d.label,
                  detail:
                    d.status === "connected"
                      ? t("knowledge.connected")
                      : t("knowledge.offline"),
                }))}
              />
            </SettingsField>
            <SettingsField
              label={t("knowledge.workspace")}
              hint={t("knowledge.private")}
            >
              <SelectMenu
                ariaLabel={t("knowledge.workspace")}
                value={workspace}
                disabled={busy}
                onChange={setWorkspace}
                options={[
                  { value: "new", label: t("knowledge.newWorkspace") },
                  ...workspaces
                    .filter(
                      (w) =>
                        w.deviceId === device &&
                        w.accessRole === "owner" &&
                        !w.archivedAt,
                    )
                    .map((w) => ({ value: w.id, label: w.name })),
                ]}
              />
            </SettingsField>
            <SettingsField
              label={t("knowledge.folder")}
              htmlFor="pa-knowledge-folder"
            >
              <TextInput
                id="pa-knowledge-folder"
                tone="boxed"
                value={folder}
                disabled={busy}
                onChange={(e) => setFolder(e.target.value)}
              />
            </SettingsField>
            <Button
              variant="primary"
              disabled={busy || !device || !folder.trim()}
              onClick={() => void locate()}
            >
              {t("knowledge.useLocation")}
            </Button>
          </>
        ) : (
          <>
            <p>
              {t("knowledge.location", {
                workspace:
                  workspaces.find((w) => w.id === primary.workspaceId)?.name ??
                  primary.workspaceId,
                device:
                  devices.find((d) => d.id === primary.deviceId)?.label ??
                  primary.deviceId,
                path: primary.rootPath,
              })}
            </p>
            <KnowledgeDeviceStatus
              device={devices.find((d) => d.id === primary.deviceId)}
            >
              <p role="status">
                {t(
                  primary.state === "active"
                    ? "knowledge.locationReady"
                    : "knowledge.locationPending",
                )}
              </p>
            </KnowledgeDeviceStatus>
            <FieldHint>{t("knowledge.migrationHint")}</FieldHint>
            <SettingsGroup title={t("knowledge.moveTitle")}>
              <FieldHint>
                {t(
                  primary.state === "active"
                    ? "knowledge.moveHint"
                    : "knowledge.retryInitialHint",
                )}
              </FieldHint>
              <SettingsField label={t("knowledge.moveDevice")}>
                <SelectMenu
                  ariaLabel={t("knowledge.moveDevice")}
                  disabled={busy}
                  value={moveDevice}
                  onChange={(value) => {
                    setMoveDevice(value);
                    setMoveWorkspace("");
                  }}
                  options={ownedDeviceCandidates(devices).map((d) => ({
                    value: d.id,
                    label: d.label,
                  }))}
                />
              </SettingsField>
              <SettingsField label={t("knowledge.moveWorkspace")}>
                <SelectMenu
                  ariaLabel={t("knowledge.moveWorkspace")}
                  disabled={busy || !moveDevice}
                  value={moveWorkspace}
                  onChange={setMoveWorkspace}
                  options={workspaces
                    .filter(
                      (w) =>
                        w.deviceId === moveDevice &&
                        w.accessRole === "owner" &&
                        !w.archivedAt,
                    )
                    .map((w) => ({ value: w.id, label: w.name }))}
                />
              </SettingsField>
              <SettingsField
                label={t("knowledge.movePath")}
                htmlFor="pa-memory-move-path"
              >
                <TextInput
                  id="pa-memory-move-path"
                  tone="boxed"
                  disabled={busy}
                  value={movePath}
                  onChange={(e) => setMovePath(e.target.value)}
                />
              </SettingsField>
              <Button
                disabled={
                  busy ||
                  !primary ||
                  !["active", "pending", "waiting"].includes(primary.state) ||
                  !moveWorkspace ||
                  !movePath.trim() ||
                  (moveDevice === primary.deviceId &&
                    moveWorkspace === primary.workspaceId &&
                    movePath === primary.rootPath) ||
                  moves.some(
                    (m) =>
                      m.vaultId === primary.id &&
                      !["complete", "cancelled"].includes(m.state),
                  )
                }
                onClick={() => {
                  if (!primary) return;
                  const input = {
                    revision: primary.revision,
                    deviceId: moveDevice,
                    workspaceId: moveWorkspace,
                    rootPath: movePath,
                  };
                  void run(() =>
                    primary.state !== "active"
                      ? resetPendingKnowledgeLocation(
                          assistantId,
                          primary.id,
                          input,
                        )
                      : beginKnowledgeMigration(assistantId, primary.id, {
                          ...input,
                          requestId: requestId(
                            JSON.stringify(["move", primary.id, input]),
                          ),
                        }),
                  );
                }}
              >
                {t(
                  primary.state === "active"
                    ? "knowledge.move"
                    : "knowledge.retryInitial",
                )}
              </Button>
              {moves
                .filter((m) => m.vaultId === primary?.id)
                .map((m) => (
                  <div
                    className="grid min-w-0 justify-items-start gap-1.5"
                    key={m.id}
                  >
                    <p role="status">
                      {t("knowledge.moveProgress", {
                        state: sourceState(m.state),
                        copied: m.cursor,
                        total: m.manifest?.length ?? 0,
                        reason: sourceReason(m.reason ?? ""),
                      })}
                    </p>
                    <FieldHint>
                      {t("knowledge.moveRoute", {
                        from:
                          devices.find((d) => d.id === m.source.deviceId)
                            ?.label ?? m.source.deviceId,
                        to:
                          devices.find((d) => d.id === m.target.deviceId)
                            ?.label ?? m.target.deviceId,
                      })}
                    </FieldHint>
                    {![
                      "complete",
                      "cancelled",
                      "activating",
                      "retiring",
                    ].includes(m.state) ? (
                      <Button
                        size="sm"
                        disabled={busy || m.cancelRequested}
                        onClick={() =>
                          void run(() =>
                            cancelKnowledgeMigration(
                              assistantId,
                              m.id,
                              m.revision,
                            ),
                          )
                        }
                      >
                        {m.cancelRequested
                          ? t("knowledge.cancelWaiting")
                          : t("knowledge.cancelMove")}
                      </Button>
                    ) : null}
                  </div>
                ))}
              {cleanup
                .filter(
                  (j) => j.vaultId === primary?.id && j.state !== "complete",
                )
                .map((j) => (
                  <p role="status" key={j.id}>
                    {t("knowledge.copyCleanup", {
                      state: sourceState(j.state),
                      reason: sourceReason(j.reason ?? ""),
                    })}
                  </p>
                ))}
            </SettingsGroup>
            <KnowledgeRecallSection
              assistantId={assistantId}
              busy={busy}
              devices={devices}
              primaryId={primary.id}
              publications={publications}
              requestId={requestId}
              run={run}
            />
            <SettingsGroup title={t("knowledge.domainTitle")}>
              <FieldHint>{t("knowledge.domainHint")}</FieldHint>
              <SettingsField label={t("knowledge.domainWorkspace")}>
                <SelectMenu
                  ariaLabel={t("knowledge.domainWorkspace")}
                  value={domain}
                  disabled={busy}
                  onChange={setDomain}
                  options={workspaces
                    .filter((w) => w.accessRole === "owner" && !w.archivedAt)
                    .map((w) => ({ value: w.id, label: w.name }))}
                />
              </SettingsField>
              <Button
                disabled={busy || !domain}
                onClick={() =>
                  void run(async () => {
                    const w = workspaces.find((w) => w.id === domain);
                    if (!w?.deviceId) return;
                    const v = await createKnowledgeVault(assistantId, {
                      kind: "domain",
                      workspaceId: w.id,
                      deviceId: w.deviceId,
                      rootPath: "domain-knowledge",
                    });
                    setSelected(v.id);
                    setEntry(undefined);
                    setTitle("");
                    setBody("");
                    setExpiry("");
                  })
                }
              >
                {t("knowledge.addDomain")}
              </Button>
            </SettingsGroup>

            {vaults.length > 1 ? (
              <SettingsField label={t("knowledge.source")}>
                <SelectMenu
                  ariaLabel={t("knowledge.source")}
                  value={active?.id ?? ""}
                  onChange={(value) => {
                    setSelected(value);
                    setRetryFolder("");
                    setReviewHash("");
                    setExpiry("");
                    setEntry(undefined);
                    setTitle("");
                    setBody("");
                  }}
                  options={vaults.map((v) => ({
                    value: v.id,
                    label:
                      workspaces.find((w) => w.id === v.workspaceId)?.name ??
                      v.workspaceId,
                    detail: v.kind,
                  }))}
                />
              </SettingsField>
            ) : null}
            {active?.kind === "domain" ? (
              <>
                <FieldHint>
                  {t("knowledge.location", {
                    workspace:
                      workspaces.find((w) => w.id === active.workspaceId)
                        ?.name ?? active.workspaceId,
                    device:
                      devices.find((d) => d.id === active.deviceId)?.label ??
                      active.deviceId,
                    path: active.rootPath,
                  })}
                </FieldHint>
                <KnowledgeDeviceStatus
                  device={devices.find((d) => d.id === active.deviceId)}
                >
                  <p role="status">
                    {t(
                      active.state === "active"
                        ? "knowledge.locationReady"
                        : "knowledge.locationPending",
                    )}
                  </p>
                </KnowledgeDeviceStatus>
                {["pending", "waiting"].includes(active.state) ? (
                  <>
                    <SettingsField
                      label={t("knowledge.retryInitialFolder")}
                      htmlFor="pa-domain-retry-folder"
                    >
                      <TextInput
                        id="pa-domain-retry-folder"
                        tone="boxed"
                        value={retryFolder}
                        disabled={busy}
                        onChange={(e) => setRetryFolder(e.target.value)}
                      />
                    </SettingsField>
                    <Button
                      size="sm"
                      disabled={
                        busy ||
                        !retryFolder.trim() ||
                        retryFolder === active.rootPath
                      }
                      onClick={() =>
                        void run(() =>
                          resetPendingKnowledgeLocation(
                            assistantId,
                            active.id,
                            {
                              revision: active.revision,
                              deviceId: active.deviceId,
                              workspaceId: active.workspaceId,
                              rootPath: retryFolder,
                            },
                          ),
                        )
                      }
                    >
                      {t("knowledge.retryInitial")}
                    </Button>
                  </>
                ) : null}
              </>
            ) : null}
            <FieldHint>{t("knowledge.forgetScope")}</FieldHint>
            <ConfirmButton
              size="sm"
              disabled={busy || !active || active.state !== "active"}
              confirmLabel={t("knowledge.repairConfirm")}
              onConfirm={() => {
                if (active)
                  void run(() =>
                    repairKnowledgeIndex(assistantId, active.id, active.epoch),
                  );
              }}
            >
              {t("knowledge.repairIndex")}
            </ConfirmButton>
            {publications.some((p) => p.vaultId === active?.id) ? (
              <SettingsGroup title={t("knowledge.publishedTitle")}>
                <DividedList density="cozy">
                  {publications
                    .filter((p) => p.vaultId === active?.id)
                    .map((p) => (
                      <li key={p.id} className="grid gap-1.5">
                        <p>
                          {t("knowledge.published", {
                            purpose:
                              p.scope === "memory_root"
                                ? t("knowledge.recallTitle")
                                : p.purpose,
                            workspace:
                              workspaces.find(
                                (w) => w.id === p.targetWorkspaceId,
                              )?.name ?? t("knowledge.unknownWorkspace"),
                            profile:
                              profiles.find((item) => item.id === p.profileId)
                                ?.label ?? t("knowledge.unknownAccount"),
                            state: p.needsReview
                              ? t("knowledge.authorizationReview")
                              : sourceState(p.state),
                          })}
                        </p>
                        <Button
                          size="sm"
                          disabled={busy || p.state !== "active"}
                          onClick={() =>
                            void run(() =>
                              revokeKnowledgePublication(
                                assistantId,
                                p.id,
                                p.revision,
                              ),
                            )
                          }
                        >
                          {t("knowledge.revoke")}
                        </Button>
                      </li>
                    ))}
                </DividedList>
              </SettingsGroup>
            ) : null}
            <PendingKnowledgeWrites
              jobs={jobs}
              vaultId={active?.id}
              entries={entries}
              busy={busy}
              onForget={forgetPending}
              sourceState={sourceState}
              sourceReason={sourceReason}
            />
            <FieldHint>{t("knowledge.forgetLimits")}</FieldHint>
          </>
        )}
      </SettingsGroup>
      <Dialog
        description={
          entry
            ? t("knowledge.entryOrigin", {
                source: entrySource,
                revision: entry.revision,
              })
            : ""
        }
        footer={
          <>
            <Button
              disabled={busy}
              onClick={closeEntryAction}
              variant="secondary"
            >
              {t("knowledge.cancelShare")}
            </Button>
            <Button
              aria-busy={busy}
              disabled={busy || !title.trim() || !body.trim()}
              onClick={() => void save()}
              variant="primary"
            >
              {reviewHash ? t("knowledge.adopt") : t("knowledge.correct")}
            </Button>
          </>
        }
        onClose={closeEntryAction}
        open={entryAction === "edit"}
        title={
          reviewHash ? t("knowledge.adoptTitle") : t("knowledge.editTitle")
        }
      >
        {reviewHash ? (
          <Alert tone="warning" title={t("knowledge.adoptTitle")}>
            {t("knowledge.adoptHint")}
          </Alert>
        ) : null}
        <FieldHint>{t("knowledge.capacity")}</FieldHint>
        <SettingsField
          label={t("knowledge.entryTitle")}
          htmlFor="pa-knowledge-title"
        >
          <TextInput
            id="pa-knowledge-title"
            tone="boxed"
            value={title}
            disabled={busy}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </SettingsField>
        <SettingsField
          className="max-w-2xl"
          label={t("knowledge.body")}
          htmlFor="pa-knowledge-body"
        >
          <Textarea
            className="w-full"
            id="pa-knowledge-body"
            value={body}
            disabled={busy}
            maxLength={128 * 1024}
            onChange={(e) => setBody(e.target.value)}
            resize="vertical"
            rows={6}
            tone="boxed"
          />
        </SettingsField>
        <SettingsField
          label={t("knowledge.expiry")}
          htmlFor="pa-knowledge-expiry"
          hint={t("knowledge.expiryHint")}
        >
          <TextInput
            id="pa-knowledge-expiry"
            tone="boxed"
            value={expiry}
            disabled={busy}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </SettingsField>
      </Dialog>
      <Dialog
        description={t("knowledge.publishHint")}
        footer={
          <>
            <Button
              disabled={busy}
              onClick={closeEntryAction}
              variant="secondary"
            >
              {t("knowledge.cancelEdit")}
            </Button>
            <Button
              aria-busy={busy}
              disabled={busy || !target || !profile || !purpose.trim()}
              onClick={() => void publish()}
              variant="primary"
            >
              {t("knowledge.publish")}
            </Button>
          </>
        }
        onClose={closeEntryAction}
        open={entryAction === "publish"}
        title={t("knowledge.publishTitle")}
      >
        <SettingsField label={t("knowledge.target")}>
          <SelectMenu
            ariaLabel={t("knowledge.target")}
            value={target}
            disabled={busy}
            onChange={(value) => {
              setTarget(value);
              setProfile("");
            }}
            options={workspaces
              .filter((w) => w.accessRole !== "viewer" && !w.archivedAt)
              .map((w) => ({ value: w.id, label: w.name }))}
          />
        </SettingsField>
        <SettingsField label={t("knowledge.account")}>
          <SelectMenu
            ariaLabel={t("knowledge.account")}
            value={profile}
            disabled={busy || !target}
            onChange={setProfile}
            options={profiles
              .filter((p) => p.deviceId === targetWorkspace?.deviceId)
              .map((p) => ({ value: p.id, label: p.label }))}
          />
        </SettingsField>
        <SettingsField
          label={t("knowledge.purpose")}
          htmlFor="pa-knowledge-purpose"
        >
          <TextInput
            id="pa-knowledge-purpose"
            tone="boxed"
            value={purpose}
            maxLength={500}
            disabled={busy}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </SettingsField>
      </Dialog>
    </div>
  );
}
