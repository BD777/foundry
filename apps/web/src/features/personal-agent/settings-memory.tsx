import { ToastFeedback } from "../../components/ui/toast";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
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
import { FieldHint, TextInput, Textarea } from "../../components/ui/field";
import { serverErrorText } from "../../lib/errors";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { memoryItemMaxChars } from "./assistant-model";
import { Skeleton } from "../../components/ui/loading";
import { PaMuted } from "./pa-muted";
import { Subheading } from "../../components/ui/subheading";
import { DividedList } from "../../components/ui/divided-list";
import { ButtonRow } from "../../components/ui/button-row";
import { FieldLabel, FormFieldGroup } from "../../components/ui/form-field";

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
  if (!items) return <Skeleton label={t("loading")} rows={4} variant="rows" />;
  const pending = items.filter((item) => item.status === "pending");
  const active = items.filter(
    (item) => item.status === "active" || item.status === "transferring",
  );

  return (
    <>
      <PaMuted className="max-w-[680px] leading-[1.6]" size="sm">
        {hasWorkspaceMemory
          ? t("knowledge.legacyIntro")
          : t("settings.memory.intro")}
      </PaMuted>
      {!hasWorkspaceMemory ? (
        <form
          className="grid max-w-sm gap-3"
          onSubmit={(event) => void add(event)}
        >
          <FormFieldGroup>
            <FieldLabel htmlFor="fdy-pa-memory-add">
              {t("settings.memory.addLabel")}
            </FieldLabel>
            <TextInput
              className="w-full"
              disabled={busy}
              id="fdy-pa-memory-add"
              maxLength={memoryItemMaxChars}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("settings.memory.addPlaceholder")}
              tone="boxed"
              value={draft}
            />
          </FormFieldGroup>
          <Button
            aria-busy={busy}
            className="justify-self-start"
            disabled={busy || !draft.trim()}
            type="submit"
            variant="primary"
          >
            {busy ? t("settings.memory.adding") : t("settings.memory.add")}
          </Button>
        </form>
      ) : null}
      {error ? (
        <ToastFeedback tone="error" title={t("settings.memory.failed")}>
          {error}
        </ToastFeedback>
      ) : null}
      {pending.length ? (
        <div className="grid gap-3.5 border-t border-line pt-4 first:border-t-0 first:pt-0">
          <Subheading size="group">
            {t("settings.memory.pendingTitle")}
          </Subheading>
          <FieldHint>{t("settings.memory.pendingBody")}</FieldHint>
          <DividedList density="cozy">
            {pending.map((item) => (
              <MemoryRow
                busy={busy}
                item={item}
                key={item.id}
                run={run}
                canTransfer={hasWorkspaceMemory}
              />
            ))}
          </DividedList>
        </div>
      ) : null}
      {active.length ? (
        <DividedList density="cozy">
          {active.map((item) => (
            <MemoryRow
              busy={busy}
              item={item}
              key={item.id}
              run={run}
              canTransfer={hasWorkspaceMemory}
            />
          ))}
        </DividedList>
      ) : (
        <PaMuted>{t("settings.memory.empty")}</PaMuted>
      )}
      {active.length || pending.length ? (
        <ButtonRow gap="wide">
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
        </ButtonRow>
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
  const editorId = useId();
  const [editing, setEditing] = useState<string>();
  const moving = item.status === "transferring";
  const unconfirmed = item.origin === "inferred" || item.status === "pending";
  const done = () => undefined;

  return (
    <li className="grid min-w-0 gap-1.5 wrap-anywhere">
      {editing === undefined ? (
        <p className="text-sm leading-[1.55] wrap-anywhere text-ink">
          {item.content}
        </p>
      ) : (
        <FormFieldGroup className="max-w-2xl">
          <FieldLabel htmlFor={editorId}>
            {t("settings.memory.editLabel")}
          </FieldLabel>
          <Textarea
            className="w-full"
            id={editorId}
            maxLength={memoryItemMaxChars}
            onChange={(event) => setEditing(event.target.value)}
            resize="vertical"
            rows={2}
            tone="boxed"
            value={editing}
          />
        </FormFieldGroup>
      )}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <Badge tone={unconfirmed ? "brass" : "neutral"}>
          {t(`settings.memory.origin.${item.origin}`)}
        </Badge>
        <PaMuted as="span" title={fullWhen(item.createdAt)}>
          {t("settings.memory.added", { when: relativeWhen(item.createdAt) })}
        </PaMuted>
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
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
