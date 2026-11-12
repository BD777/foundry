import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import type {
  AssistantSummary,
  DeviceProjection,
} from "@bd777/foundry-protocol";
import { createAssistant, deleteAssistant, renameAssistant } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty-state";
import { FieldHint, TextInput } from "../../components/ui/field";
import { LoadingState } from "../../components/ui/loading";
import { ManagementRow } from "../../components/ui/management-row";
import { PageHeader } from "../../components/ui/page-header";
import { PageSurface } from "../../components/ui/page-surface";
import { RowMenu } from "../../components/ui/row-menu";
import { SelectMenu } from "../../components/ui/select-menu";
import { deviceConnection } from "../../lib/device-connection";
import { serverErrorText } from "../../lib/errors";
import type { AssistantFeatureEvent } from "./assistant-events";

export interface AssistantListProps {
  assistants: AssistantSummary[];
  devices: DeviceProjection[];
  state: "loading" | "failed" | "ready";
  error?: string;
  onEvent: (event: AssistantFeatureEvent) => void;
  onReload: () => Promise<void>;
}

export function AssistantList({
  assistants,
  devices,
  state,
  error,
  onEvent,
  onReload,
}: AssistantListProps) {
  const { t } = useTranslation("personalAgent");
  const ownedDevices = devices.filter((device) => device.owned);
  const firstDevice =
    ownedDevices.find((device) => deviceConnection(device) === "online") ??
    ownedDevices[0];
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<AssistantSummary>();
  const [name, setName] = useState("");
  const [homeDeviceId, setHomeDeviceId] = useState(firstDevice?.id ?? "");
  const [busy, setBusy] = useState<string>();
  const [dialogError, setDialogError] = useState("");

  useEffect(() => {
    if (!homeDeviceId && firstDevice) setHomeDeviceId(firstDevice.id);
  }, [firstDevice, homeDeviceId]);

  const assistantName = (assistant: AssistantSummary) =>
    assistant.name.trim() || t("defaultName");
  const deviceOf = (assistant: AssistantSummary) =>
    devices.find((device) => device.id === assistant.homeDeviceId);

  function openCreate() {
    setName("");
    setHomeDeviceId(firstDevice?.id ?? "");
    setDialogError("");
    setCreating(true);
  }

  function openRename(assistant: AssistantSummary) {
    setName(assistantName(assistant));
    setDialogError("");
    setRenaming(assistant);
  }

  async function submitCreate(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || !homeDeviceId) return;
    setBusy("create");
    setDialogError("");
    try {
      const created = await createAssistant({
        name: trimmed,
        homeDeviceId,
      });
      setCreating(false);
      onEvent({ type: "assistant.created", assistantId: created.id });
    } catch (reason) {
      setDialogError(serverErrorText(reason));
    } finally {
      setBusy(undefined);
    }
  }

  async function submitRename(): Promise<void> {
    if (!renaming) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy("rename");
    setDialogError("");
    try {
      await renameAssistant(renaming.id, { name: trimmed });
      setRenaming(undefined);
      onEvent({ type: "assistants.changed" });
    } catch (reason) {
      setDialogError(serverErrorText(reason));
    } finally {
      setBusy(undefined);
    }
  }

  async function remove(assistant: AssistantSummary): Promise<void> {
    setBusy(`delete:${assistant.id}`);
    try {
      await deleteAssistant(assistant.id);
      onEvent({ type: "assistants.changed" });
    } catch (reason) {
      onEvent({
        type: "notice.requested",
        message: serverErrorText(reason),
        tone: "error",
      });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <PageSurface variant="assistants">
      <PageHeader
        actions={
          <Button
            disabled={ownedDevices.length === 0}
            onClick={openCreate}
            variant="primary"
          >
            <Plus aria-hidden="true" size={15} />
            {t("assistants.new")}
          </Button>
        }
        description={t("assistants.description")}
        title={t("assistants.title")}
      />

      {state === "loading" ? (
        <LoadingState label={t("assistants.loading")} />
      ) : state === "failed" ? (
        <Alert tone="error" title={t("assistants.loadFailed")}>
          <p>{error}</p>
          <Button onClick={() => void onReload()} size="sm">
            {t("retry")}
          </Button>
        </Alert>
      ) : assistants.length === 0 ? (
        <EmptyState
          body={
            ownedDevices.length
              ? t("assistants.emptyBody")
              : t("assistants.noDeviceBody")
          }
          title={
            ownedDevices.length
              ? t("assistants.emptyTitle")
              : t("assistants.noDeviceTitle")
          }
        />
      ) : (
        <div className="grid min-w-0 gap-3">
          {assistants.map((assistant) => {
            const device = deviceOf(assistant);
            const online = deviceConnection(device) === "online";
            const stopped = assistant.state === "stopped";
            return (
              <ManagementRow
                className="transition-colors hover:bg-control-ghost-hover max-[700px]:flex-nowrap"
                key={assistant.id}
              >
                <Button
                  aria-label={t("assistants.open", {
                    name: assistantName(assistant),
                  })}
                  className="h-auto min-w-0 flex-1 basis-auto justify-start gap-3.5 rounded-lg p-0 text-left leading-normal active:scale-100 max-[700px]:basis-full max-[700px]:flex-wrap max-[700px]:gap-x-2.5 max-[700px]:gap-y-2"
                  onClick={() =>
                    onEvent({
                      type: "assistant.open",
                      assistantId: assistant.id,
                    })
                  }
                  variant="bare"
                >
                  <UserRound
                    aria-hidden="true"
                    className="flex-none text-ink-muted"
                    size={24}
                  />
                  <span className="grid min-w-0 flex-1 gap-[5px] leading-[1.3] whitespace-normal">
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <strong>{assistantName(assistant)}</strong>
                      {assistant.isDefault ? (
                        <Badge tone="brass">{t("assistants.default")}</Badge>
                      ) : null}
                    </span>
                    <small>
                      {device?.label ?? assistant.homeDeviceId}
                      {device ? (
                        <>
                          {" · "}
                          {online
                            ? t("settings.status.online")
                            : t("settings.status.offline")}
                        </>
                      ) : null}
                    </small>
                  </span>
                  <Badge tone={stopped ? "warn" : "online"}>
                    {stopped
                      ? t("assistants.stopped")
                      : t("settings.status.running")}
                  </Badge>
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-ink-muted">
                    {t("assistants.openShort")}
                    <ArrowRight aria-hidden="true" size={14} />
                  </span>
                </Button>
                <RowMenu
                  disabled={busy === `delete:${assistant.id}`}
                  items={[
                    {
                      key: "rename",
                      label: t("assistants.rename"),
                      icon: <Pencil aria-hidden="true" size={15} />,
                      onSelect: () => openRename(assistant),
                    },
                    ...(!assistant.isDefault
                      ? [
                          {
                            key: "delete",
                            label: t("assistants.delete"),
                            icon: <Trash2 aria-hidden="true" size={15} />,
                            tone: "danger" as const,
                            confirm: {
                              title: t("assistants.deleteTitle", {
                                name: assistantName(assistant),
                              }),
                              body: t("assistants.deleteBody", {
                                name: assistantName(assistant),
                              }),
                              action: t("assistants.delete"),
                            },
                            onSelect: () => void remove(assistant),
                          },
                        ]
                      : []),
                  ]}
                  label={t("assistants.actionsFor", {
                    name: assistantName(assistant),
                  })}
                />
              </ManagementRow>
            );
          })}
        </div>
      )}

      <Dialog
        footer={
          <>
            <Button onClick={() => setCreating(false)} variant="secondary">
              {t("assistants.cancel")}
            </Button>
            <Button
              aria-busy={busy === "create"}
              disabled={busy === "create" || !name.trim() || !homeDeviceId}
              onClick={() => void submitCreate()}
              variant="primary"
            >
              {busy === "create"
                ? t("assistants.creating")
                : t("assistants.create")}
            </Button>
          </>
        }
        layout="compact"
        onClose={() => setCreating(false)}
        open={creating}
        title={t("assistants.createTitle")}
      >
        <form
          className="grid gap-3.5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCreate();
          }}
        >
          <label className="grid gap-1.5 text-xs font-semibold text-ink">
            {t("assistants.name")}
            <TextInput
              autoFocus
              onChange={(event) => setName(event.target.value)}
              placeholder={t("assistants.namePlaceholder")}
              tone="boxed"
              value={name}
            />
          </label>
          <div className="grid gap-1.5 text-xs font-semibold text-ink">
            {t("assistants.device")}
            <SelectMenu
              ariaLabel={t("assistants.device")}
              insideDialog
              onChange={setHomeDeviceId}
              options={ownedDevices.map((device) => ({
                value: device.id,
                label: device.label,
                meta:
                  deviceConnection(device) === "online"
                    ? t("settings.status.online")
                    : t("settings.status.offline"),
              }))}
              value={homeDeviceId}
            />
          </div>
          <FieldHint>{t("assistants.createHint")}</FieldHint>
          {dialogError ? (
            <Alert tone="error" title={t("assistants.createFailed")}>
              {dialogError}
            </Alert>
          ) : null}
        </form>
      </Dialog>

      <Dialog
        footer={
          <>
            <Button onClick={() => setRenaming(undefined)} variant="secondary">
              {t("assistants.cancel")}
            </Button>
            <Button
              aria-busy={busy === "rename"}
              disabled={busy === "rename" || !name.trim()}
              onClick={() => void submitRename()}
              variant="primary"
            >
              {busy === "rename"
                ? t("assistants.saving")
                : t("assistants.save")}
            </Button>
          </>
        }
        layout="compact"
        onClose={() => setRenaming(undefined)}
        open={Boolean(renaming)}
        title={t("assistants.renameTitle")}
      >
        <form
          className="grid gap-3.5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          <label className="grid gap-1.5 text-xs font-semibold text-ink">
            {t("assistants.name")}
            <TextInput
              autoFocus
              onChange={(event) => setName(event.target.value)}
              tone="boxed"
              value={name}
            />
          </label>
          {dialogError ? (
            <Alert tone="error" title={t("assistants.renameFailed")}>
              {dialogError}
            </Alert>
          ) : null}
        </form>
      </Dialog>
    </PageSurface>
  );
}
