import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PersonalAgentItemPlan,
  PersonalAgentListItem,
  PersonalAgentOperation,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { cancelPendingPersonalAgentOperation } from "../../api";
import { Button } from "../../components/ui/button";
import { Alert } from "../../components/ui/alert";
import { Checkbox, Textarea } from "../../components/ui/field";
import { SelectMenu } from "../../components/ui/select-menu";
import { navigateToChat, navigateToIssue } from "../../lib/in-app-navigation";
import { serverErrorText } from "../../lib/errors";

export function ItemPlan({
  item,
  items,
  operations,
  workspaces,
  onSave,
  onContinue,
  onRefresh,
}: {
  item: PersonalAgentListItem;
  items: PersonalAgentListItem[];
  operations: PersonalAgentOperation[];
  workspaces: WorkspaceProjection[];
  onSave?: (
    item: PersonalAgentListItem,
    plan: PersonalAgentItemPlan,
  ) => Promise<void>;
  onContinue?: (item: PersonalAgentListItem) => Promise<void>;
  onRefresh?: () => Promise<void>;
}) {
  const { t } = useTranslation("personalAgent");
  const [draft, setDraft] = useState<PersonalAgentItemPlan>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const plan = item.plan;
  const runs = operations.filter((op) => op.itemId === item.id);
  const latest = runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const refs = plan?.workRefs ?? [];
  const dependencies = (plan?.dependencies ?? [])
    .map((id) => items.find((i) => i.id === id))
    .filter((i) => i !== undefined);
  const progress = plan?.progress ?? "inbox";
  const state = (value: string) =>
    [
      "pending",
      "waiting",
      "dispatching",
      "delivered",
      "unknown",
      "review",
      "failed",
      "cancelled",
    ].includes(value)
      ? t(`planning.operation.${value}` as never)
      : value;
  function operationReason(value: string) {
    const known = [
      "existing_owner_busy",
      "worker_update_required",
      "owner_configuration_differs",
      "execution_configuration_unavailable",
      "device_offline",
      "assistant_paused",
      "dependency_pending",
      "existing_owner_conflict",
      "owner_permission_required",
      "dispatch_unavailable",
      "workspace_writer_busy",
      "execution_completed_requires_evidence",
      "execution_failed",
      "execution_cancelled",
      "intent_changed",
      "owner_input_changed_requires_evidence",
      "execution_policy_limit",
    ];
    const code = value.split(":")[0] ?? value;
    return known.includes(code)
      ? t(`planning.reasons.${code}` as never)
      : value;
  }
  async function save() {
    if (!draft || !onSave) return;
    setBusy(true);
    setError("");
    try {
      await onSave(item, draft);
      setDraft(undefined);
    } catch (e) {
      setError(serverErrorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fdy-pa-item-plan">
      <p className="fdy-pa-field-hint">
        {item.status === "done" ? (
          t("planning.completed")
        ) : (
          <>
            {t(
              plan?.mode === "execute" ? "planning.execute" : "planning.record",
            )}
            {plan?.mode === "execute"
              ? ` · ${t(`planning.progress.${progress}` as never)}`
              : ""}
          </>
        )}
      </p>
      {item.status === "done" &&
      latest &&
      ["pending", "waiting", "dispatching", "delivered", "unknown"].includes(
        latest.status,
      ) ? (
        <p role="status" className="fdy-pa-field-hint">
          {t("planning.executionStillOpen")}
        </p>
      ) : null}
      {item.status === "open" &&
      latest &&
      ["unknown", "failed", "waiting", "cancelled"].includes(latest.status) ? (
        <p role="status" className="fdy-pa-field-hint">
          {state(latest.status)}
          {latest.reason ? ` · ${operationReason(latest.reason)}` : ""}
        </p>
      ) : null}
      {item.status === "open" && plan?.route?.needsClarification ? (
        <p className="fdy-pa-field-hint">{t("planning.clarify")}</p>
      ) : null}
      {onContinue && item.status === "open" ? (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError("");
            void onContinue(item)
              .catch((e) => setError(serverErrorText(e)))
              .finally(() => setBusy(false));
          }}
        >
          {t("planning.continueLabel")}
        </Button>
      ) : null}
      <details className="fdy-pa-plan-details">
        <summary>{t("planning.details")}</summary>
        {plan?.route ? (
          <>
            <p>{t("planning.route", { reason: plan.route.reason })}</p>
            {plan.route.needsClarification ? (
              <p className="fdy-pa-field-hint">{t("planning.clarify")}</p>
            ) : null}
          </>
        ) : null}
        {item.status === "open" && plan?.nextAction ? (
          <p>{t("planning.next", { action: plan.nextAction })}</p>
        ) : null}
        {plan?.waitingFor ? (
          <p>{t("planning.waitingFor", { reason: plan.waitingFor })}</p>
        ) : null}
        {plan?.workspaceId ? (
          <p className="fdy-pa-field-hint">
            {t("planning.location", {
              workspace:
                workspaces.find((w) => w.id === plan.workspaceId)?.name ??
                plan.workspaceId,
            })}
          </p>
        ) : null}
        {dependencies.length ? (
          <ul>
            {dependencies.map((d) => (
              <li key={d.id}>
                {t(
                  d.status === "done"
                    ? "planning.dependencyDone"
                    : "planning.dependencyPending",
                  { task: d.text },
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {refs.length ? (
          <div className="fdy-pa-actions">
            {refs.map((ref) =>
              ref.kind === "session" ? (
                <Button
                  key={ref.id}
                  size="sm"
                  onClick={() => navigateToChat(ref.id, ref.workspaceId)}
                >
                  {t(
                    ref.relation === "executing"
                      ? "planning.owner"
                      : "planning.reference",
                  )}
                </Button>
              ) : ref.kind === "issue" ? (
                <Button
                  key={ref.id}
                  size="sm"
                  onClick={() => navigateToIssue(ref.id)}
                >
                  {t("planning.issue")}
                </Button>
              ) : (
                <p key={ref.id} className="fdy-pa-field-hint">
                  {t("planning.service", { id: ref.id })}
                </p>
              ),
            )}
          </div>
        ) : null}
        {latest ? (
          <div>
            <p>
              {t("planning.dispatchState", {
                state:
                  item.status === "done" && latest.status === "review"
                    ? t("planning.resultAvailable")
                    : state(latest.status),
              })}
            </p>
            {latest.reason &&
            !(
              item.status === "done" &&
              latest.reason === "execution_completed_requires_evidence"
            ) ? (
              <p className="fdy-pa-field-hint">
                {operationReason(latest.reason)}
              </p>
            ) : null}
            {["failed", "unknown", "waiting", "cancelled"].includes(
              latest.status,
            ) ? (
              <p className="fdy-pa-field-hint">
                {t(
                  latest.status === "unknown"
                    ? "planning.unknownHint"
                    : "planning.recoverHint",
                )}
              </p>
            ) : null}
            {["pending", "waiting"].includes(latest.status) &&
            !latest.sessionId ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void cancelPendingPersonalAgentOperation(
                    latest.id,
                    latest.revision,
                  )
                    .then(() => onRefresh?.())
                    .catch((e) => setError(serverErrorText(e)))
                    .finally(() => setBusy(false));
                }}
              >
                {t("planning.cancelPending")}
              </Button>
            ) : null}
            {latest.sessionId ? (
              <Button
                size="sm"
                onClick={() =>
                  navigateToChat(latest.sessionId!, latest.workspaceId)
                }
              >
                {t("planning.inspectRun")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {(plan?.evidence?.length ?? 0) > 0 ? (
          <div>
            <p>{t("planning.evidence")}</p>
            <ul>
              {plan!.evidence!.map((e, i) => (
                <li key={i}>
                  <p>{e.summary}</p>
                  {e.kind === "session" ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        navigateToChat(
                          e.ref.split("#")[0] ?? e.ref,
                          refs.find(
                            (ref) =>
                              ref.kind === "session" &&
                              ref.id === e.ref.split("#")[0],
                          )?.workspaceId ?? plan?.workspaceId,
                        )
                      }
                    >
                      {t("planning.inspectEvidence")}
                    </Button>
                  ) : e.kind === "issue" ? (
                    <Button size="sm" onClick={() => navigateToIssue(e.ref)}>
                      {t("planning.inspectEvidence")}
                    </Button>
                  ) : (
                    <p className="fdy-pa-field-hint">{e.ref}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : item.status !== "done" && latest?.status === "review" ? (
          <p className="fdy-pa-field-hint">{t("planning.evidenceNeeded")}</p>
        ) : null}
        {error ? (
          <Alert tone="error" title={t("planning.saveFailed")}>
            {error}
          </Alert>
        ) : null}
        <p className="fdy-pa-field-hint">{t("planning.completeHint")}</p>
        {draft ? (
          <form
            className="fdy-pa-item-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) {
                setDraft(undefined);
                e.preventDefault();
              }
            }}
          >
            <SelectMenu
              ariaLabel={t("planning.mode")}
              disabled={busy}
              value={draft.mode}
              options={[
                { value: "record", label: t("planning.record") },
                { value: "execute", label: t("planning.execute") },
              ]}
              onChange={(mode) => setDraft({ ...draft, mode })}
            />
            <p className="fdy-pa-field-hint">{t("planning.modeHint")}</p>
            <SelectMenu
              ariaLabel={t("planning.workspace")}
              disabled={busy}
              value={draft.workspaceId ?? ""}
              options={[
                { value: "", label: t("planning.unassigned") },
                ...workspaces
                  .filter((w) => !w.archivedAt && w.kind !== "personal_agent")
                  .map((w) => ({ value: w.id, label: w.name })),
              ]}
              onChange={(workspaceId) =>
                setDraft({
                  ...draft,
                  workspaceId,
                  route: workspaceId
                    ? {
                        kind: "existing",
                        reason: t("planning.personSelected"),
                        needsClarification: false,
                      }
                    : undefined,
                })
              }
            />
            <label>
              <span className="fdy-pa-field-label">
                {t("planning.nextLabel")}
              </span>
              <Textarea
                value={draft.nextAction ?? ""}
                disabled={busy}
                maxLength={2000}
                onChange={(e) =>
                  setDraft({ ...draft, nextAction: e.target.value })
                }
              />
            </label>
            <label>
              <span className="fdy-pa-field-label">
                {t("planning.waitingLabel")}
              </span>
              <Textarea
                value={draft.waitingFor ?? ""}
                disabled={busy}
                maxLength={1000}
                onChange={(e) =>
                  setDraft({ ...draft, waitingFor: e.target.value })
                }
              />
            </label>
            <fieldset disabled={busy}>
              <legend>{t("planning.dependencies")}</legend>
              {items
                .filter((i) => i.id !== item.id && i.status !== "dropped")
                .map((i) => (
                  <label key={i.id} className="fdy-pa-item-check">
                    <Checkbox
                      checked={draft.dependencies?.includes(i.id) ?? false}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          dependencies: e.target.checked
                            ? [...(draft.dependencies ?? []), i.id]
                            : (draft.dependencies ?? []).filter(
                                (id) => id !== i.id,
                              ),
                        })
                      }
                    />
                    <span>{i.text}</span>
                  </label>
                ))}
            </fieldset>
            <div className="fdy-pa-actions">
              <Button type="submit" size="sm" disabled={busy}>
                {t("planning.save")}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => setDraft(undefined)}
              >
                {t("planning.cancel")}
              </Button>
            </div>
          </form>
        ) : onSave ? (
          <Button
            size="sm"
            onClick={() => {
              setError("");
              setDraft(
                plan
                  ? structuredClone(plan)
                  : { mode: "record", progress: "inbox" },
              );
            }}
          >
            {t("planning.edit")}
          </Button>
        ) : null}
      </details>
    </div>
  );
}
