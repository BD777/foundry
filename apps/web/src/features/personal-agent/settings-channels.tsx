import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import type {
  MessageChannelList,
  MessageChannelState,
  MessageChannelView,
} from "@bd777/foundry-protocol";
import {
  deleteMessageChannel,
  listMessageChannels,
  updateMessageChannel,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { Dialog } from "../../components/ui/dialog";
import { DividedList } from "../../components/ui/divided-list";
import { EmptyState } from "../../components/ui/empty-state";
import { Skeleton } from "../../components/ui/loading";
import { RowMenu } from "../../components/ui/row-menu";
import { Switch } from "../../components/ui/switch";
import { ToastFeedback } from "../../components/ui/toast";
import { serverErrorText } from "../../lib/errors";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { inputFromChannel } from "./channel-model";
import { ChannelDeliveries } from "./settings-channel-deliveries";
import { ChannelEditor } from "./settings-channel-editor";
import { PaMuted } from "./pa-muted";
import { PrerequisiteNotice } from "./settings-channel-prerequisites";

const stateTone: Record<MessageChannelState, BadgeProps["tone"]> = {
  starting: "slate",
  running: "online",
  paused: "neutral",
  waiting_device: "warn",
  needs_permission: "error",
  unsupported: "error",
  backing_off: "warn",
  held: "warn",
};

/** The assistant's message channels (DEV-203): list, status, edit. */
export function ChannelsSection({
  assistantId,
  homeWorkspaceId,
  onNotice,
}: {
  assistantId?: string;
  /** Where the channels' sessions live. */
  homeWorkspaceId?: string;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const [list, setList] = useState<MessageChannelList>();
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<MessageChannelView | "new">();

  const load = useCallback(async () => {
    try {
      setList(await listMessageChannels(assistantId));
      setLoadError("");
    } catch (reason) {
      setLoadError(serverErrorText(reason));
    }
  }, [assistantId]);

  useEffect(() => {
    setList(undefined);
    void load();
  }, [load]);

  const replace = (view: MessageChannelView) =>
    setList((current) =>
      current
        ? {
            ...current,
            channels: current.channels.some(
              (entry) => entry.channel.id === view.channel.id,
            )
              ? current.channels.map((entry) =>
                  entry.channel.id === view.channel.id ? view : entry,
                )
              : [...current.channels, view],
          }
        : current,
    );

  if (!list) {
    return loadError ? (
      <Alert
        actions={
          <Button onClick={() => void load()} size="sm">
            {t("settings.channels.retry")}
          </Button>
        }
        title={t("settings.channels.loadFailed")}
        tone="error"
      >
        {loadError}
      </Alert>
    ) : (
      <Skeleton className="h-24" label={t("settings.channels.loading")} />
    );
  }

  const createButton = (
    <Button
      disabled={list.sources.length === 0}
      onClick={() => setEditing("new")}
      size="sm"
      variant={list.channels.length ? "secondary" : "primary"}
    >
      <Plus aria-hidden="true" size={14} />
      {t("settings.channels.new")}
    </Button>
  );

  return (
    <div className="grid min-w-0 gap-4">
      {loadError ? (
        <Alert title={t("settings.channels.loadFailed")} tone="error">
          {loadError}
        </Alert>
      ) : null}
      {list.sources.length === 0 ? (
        <Alert title={t("settings.channels.noSourcesTitle")} tone="info">
          {t("settings.channels.noSources")}
        </Alert>
      ) : null}
      {list.channels.length === 0 ? (
        <div className="grid justify-items-start gap-3">
          <EmptyState
            body={t("settings.channels.emptyBody")}
            className="w-full"
            title={t("settings.channels.emptyTitle")}
          />
          {createButton}
        </div>
      ) : (
        <>
          <ButtonRow>{createButton}</ButtonRow>
          <DividedList density="cozy">
            {list.channels.map((view) => (
              <ChannelRow
                assistantId={assistantId}
                homeWorkspaceId={homeWorkspaceId}
                key={view.channel.id}
                onChanged={replace}
                onDeleted={() => {
                  setList((current) =>
                    current
                      ? {
                          ...current,
                          channels: current.channels.filter(
                            (entry) => entry.channel.id !== view.channel.id,
                          ),
                        }
                      : current,
                  );
                  onNotice(t("settings.channels.deleted"));
                }}
                onEdit={() => setEditing(view)}
                onReload={() => void load()}
                view={view}
              />
            ))}
          </DividedList>
        </>
      )}
      {editing ? (
        <ChannelEditor
          assistantId={assistantId}
          onClose={() => {
            setEditing(undefined);
            void load();
          }}
          onSaved={(view) => {
            replace(view);
            onNotice(t("settings.channels.saved"));
          }}
          sources={list.sources}
          view={editing === "new" ? undefined : editing}
        />
      ) : null}
    </div>
  );
}

function ChannelRow({
  assistantId,
  homeWorkspaceId,
  view,
  onChanged,
  onDeleted,
  onEdit,
  onReload,
}: {
  assistantId?: string;
  homeWorkspaceId?: string;
  view: MessageChannelView;
  onChanged: (view: MessageChannelView) => void;
  onDeleted: () => void;
  onEdit: () => void;
  onReload: () => void;
}) {
  const { t } = useTranslation("personalAgent");
  const { channel, status, prerequisites } = view;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState(false);
  const source = channel.source.label || channel.source.kind;
  const counts = status.counts;

  async function setEnabled(
    enabled: boolean,
    resumeFromNow?: boolean,
  ): Promise<void> {
    setBusy(true);
    setError("");
    try {
      onChanged(
        await updateMessageChannel(
          assistantId,
          channel.id,
          inputFromChannel(channel, {
            enabled,
            ...(resumeFromNow ? { resumeFromNow: true } : {}),
          }),
        ),
      );
      setAsking(false);
    } catch (reason) {
      setError(
        `${t("settings.channels.toggleFailed")}: ${serverErrorText(reason)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await deleteMessageChannel(assistantId, channel.id);
      onDeleted();
    } catch (reason) {
      setError(
        `${t("settings.channels.deleteFailed")}: ${serverErrorText(reason)}`,
      );
      setBusy(false);
    }
  }

  return (
    <li className="grid min-w-0 gap-2.5">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <strong className="text-md wrap-anywhere text-ink">
              {channel.name}
            </strong>
            <Badge dot tone={stateTone[status.state] ?? "neutral"}>
              {t(`settings.channels.state.${status.state}`, {
                defaultValue: status.state,
              })}
            </Badge>
          </span>
          <PaMuted size="xs">
            {source}
            {" · "}
            {status.lastEventAt ? (
              <time
                dateTime={status.lastEventAt}
                title={fullWhen(status.lastEventAt)}
              >
                {t("settings.channels.lastEvent", {
                  when: relativeWhen(status.lastEventAt),
                })}
              </time>
            ) : (
              t("settings.channels.noEvents")
            )}
          </PaMuted>
          {status.detail ? <PaMuted size="xs">{status.detail}</PaMuted> : null}
          <PaMuted size="xs">
            {t("settings.channels.counts", {
              received: counts.received,
              matched: counts.matched,
              delivered: counts.delivered,
              held: counts.held,
            })}
          </PaMuted>
        </span>
        <Switch
          aria-label={t("settings.channels.enable", { name: channel.name })}
          checked={channel.enabled}
          className="mt-1"
          disabled={busy}
          onCheckedChange={(enabled) => {
            if (enabled && status.lastPollAt) setAsking(true);
            else void setEnabled(enabled);
          }}
        />
      </div>
      <PrerequisiteNotice
        accountId={channel.source.accountId}
        assistantId={assistantId}
        onGranted={() => onReload()}
        prerequisites={prerequisites}
      />
      {error ? <ToastFeedback title={error} tone="error" /> : null}
      <ButtonRow>
        <Button
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          size="sm"
          variant="ghost"
        >
          {open ? (
            <ChevronDown aria-hidden="true" size={14} />
          ) : (
            <ChevronRight aria-hidden="true" size={14} />
          )}
          {open
            ? t("settings.channels.deliveries.hide")
            : t("settings.channels.deliveries.show")}
        </Button>
        <Button disabled={busy} onClick={onEdit} size="sm" variant="ghost">
          <Pencil aria-hidden="true" size={14} />
          {t("settings.channels.edit")}
        </Button>
        <RowMenu
          disabled={busy}
          items={[
            {
              key: "delete",
              label: t("settings.channels.delete"),
              icon: <Trash2 aria-hidden="true" size={15} />,
              tone: "danger",
              confirm: {
                title: t("settings.channels.deleteTitle", {
                  name: channel.name,
                }),
                body: t("settings.channels.deleteBody"),
                action: t("settings.channels.deleteAction"),
              },
              onSelect: () => void remove(),
            },
          ]}
          label={t("settings.channels.actionsFor", { name: channel.name })}
        />
      </ButtonRow>
      {open ? (
        <ChannelDeliveries
          assistantId={assistantId}
          channelId={channel.id}
          held={counts.held}
          homeWorkspaceId={homeWorkspaceId}
          onReleased={onReload}
        />
      ) : null}
      <Dialog
        busy={busy}
        description={t("settings.channels.resume.description")}
        footer={
          <>
            <Button
              disabled={busy}
              onClick={() => setAsking(false)}
              variant="ghost"
            >
              {t("settings.channels.resume.cancel")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => void setEnabled(true, true)}
              variant="secondary"
            >
              {t("settings.channels.resume.fromNow")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => void setEnabled(true)}
              variant="primary"
            >
              {t("settings.channels.resume.continue")}
            </Button>
          </>
        }
        layout="compact"
        onClose={() => setAsking(false)}
        open={asking}
        title={t("settings.channels.resume.title", { name: channel.name })}
      />
    </li>
  );
}
