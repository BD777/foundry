import { ToastFeedback } from "../../components/ui/toast";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import type {
  PersonalAgentListItem,
  PersonalAgentItemPlan,
  PersonalAgentOperation,
  WorkspaceProjection,
  PersonalAgentTask,
} from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox, TextInput } from "../../components/ui/field";
import { RowMenu } from "../../components/ui/row-menu";
import { serverErrorText } from "../../lib/errors";
import { navigateToChat } from "../../lib/in-app-navigation";
import { clockTime, fullWhen } from "../../lib/time-format";
import { ItemPlan } from "./person-list-plan";
import { helpingTask, personListView, reminderAt } from "./person-list-model";

type ItemDraft = { text: string; when: string };

export interface PersonListProps {
  items: PersonalAgentListItem[];
  /** The assistant's tasks, for the ones helping with an item. */
  tasks: PersonalAgentTask[];
  error: string;
  workspaces?: WorkspaceProjection[];
  operations?: PersonalAgentOperation[];
  onPlan?: (
    item: PersonalAgentListItem,
    plan: PersonalAgentItemPlan,
  ) => Promise<void>;
  onContinue?: (item: PersonalAgentListItem) => Promise<void>;
  onRefresh?: () => Promise<void>;
  onTick: (item: PersonalAgentListItem, done: boolean) => Promise<void>;
  onEdit: (item: PersonalAgentListItem, draft: ItemDraft) => Promise<void>;
  onDelete: (item: PersonalAgentListItem) => Promise<void>;
}

/**
 * "Your list": what the person told their assistant they plan to do, in
 * their own words, and what they finished today. They tick, edit and
 * delete items here; the assistant adds them.
 */
export function PersonList({ items, error, ...actions }: PersonListProps) {
  const { t } = useTranslation("personalAgent");
  const { open, doneToday } = personListView(items);
  return (
    <section aria-labelledby="fdy-pa-list-title" className="fdy-pa-list">
      <h2 className="fdy-pa-side-title" id="fdy-pa-list-title">
        {t("list.title")}
      </h2>
      {error ? (
        <Alert tone="error" title={t("list.loadFailed")}>
          {error}
        </Alert>
      ) : null}
      {open.length ? (
        <>
          <h3 className="fdy-pa-side-subtitle">{t("list.open")}</h3>
          <ul className="fdy-pa-items">
            {open.map((item) => (
              <PersonListRow
                item={item}
                allItems={items}
                key={item.id}
                {...actions}
              />
            ))}
          </ul>
        </>
      ) : null}
      {doneToday.length ? (
        <>
          <h3 className="fdy-pa-side-subtitle">{t("list.doneToday")}</h3>
          <ul className="fdy-pa-items">
            {doneToday.map((item) => (
              <PersonListRow
                item={item}
                allItems={items}
                key={item.id}
                {...actions}
              />
            ))}
          </ul>
        </>
      ) : null}
      {!open.length && !doneToday.length && !error ? (
        <p className="fdy-pa-muted">{t("list.empty")}</p>
      ) : null}
    </section>
  );
}

function PersonListRow({
  item,
  tasks,
  onTick,
  onEdit,
  onDelete,
  onPlan,
  onContinue,
  onRefresh,
  operations = [],
  workspaces = [],
  allItems,
}: Omit<PersonListProps, "items" | "error"> & {
  item: PersonalAgentListItem;
  allItems: PersonalAgentListItem[];
}) {
  const { t } = useTranslation("personalAgent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<ItemDraft>();
  const checkbox = useRef<HTMLInputElement>(null);
  const refocus = useRef(false);
  const done = item.status === "done";
  const remindAt = reminderAt(item);
  const task = done ? undefined : helpingTask(item, tasks);

  useEffect(() => {
    if (draft || !refocus.current) return;
    refocus.current = false;
    checkbox.current?.focus();
  }, [draft]);

  async function run(action: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      await action();
      return true;
    } catch (reason) {
      setError(serverErrorText(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function closeEditor(): void {
    refocus.current = true;
    setDraft(undefined);
    setError("");
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!draft || !draft.text.trim()) return;
    if (await run(() => onEdit(item, draft))) closeEditor();
  }

  const failed = error ? (
    <ToastFeedback tone="error" title={t("list.failed")}>
      {error}
    </ToastFeedback>
  ) : null;

  if (draft)
    return (
      <li className="fdy-pa-item" data-status={item.status}>
        <form
          aria-busy={busy}
          className="fdy-pa-item-form"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || busy) return;
            event.preventDefault();
            closeEditor();
          }}
          onSubmit={(event) => void save(event)}
        >
          <label className="fdy-pa-item-field">
            <span className="fdy-pa-field-label">{t("list.textLabel")}</span>
            <TextInput
              autoFocus
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, text: event.target.value })
              }
              tone="boxed"
              value={draft.text}
            />
          </label>
          <label className="fdy-pa-item-field">
            <span className="fdy-pa-field-label">{t("list.whenLabel")}</span>
            <TextInput
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, when: event.target.value })
              }
              placeholder={t("list.whenPlaceholder")}
              tone="boxed"
              value={draft.when}
            />
          </label>
          <div className="fdy-pa-item-form-actions">
            <Button
              aria-busy={busy}
              disabled={busy || !draft.text.trim()}
              size="sm"
              type="submit"
              variant="primary"
            >
              {busy ? t("list.saving") : t("list.save")}
            </Button>
            <Button
              disabled={busy}
              onClick={closeEditor}
              size="sm"
              variant="ghost"
            >
              {t("list.cancel")}
            </Button>
          </div>
          {failed}
        </form>
      </li>
    );

  return (
    <li aria-busy={busy} className="fdy-pa-item" data-status={item.status}>
      <div className="fdy-pa-item-head">
        <label className="fdy-pa-item-check">
          <Checkbox
            checked={done}
            className="fdy-pa-item-box"
            disabled={busy}
            onChange={(event) => {
              const next = event.target.checked;
              void run(() => onTick(item, next));
            }}
            ref={checkbox}
          />
          <span className="fdy-pa-item-text">{item.text}</span>
        </label>
        <RowMenu
          disabled={busy}
          items={[
            {
              key: "edit",
              label: t("list.edit"),
              onSelect: () => {
                setError("");
                setDraft({ text: item.text, when: item.when ?? "" });
              },
            },
            {
              key: "delete",
              tone: "danger" as const,
              label: t("list.delete"),
              confirm: {
                title: t("list.deleteTitle"),
                body: t("list.deleteBody", { text: item.text }),
                action: t("list.deleteAction"),
              },
              onSelect: () => void run(() => onDelete(item)),
            },
          ]}
          label={t("list.actionsFor", { text: item.text })}
        />
      </div>
      {item.when || remindAt || task ? (
        <span className="fdy-pa-item-meta fdy-pa-muted">
          {item.when ? <span>{item.when}</span> : null}
          {remindAt ? (
            <Badge title={fullWhen(remindAt)} tone="brass">
              {t("list.reminder", {
                time: clockTime(remindAt, { date: "short" }),
              })}
            </Badge>
          ) : null}
          {task ? (
            <Button
              onClick={() => navigateToChat(task.sessionId, task.workspaceId)}
              size="inline"
              variant="link"
            >
              {t("list.helping")}
              <ArrowRight aria-hidden="true" size={13} />
            </Button>
          ) : null}
        </span>
      ) : null}
      <ItemPlan
        item={item}
        items={allItems}
        operations={operations}
        workspaces={workspaces}
        onSave={onPlan}
        onContinue={onContinue}
        onRefresh={onRefresh}
      />
      {failed}
    </li>
  );
}
