import { Alert } from "../../components/ui/alert";
import { toast } from "../../components/ui/toast";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import type { WorkspaceDraftSkills } from "@bd777/foundry-protocol";
import {
  getWorkspaceDraftSkills,
  refreshWorkspaceDraftSkills,
  setWorkspaceDraftSkills,
} from "../../api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/field";
import { Skeleton } from "../../components/ui/loading";
import { RowCard } from "../../components/ui/row-card";
import { SkillCatalogHeading } from "../../components/skills/skill-catalog-heading";

export function WorkspaceDrafts({
  workspaceId,
  readOnly,
  online,
  canRefresh = !readOnly,
}: {
  workspaceId: string;
  readOnly: boolean;
  online?: boolean;
  canRefresh?: boolean;
}) {
  const { t } = useTranslation("skills");
  const [view, setView] = useState<WorkspaceDraftSkills>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  useEffect(() => {
    const current = ++revision.current;
    setView(undefined);
    setError("");
    setBusy(false);
    getWorkspaceDraftSkills(workspaceId).then(
      (value) => {
        if (current === revision.current) setView(value);
      },
      (e) => {
        if (current === revision.current) setError(String(e));
      },
    );
    return () => {
      revision.current++;
    };
  }, [workspaceId, online]);
  async function update(refresh: boolean, enabled?: boolean) {
    const current = revision.current;
    setBusy(true);
    setError("");
    try {
      const value = refresh
        ? await refreshWorkspaceDraftSkills(workspaceId)
        : await setWorkspaceDraftSkills(workspaceId, enabled);
      if (current === revision.current) setView(value);
    } catch (e) {
      if (current === revision.current)
        toast({ tone: "error", title: String(e) });
    } finally {
      if (current === revision.current) setBusy(false);
    }
  }
  return (
    <section
      className="mb-6 grid min-w-0 gap-3"
      aria-label={t("drafts.title")}
      aria-busy={busy}
    >
      <SkillCatalogHeading
        actions={
          <Button
            disabled={busy || !view?.enabled || !view.supported || !canRefresh}
            onClick={() => void update(true)}
            size="sm"
          >
            {busy ? t("drafts.refreshing") : t("drafts.refresh")}
          </Button>
        }
        description={t("drafts.hint")}
        title={t("drafts.title")}
      />

      <RowCard className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
          <Checkbox
            checked={view?.enabled ?? false}
            disabled={!view || busy || readOnly}
            onChange={(event) =>
              void update(false, event.currentTarget.checked)
            }
          />
          <span>{t("drafts.enable")}</span>
        </label>
        {view?.scannedAt && (
          <span className="text-xs text-ink-muted">
            {t("drafts.scanned", {
              at: new Date(view.scannedAt).toLocaleString(),
            })}
          </span>
        )}
      </RowCard>

      {error && <Alert size="compact" tone="error" title={error} />}
      {!view && !error && (
        <Skeleton label={t("drafts.loading")} rows={2} variant="rows" />
      )}
      {view && !view.supported && (
        <p className="text-sm text-ink-muted" role="status">
          {t("drafts.unsupported")}
        </p>
      )}
      {view?.skills.length === 0 && (
        <div className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-ink-muted">
          <p>{view.scannedAt ? t("drafts.empty") : t("drafts.unscanned")}</p>
        </div>
      )}

      <ul className="grid gap-2">
        {view?.skills.map((skill) => {
          const statusTone =
            skill.status === "ready"
              ? "online"
              : skill.status === "conflict"
                ? "warn"
                : "error";
          return (
            <RowCard
              as="li"
              className="grid gap-2 px-3.5 py-3 [overflow-wrap:anywhere]"
              key={skill.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                  <strong className="text-md font-semibold text-ink">
                    {skill.name}
                  </strong>
                  <Badge tone={statusTone}>{t(`drafts.${skill.status}`)}</Badge>
                </div>
              </div>

              {skill.description ? (
                <p className="text-sm leading-normal text-ink">
                  {skill.description}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 text-xs text-ink-muted">
                <code className="rounded-xs border border-line-soft bg-paper px-1.5 py-0.5 font-mono text-2xs text-ink">
                  {skill.relativePath}
                </code>
                {skill.digest ? (
                  <span>
                    {t("drafts.version", {
                      digest: skill.digest.slice(0, 12),
                    })}
                  </span>
                ) : null}
                {skill.status === "ready" ? (
                  <span className="text-ink-faint">
                    {t("drafts.invoke", { name: `draft:${skill.name}` })}
                  </span>
                ) : null}
              </div>

              {skill.error ? (
                <div
                  className="flex items-start gap-2 rounded-sm border border-warning-border bg-warning-surface px-2.5 py-2 text-xs leading-[1.4] text-warning-text"
                  role="note"
                >
                  <AlertTriangle className="mt-0.5 shrink-0" size={14} />
                  <span>{skill.error}</span>
                </div>
              ) : null}
            </RowCard>
          );
        })}
      </ul>
    </section>
  );
}
