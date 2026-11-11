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
  PersonalAgentRunSnapshot,
} from "@bd777/foundry-protocol";
import {
  createKnowledgeVault,
  repairKnowledgeIndex,
  resetPendingKnowledgeLocation,
  listKnowledgeMigrations,
  beginKnowledgeMigration,
  cancelKnowledgeMigration,
  listKnowledgeReplicaCleanup,
  previewAssistantMemoryAccount,
  allowAssistantMemory,
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
import { FieldHint, TextInput, Textarea } from "../../components/ui/field";
import { SelectMenu } from "../../components/ui/select-menu";
import { serverErrorText } from "../../lib/errors";
import { PendingKnowledgeWrites } from "./settings-knowledge-pending";
import { SettingsField, SettingsGroup } from "./settings-field";
import { Skeleton } from "../../components/ui/loading";
import { PaMuted } from "./pa-muted";
import { DividedList } from "../../components/ui/divided-list";
import { ButtonRow } from "../../components/ui/button-row";

export function KnowledgeSection({
  devices,
  workspaces,
  profiles,
  onLocation,
}: {
  devices: DeviceProjection[];
  workspaces: WorkspaceProjection[];
  profiles: AgentProfileProjection[];
  onLocation?: (selected: boolean) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const { sourceState, sourceReason } = useKnowledgeStateLabels();
  const [vaults, setVaults] = useState<KnowledgeVault[]>();
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [jobs, setJobs] = useState<KnowledgeMutation[]>([]);
  const [publications, setPublications] = useState<KnowledgePublication[]>([]);
  const [recallPreview, setRecallPreview] =
    useState<PersonalAgentRunSnapshot>();
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
          listKnowledgeVaults(),
          listKnowledgeMutations(),
          listKnowledgePublications(),
          listKnowledgeMigrations(),
          listKnowledgeReplicaCleanup(),
        ]);
      const root =
        roots.find((v) => v.id === selected) ??
        roots.find((v) => v.kind === "memory");
      if (version !== readVersion.current) return;
      setMoves(migrations);
      setCleanup(copyCleanup);
      onLocation?.(roots.some((v) => v.kind === "memory"));
      setVaults(roots);
      setJobs(operations);
      setPublications(grants);
      setEntries([]);
      const sourceEntries = root ? await listKnowledgeEntries(root.id) : [];
      if (version === readVersion.current) setError("");
      if (version === readVersion.current) setEntries(sourceEntries);
    } catch (reason) {
      if (version === readVersion.current) throw reason;
    }
  }, [selected, onLocation]);
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
      createKnowledgeVault({
        kind: "memory",
        deviceId: device,
        workspaceId: workspace === "new" ? "" : workspace,
        rootPath: folder,
        createNew: workspace === "new",
      }),
    );
  }
  async function open(item: KnowledgeEntry) {
    await run(async () => {
      if (!active) return;
      const doc = await readKnowledgeEntry(active.id, item.id);
      setReviewHash("");
      setEntry(item);
      setTitle(item.title);
      setBody(doc.body);
      setExpiry(doc.expiresAt ?? "");
    });
  }
  async function reviewSource(item: KnowledgeEntry) {
    if (!active) return;
    await run(async () => {
      const reviewed = await inspectKnowledgeSource(active.id, item.id);
      setEntry(item);
      setTitle(item.title);
      setBody(reviewed.body);
      setExpiry(item.expiresAt ?? "");
      setReviewHash(reviewed.rawHash);
    });
  }
  async function save() {
    if (!active) return;
    const input = {
      entryId: entry?.id,
      action: reviewHash ? ("adopt" as const) : ("write" as const),
      expectedRawHash: reviewHash || undefined,
      title,
      body,
      expectedRevision: entry?.revision ?? 0,
      expectedHash: entry?.hash ?? "",
      sourceRef: entry?.sourceRef,
      sourceVersion: entry?.sourceVersion,
      expiresAt: expiry,
    };
    const key = JSON.stringify([active.id, input]);
    if (
      await run(() =>
        writeKnowledgeEntry(active.id, { ...input, requestId: requestId(key) }),
      )
    ) {
      requests.current.delete(key);
      setReviewHash("");
      setEntry(undefined);
      setTitle("");
      setBody("");
      setExpiry("");
    }
  }
  async function forget(item: KnowledgeEntry) {
    if (!active) return;
    const input = {
      entryId: item.id,
      action: "forget" as const,
      expectedRevision: item.revision,
      expectedHash: item.hash,
    };
    const key = JSON.stringify([active.id, input]);
    if (
      await run(() =>
        writeKnowledgeEntry(active.id, { ...input, requestId: requestId(key) }),
      )
    ) {
      requests.current.delete(key);
      if (entry?.id === item.id) {
        setEntry(undefined);
        setTitle("");
        setBody("");
        setExpiry("");
        setReviewHash("");
      }
    }
  }
  async function forgetPending(job: KnowledgeMutation) {
    const key = `forget-pending:${job.id}`;
    if (
      await run(async () => {
        const current = (await listKnowledgeEntries(job.vaultId)).find(
          (entry) => entry.id === job.entryId,
        );
        if (current && ["forgetting", "forgotten"].includes(current.state))
          return;
        await writeKnowledgeEntry(job.vaultId, {
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
    if (!active || !entry || reviewHash) return;
    const input = {
      vaultId: active.id,
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
      await run(() => publishKnowledge({ ...input, requestId: requestId(key) }))
    ) {
      requests.current.delete(key);
    }
  }
  const targetWorkspace = workspaces.find((w) => w.id === target);
  return (
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
              {t("knowledge.state", {
                state: sourceState(primary.state),
                reason: sourceReason(primary.reason ?? ""),
              })}
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
                    ? resetPendingKnowledgeLocation(primary.id, input)
                    : beginKnowledgeMigration(primary.id, {
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
                          cancelKnowledgeMigration(m.id, m.revision),
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
          <SettingsGroup title={t("knowledge.recallTitle")}>
            <FieldHint>{t("knowledge.recallHint")}</FieldHint>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setRecallPreview(await previewAssistantMemoryAccount()),
                )
              }
            >
              {t("knowledge.previewRecall")}
            </Button>
            {recallPreview ? (
              <>
                <p>
                  {t("knowledge.recallAccount", {
                    profile: recallPreview.profileId,
                    device:
                      devices.find((d) => d.id === recallPreview.deviceId)
                        ?.label ?? recallPreview.deviceId,
                    provider:
                      recallPreview.providerOrigin || recallPreview.runtime,
                  })}
                </p>
                <FieldHint>
                  {t("knowledge.cachedAccount", {
                    label:
                      recallPreview.accountLabel ||
                      t("knowledge.accountNotNamed"),
                  })}
                </FieldHint>
                <Button
                  disabled={busy || !recallPreview.profileFingerprint}
                  onClick={() =>
                    void run(() =>
                      allowAssistantMemory(
                        primary.id,
                        requestId(
                          JSON.stringify([
                            "recall",
                            primary.id,
                            recallPreview.configHash,
                            publications
                              .filter((p) => p.scope === "memory_root")
                              .map((p) => [p.id, p.revision]),
                          ]),
                        ),
                        recallPreview.configHash,
                      ),
                    )
                  }
                >
                  {t("knowledge.enableRecall")}
                </Button>
              </>
            ) : null}
          </SettingsGroup>
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
                  const v = await createKnowledgeVault({
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
                    workspaces.find((w) => w.id === active.workspaceId)?.name ??
                    active.workspaceId,
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
                  {t("knowledge.state", {
                    state: sourceState(active.state),
                    reason: sourceReason(active.reason ?? ""),
                  })}
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
                        resetPendingKnowledgeLocation(active.id, {
                          revision: active.revision,
                          deviceId: active.deviceId,
                          workspaceId: active.workspaceId,
                          rootPath: retryFolder,
                        }),
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
                void run(() => repairKnowledgeIndex(active.id, active.epoch));
            }}
          >
            {t("knowledge.repairIndex")}
          </ConfirmButton>
          <DividedList density="cozy">
            {entries.map((item) => (
              <li key={item.id} className="grid gap-1.5">
                <p>{item.title || t("knowledge.forgotten")}</p>
                <FieldHint>
                  {t("knowledge.entryState", {
                    revision: item.revision,
                    state:
                      item.expiresAt && Date.parse(item.expiresAt) <= Date.now()
                        ? t("knowledge.expired")
                        : sourceState(item.state),
                    source: item.sourceRef,
                    expiry: item.expiresAt || t("knowledge.noExpiry"),
                  })}
                </FieldHint>
                <ButtonRow gap="wide">
                  <Button
                    size="sm"
                    disabled={busy || item.state !== "active"}
                    onClick={() => void open(item)}
                  >
                    {t("knowledge.inspect")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || item.state !== "active"}
                    onClick={() => void reviewSource(item)}
                  >
                    {t("knowledge.reviewSource")}
                  </Button>
                  <ConfirmButton
                    size="sm"
                    disabled={
                      busy || !["active", "missing"].includes(item.state)
                    }
                    confirmLabel={t("knowledge.forgetConfirm")}
                    onConfirm={() => void forget(item)}
                  >
                    {t("knowledge.forget")}
                  </ConfirmButton>
                </ButtonRow>
              </li>
            ))}
          </DividedList>
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
          <ButtonRow gap="wide">
            <Button
              variant="primary"
              disabled={
                busy ||
                !title.trim() ||
                !body.trim() ||
                active?.state !== "active"
              }
              onClick={() => void save()}
            >
              {entry ? t("knowledge.correct") : t("knowledge.add")}
            </Button>
            {entry ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setEntry(undefined);
                  setTitle("");
                  setBody("");
                  setExpiry("");
                }}
              >
                {t("knowledge.newEntry")}
              </Button>
            ) : null}
          </ButtonRow>
          {entry ? (
            <SettingsGroup title={t("knowledge.publishTitle")}>
              <FieldHint>{t("knowledge.publishHint")}</FieldHint>
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
              <Button
                disabled={busy || !target || !profile || !purpose.trim()}
                onClick={() => void publish()}
              >
                {t("knowledge.publish")}
              </Button>
            </SettingsGroup>
          ) : null}
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
                        workspaces.find((w) => w.id === p.targetWorkspaceId)
                          ?.name ?? p.targetWorkspaceId,
                      profile: p.profileId,
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
                        revokeKnowledgePublication(p.id, p.revision),
                      )
                    }
                  >
                    {t("knowledge.revoke")}
                  </Button>
                </li>
              ))}
          </DividedList>
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
  );
}
