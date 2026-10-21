import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import type { PersonalAgentMemoryItem } from "@bd777/foundry-protocol";
import {
  addPersonalAgentMemory,
  confirmPersonalAgentMemory,
  forgetAllPersonalAgentMemory,
  forgetPersonalAgentMemory,
  listPersonalAgentMemory,
  updatePersonalAgentMemory,
  transferLegacyKnowledge,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { TextInput, Textarea } from "../../components/ui/field";
import { serverErrorText } from "../../lib/errors";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { memoryItemMaxChars } from "./assistant-model";

/** Downloads what it remembers, as JSON, through the browser. */
function exportMemory(items: PersonalAgentMemoryItem[]): void {
  const blob = new Blob([JSON.stringify(items, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "assistant-memory.json";
  link.click();
  URL.revokeObjectURL(url);
}

/** "About me": what it knows, where each item came from, and forgetting. */
export function MemorySection({
  hasWorkspaceMemory = false,
}: {
  hasWorkspaceMemory?: boolean;
}) {
  const { t } = useTranslation("personalAgent");
  const [items, setItems] = useState<PersonalAgentMemoryItem[]>();
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");

  const read = useCallback(async () => {
    try {
      setItems(await listPersonalAgentMemory());
      setLoadError("");
    } catch (reason) {
      setLoadError(serverErrorText(reason));
    }
  }, []);
  useEffect(() => {
    void read();
  }, [read]);

  async function run(action: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      await action();
      await read();
      return true;
    } catch (reason) {
      setError(serverErrorText(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const transferring = items?.some((item) => item.status === "transferring");
  useEffect(() => {
    if (!transferring) return;
    const timer = setInterval(() => void read(), 3000);
    return () => clearInterval(timer);
  }, [transferring, read]);
  async function add(event: FormEvent): Promise<void> {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    if (await run(() => addPersonalAgentMemory(content).then(() => undefined)))
      setDraft("");
  }

  if (loadError && !items)
    return (
      <Alert tone="error" title={t("settings.memory.loadFailed")}>
        <p>{loadError}</p>
        <Button onClick={() => void read()} size="sm">
          {t("retry")}
        </Button>
      </Alert>
    );
  if (!items)
    return (
      <p className="fdy-pa-muted" role="status">
        {t("loading")}
      </p>
    );
  const pending = items.filter((item) => item.status === "pending");
  const active = items.filter(
    (item) => item.status === "active" || item.status === "transferring",
  );

  return (
    <>
      <p className="fdy-pa-intro">
        {hasWorkspaceMemory
          ? t("knowledge.legacyIntro")
          : t("settings.memory.intro")}
      </p>
      {!hasWorkspaceMemory ? (
        <form
          className="fdy-pa-memory-add"
          onSubmit={(event) => void add(event)}
        >
          <TextInput
            aria-label={t("settings.memory.addLabel")}
            className="fdy-pa-input"
            disabled={busy}
            maxLength={memoryItemMaxChars}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("settings.memory.addPlaceholder")}
            tone="boxed"
            value={draft}
          />
          <Button
            aria-busy={busy}
            disabled={busy || !draft.trim()}
            type="submit"
            variant="primary"
          >
            {busy ? t("settings.memory.adding") : t("settings.memory.add")}
          </Button>
        </form>
      ) : null}
      {error ? (
        <Alert tone="error" title={t("settings.memory.failed")}>
          {error}
        </Alert>
      ) : null}
      {pending.length ? (
        <div className="fdy-pa-group">
          <h3 className="fdy-pa-group-title">
            {t("settings.memory.pendingTitle")}
          </h3>
          <p className="fdy-pa-field-hint">
            {t("settings.memory.pendingBody")}
          </p>
          <ul className="fdy-pa-memory">
            {pending.map((item) => (
              <MemoryRow
                busy={busy}
                item={item}
                key={item.id}
                run={run}
                canTransfer={hasWorkspaceMemory}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {active.length ? (
        <ul className="fdy-pa-memory">
          {active.map((item) => (
            <MemoryRow
              busy={busy}
              item={item}
              key={item.id}
              run={run}
              canTransfer={hasWorkspaceMemory}
            />
          ))}
        </ul>
      ) : (
        <p className="fdy-pa-muted">{t("settings.memory.empty")}</p>
      )}
      {active.length || pending.length ? (
        <div className="fdy-pa-inline">
          <Button
            onClick={() => exportMemory([...pending, ...active])}
            size="sm"
          >
            <Download aria-hidden="true" size={14} />
            {t("settings.memory.export")}
          </Button>
          <ConfirmButton
            confirmLabel={t("settings.memory.forgetAllConfirm")}
            disabled={busy}
            onConfirm={() =>
              void run(() =>
                forgetAllPersonalAgentMemory().then(() => undefined),
              )
            }
            size="sm"
            variant="secondary"
          >
            {t("settings.memory.forgetAll")}
          </ConfirmButton>
        </div>
      ) : null}
    </>
  );
}

function MemoryRow({
  item,
  busy,
  run,
  canTransfer = false,
}: {
  canTransfer?: boolean;
  item: PersonalAgentMemoryItem;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<boolean>;
}) {
  const { t } = useTranslation("personalAgent");
  const [editing, setEditing] = useState<string>();
  const moving = item.status === "transferring";
  const unconfirmed = item.origin === "inferred" || item.status === "pending";
  const done = () => undefined;

  return (
    <li className="fdy-pa-memory-item">
      {editing === undefined ? (
        <p className="fdy-pa-memory-text">{item.content}</p>
      ) : (
        <Textarea
          aria-label={t("settings.memory.editLabel")}
          className="fdy-pa-textarea"
          maxLength={memoryItemMaxChars}
          onChange={(event) => setEditing(event.target.value)}
          resize="vertical"
          rows={2}
          tone="boxed"
          value={editing}
        />
      )}
      <div className="fdy-pa-memory-meta">
        <Badge tone={unconfirmed ? "brass" : "neutral"}>
          {t(`settings.memory.origin.${item.origin}`)}
        </Badge>
        <span className="fdy-pa-muted" title={fullWhen(item.createdAt)}>
          {t("settings.memory.added", { when: relativeWhen(item.createdAt) })}
        </span>
      </div>
      <div className="fdy-pa-memory-actions">
        {editing === undefined ? (
          <>
            {moving ? <p role="status">{t("knowledge.legacyMoving")}</p> : null}
            {canTransfer && !moving ? (
              <ConfirmButton
                size="sm"
                disabled={busy}
                confirmLabel={t("knowledge.transferConfirm")}
                onConfirm={() =>
                  void run(() => transferLegacyKnowledge(item).then(done))
                }
              >
                {t("knowledge.transfer")}
              </ConfirmButton>
            ) : null}
            {unconfirmed && !moving ? (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(() => confirmPersonalAgentMemory(item.id).then(done))
                }
                size="sm"
                variant="primary"
              >
                {t("settings.memory.confirm")}
              </Button>
            ) : null}
            <Button
              disabled={busy || moving}
              onClick={() => setEditing(item.content)}
              size="sm"
              variant="ghost"
            >
              {t("settings.memory.edit")}
            </Button>
            <ConfirmButton
              confirmLabel={t("settings.memory.forgetConfirm")}
              disabled={busy}
              onConfirm={() =>
                void run(() => forgetPersonalAgentMemory(item.id))
              }
              size="sm"
              variant="ghost"
            >
              {t("settings.memory.forget")}
            </ConfirmButton>
          </>
        ) : (
          <>
            <Button
              disabled={busy || !editing.trim()}
              onClick={() =>
                void run(() =>
                  updatePersonalAgentMemory(item.id, editing.trim()).then(done),
                ).then((saved) => {
                  if (saved) setEditing(undefined);
                })
              }
              size="sm"
              variant="primary"
            >
              {t("settings.memory.save")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => setEditing(undefined)}
              size="sm"
              variant="ghost"
            >
              {t("settings.memory.cancel")}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
