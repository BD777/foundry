import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftRight,
  FilePenLine,
  Pencil,
  Share2,
  Trash2,
} from "lucide-react";
import type {
  AssistantMemoryLayers,
  MemoryLayer,
  MemoryLayerEntry,
  MemoryLayerScope,
} from "@bd777/foundry-protocol";
import {
  addAssistantMemoryLayerEntry,
  listAssistantMemoryLayers,
  moveAssistantMemoryEntry,
  writeKnowledgeEntry,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import { DividedList } from "../../components/ui/divided-list";
import { FieldHint, TextInput } from "../../components/ui/field";
import { FieldLabel, FormFieldGroup } from "../../components/ui/form-field";
import { Skeleton } from "../../components/ui/loading";
import { RowMenu, type RowMenuItem } from "../../components/ui/row-menu";
import { ToastFeedback } from "../../components/ui/toast";
import { serverErrorText } from "../../lib/errors";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { memoryItemMaxChars } from "./assistant-model";
import { PaMuted } from "./pa-muted";
import { SettingsGroup } from "./settings-field";

const scopes: MemoryLayerScope[] = ["person", "assistant"];

function titleFromContent(content: string): string {
  const firstLine = content.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return [...firstLine].slice(0, 80).join("") || content.trim().slice(0, 80);
}

function hasReviewableSource(sourceRef?: string): boolean {
  const ref = sourceRef?.trim() ?? "";
  return Boolean(ref) && !ref.includes("user-input:");
}

/**
 * The two recall scopes: the person's shared layer and this assistant's own.
 * Entries can be added to either, moved between them, or forgotten.
 */
export function MemorySection({
  assistantId,
  entryActionBusy = false,
  onCorrect,
  onPublish,
  onReviewSource,
  refreshToken = 0,
}: {
  assistantId?: string;
  entryActionBusy?: boolean;
  onCorrect?: (entry: MemoryLayerEntry) => void;
  onPublish?: (entry: MemoryLayerEntry) => void;
  onReviewSource?: (entry: MemoryLayerEntry) => void;
  refreshToken?: number;
}) {
  const { t } = useTranslation("personalAgent");
  const [layers, setLayers] = useState<AssistantMemoryLayers>();
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<string>();
  const [pendingMove, setPendingMove] = useState<{
    entry: MemoryLayerEntry;
    toScope: MemoryLayerScope;
  }>();
  const [pendingForget, setPendingForget] = useState<MemoryLayerEntry>();

  const read = useCallback(async () => {
    try {
      setLayers(await listAssistantMemoryLayers(assistantId));
      setLoadError("");
    } catch (reason) {
      setLoadError(serverErrorText(reason));
    }
  }, [assistantId]);

  useEffect(() => {
    setLayers(undefined);
    setLoadError("");
    void read();
  }, [read, refreshToken]);

  async function add(
    scope: MemoryLayerScope,
    content: string,
    expiresAt: string,
  ) {
    const text = content.trim();
    if (!text) return;
    setBusy(`add:${scope}`);
    setError("");
    setStatus("");
    try {
      await addAssistantMemoryLayerEntry(assistantId, scope, {
        requestId: crypto.randomUUID(),
        title: titleFromContent(text),
        body: text,
        expiresAt: expiresAt.trim() || undefined,
      });
      await read();
      setStatus(t("settings.memory.addedPending"));
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setBusy(undefined);
    }
  }

  async function forget() {
    if (!pendingForget) return;
    setBusy(`forget:${pendingForget.id}`);
    setError("");
    setStatus("");
    try {
      await writeKnowledgeEntry(assistantId, pendingForget.vaultId, {
        requestId: crypto.randomUUID(),
        action: "forget",
        entryId: pendingForget.id,
        expectedRevision: pendingForget.revision,
        expectedHash: pendingForget.hash,
      });
      setPendingForget(undefined);
      await read();
      setStatus(t("settings.memory.forgetPending"));
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setBusy(undefined);
    }
  }

  async function move() {
    if (!pendingMove) return;
    setBusy(`move:${pendingMove.entry.id}`);
    setError("");
    setStatus("");
    try {
      await moveAssistantMemoryEntry(assistantId, pendingMove.entry.id, {
        toScope: pendingMove.toScope,
        expectedRevision: pendingMove.entry.revision,
        expectedHash: pendingMove.entry.hash,
      });
      setPendingMove(undefined);
      await read();
      setStatus(t("settings.memory.movedPending"));
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setBusy(undefined);
    }
  }

  if (loadError && !layers)
    return (
      <Alert tone="error" title={t("settings.memory.loadFailed")}>
        <p>{loadError}</p>
        <Button onClick={() => void read()} size="sm">
          {t("retry")}
        </Button>
      </Alert>
    );
  if (!layers) return <Skeleton label={t("loading")} rows={4} variant="rows" />;

  return (
    <div className="grid gap-6">
      {error ? (
        <ToastFeedback tone="error" title={t("settings.memory.failed")}>
          {error}
        </ToastFeedback>
      ) : null}
      {status ? (
        <FieldHint as="div" className="mt-0" role="status" tone="info">
          {status}
        </FieldHint>
      ) : null}
      {layers.legacyUncopied > 0 ? (
        <FieldHint className="mt-0">
          {t("settings.memory.legacyCopying", {
            count: layers.legacyUncopied,
          })}
        </FieldHint>
      ) : null}
      {scopes.map((scope) => (
        <MemoryLayerSection
          busy={busy}
          key={scope}
          layer={layers.layers.find((layer) => layer.scope === scope)}
          entryActionBusy={entryActionBusy}
          onAdd={(content, expiresAt) => void add(scope, content, expiresAt)}
          onCorrect={onCorrect}
          onForget={setPendingForget}
          onMove={(entry, toScope) => setPendingMove({ entry, toScope })}
          onPublish={onPublish}
          onReviewSource={onReviewSource}
          scope={scope}
        />
      ))}

      <Dialog
        description={
          pendingMove
            ? t(
                pendingMove.toScope === "person"
                  ? "settings.memory.moveToSharedBody"
                  : "settings.memory.moveToAssistantBody",
                { title: pendingMove.entry.title },
              )
            : ""
        }
        footer={
          <>
            <Button
              onClick={() => setPendingMove(undefined)}
              variant="secondary"
            >
              {t("settings.memory.cancel")}
            </Button>
            <Button
              aria-busy={busy?.startsWith("move:")}
              disabled={busy?.startsWith("move:")}
              onClick={() => void move()}
              variant="primary"
            >
              {busy?.startsWith("move:")
                ? t("settings.memory.moving")
                : t("settings.memory.moveConfirm")}
            </Button>
          </>
        }
        layout="compact"
        onClose={() => setPendingMove(undefined)}
        open={Boolean(pendingMove)}
        title={t(
          pendingMove?.toScope === "person"
            ? "settings.memory.moveToSharedTitle"
            : "settings.memory.moveToAssistantTitle",
        )}
      />
      <Dialog
        description={
          pendingForget
            ? t("settings.memory.forgetBody", {
                title: pendingForget.title,
              })
            : ""
        }
        footer={
          <>
            <Button
              onClick={() => setPendingForget(undefined)}
              variant="secondary"
            >
              {t("settings.memory.cancel")}
            </Button>
            <Button
              aria-busy={busy?.startsWith("forget:")}
              disabled={busy?.startsWith("forget:")}
              onClick={() => void forget()}
              variant="danger"
            >
              {busy?.startsWith("forget:")
                ? t("settings.memory.forgetting")
                : t("settings.memory.forgetConfirm")}
            </Button>
          </>
        }
        layout="compact"
        onClose={() => setPendingForget(undefined)}
        open={Boolean(pendingForget)}
        title={t("settings.memory.forgetTitle")}
      />
    </div>
  );
}

function MemoryLayerSection({
  busy,
  entryActionBusy,
  layer,
  onAdd,
  onCorrect,
  onForget,
  onMove,
  onPublish,
  onReviewSource,
  scope,
}: {
  busy?: string;
  entryActionBusy: boolean;
  layer?: MemoryLayer;
  onAdd: (content: string, expiresAt: string) => void;
  onCorrect?: (entry: MemoryLayerEntry) => void;
  onForget: (entry: MemoryLayerEntry) => void;
  onMove: (entry: MemoryLayerEntry, toScope: MemoryLayerScope) => void;
  onPublish?: (entry: MemoryLayerEntry) => void;
  onReviewSource?: (entry: MemoryLayerEntry) => void;
  scope: MemoryLayerScope;
}) {
  const { t } = useTranslation("personalAgent");
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const adding = busy === `add:${scope}`;
  const entries = layer?.entries ?? [];
  const title = t(`settings.memory.layers.${scope}.title`);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || adding) return;
    onAdd(draft, expiresAt);
    setDraft("");
    setExpiresAt("");
  }

  return (
    <SettingsGroup title={title}>
      <FieldHint className="mt-0">
        {t(`settings.memory.layers.${scope}.intro`)}
      </FieldHint>
      <form className="grid max-w-xl gap-3" onSubmit={submit}>
        <FormFieldGroup>
          <FieldLabel htmlFor={inputId}>
            {t("settings.memory.addLabel")}
          </FieldLabel>
          <TextInput
            aria-label={t("settings.memory.addLabelFor", { layer: title })}
            className="w-full"
            disabled={adding}
            id={inputId}
            maxLength={memoryItemMaxChars}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t(`settings.memory.layers.${scope}.placeholder`)}
            tone="boxed"
            value={draft}
          />
        </FormFieldGroup>
        <Disclosure>
          <DisclosureSummary>{t("knowledge.expiry")}</DisclosureSummary>
          <TextInput
            aria-label={t("knowledge.expiry")}
            disabled={adding}
            maxLength={40}
            onChange={(event) => setExpiresAt(event.target.value)}
            tone="boxed"
            value={expiresAt}
          />
          <FieldHint className="mt-0">{t("knowledge.expiryHint")}</FieldHint>
        </Disclosure>
        <Button
          aria-busy={adding}
          className="justify-self-start"
          disabled={adding || !draft.trim()}
          size="sm"
          type="submit"
          variant="primary"
        >
          {adding ? t("settings.memory.adding") : t("settings.memory.add")}
        </Button>
      </form>
      {layer?.state && !["active", "ready"].includes(layer.state) ? (
        <FieldHint tone="warning">
          {t("settings.memory.layerPending")}
        </FieldHint>
      ) : null}
      {entries.length ? (
        <DividedList density="cozy">
          {entries.map((entry) => {
            const toScope: MemoryLayerScope =
              entry.scope === "person" ? "assistant" : "person";
            const moving = busy === `move:${entry.id}`;
            const forgetting = busy === `forget:${entry.id}`;
            const items: RowMenuItem[] = [
              ...(onCorrect
                ? [
                    {
                      key: "correct",
                      label: t("knowledge.correctAction"),
                      icon: <Pencil aria-hidden="true" size={14} />,
                      disabled:
                        entryActionBusy ||
                        Boolean(busy) ||
                        moving ||
                        forgetting,
                      onSelect: () => onCorrect(entry),
                    },
                  ]
                : []),
              ...(onPublish
                ? [
                    {
                      key: "publish",
                      label: t("knowledge.shareTo"),
                      icon: <Share2 aria-hidden="true" size={14} />,
                      disabled:
                        entryActionBusy ||
                        Boolean(busy) ||
                        moving ||
                        forgetting,
                      onSelect: () => onPublish(entry),
                    },
                  ]
                : []),
              ...(onReviewSource && hasReviewableSource(entry.sourceRef)
                ? [
                    {
                      key: "review",
                      label: t("knowledge.reviewSource"),
                      icon: <FilePenLine aria-hidden="true" size={14} />,
                      disabled:
                        entryActionBusy ||
                        Boolean(busy) ||
                        moving ||
                        forgetting,
                      onSelect: () => onReviewSource(entry),
                    },
                  ]
                : []),
              {
                key: "move",
                label: t(
                  toScope === "person"
                    ? "settings.memory.moveToShared"
                    : "settings.memory.moveToAssistant",
                ),
                icon: <ArrowLeftRight aria-hidden="true" size={14} />,
                disabled:
                  entryActionBusy || Boolean(busy) || moving || forgetting,
                onSelect: () => onMove(entry, toScope),
              },
              {
                key: "forget",
                label: t("settings.memory.forget"),
                icon: <Trash2 aria-hidden="true" size={14} />,
                disabled:
                  entryActionBusy || Boolean(busy) || moving || forgetting,
                tone: "danger" as const,
                onSelect: () => onForget(entry),
              },
            ];
            return (
              <li className="grid min-w-0 gap-1.5 wrap-anywhere" key={entry.id}>
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <p className="min-w-0 flex-1 text-sm leading-[1.55] text-ink">
                    {entry.title}
                  </p>
                  <RowMenu
                    disabled={entryActionBusy || Boolean(busy)}
                    items={items}
                    label={t("settings.memory.actionsFor", {
                      title: entry.title,
                    })}
                  />
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                  <PaMuted as="span" title={fullWhen(entry.updatedAt)}>
                    {t("settings.memory.updated", {
                      when: relativeWhen(entry.updatedAt),
                    })}
                  </PaMuted>
                </div>
              </li>
            );
          })}
        </DividedList>
      ) : (
        <PaMuted>{t("settings.memory.empty")}</PaMuted>
      )}
    </SettingsGroup>
  );
}
