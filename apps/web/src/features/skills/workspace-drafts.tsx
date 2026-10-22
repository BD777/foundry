import { DraftTrialDialog } from "./draft-trial-dialog";
import { navigateToChat } from "../../lib/in-app-navigation";
import type { WorkspaceDraftSkill } from "@bd777/foundry-protocol";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import type { WorkspaceDraftSkills } from "@bd777/foundry-protocol";
import { request, send } from "../../api/http";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/field";

export function WorkspaceDrafts({
  workspaceId,
  readOnly,
  online,
  canTrial = !readOnly,
}: {
  workspaceId: string;
  readOnly: boolean;
  online?: boolean;
  canTrial?: boolean;
}) {
  const { t } = useTranslation("skills");
  const [view, setView] = useState<WorkspaceDraftSkills>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const [trial, setTrial] = useState<WorkspaceDraftSkill>();
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/draft-skills`;
  useEffect(() => {
    const current = ++revision.current;
    setTrial(undefined);
    setView(undefined);
    setError("");
    setBusy(false);
    request<WorkspaceDraftSkills>("GET", path).then(
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
  }, [path, online]);
  async function update(refresh: boolean, enabled?: boolean) {
    const current = revision.current;
    setBusy(true);
    setError("");
    try {
      const response = await send(
        refresh ? "POST" : "PUT",
        refresh ? `${path}/refresh` : path,
        { body: refresh ? {} : { enabled } },
      );
      const value = (await response.json()) as WorkspaceDraftSkills;
      if (current === revision.current) setView(value);
    } catch (e) {
      if (current === revision.current) setError(String(e));
    } finally {
      if (current === revision.current) setBusy(false);
    }
  }
  return (
    <section
      className="fdy-workspace-drafts"
      aria-label={t("drafts.title")}
      aria-busy={busy}
    >
      <header className="fdy-skill-catalog-heading">
        <div className="fdy-skill-catalog-heading-copy">
          <h2>{t("drafts.title")}</h2>
          <p>{t("drafts.hint")}</p>
        </div>
        <div className="fdy-skill-catalog-heading-actions">
          <Button
            disabled={busy || !view?.enabled || !view.supported || !canTrial}
            onClick={() => void update(true)}
            size="sm"
          >
            {busy ? t("drafts.refreshing") : t("drafts.refresh")}
          </Button>
        </div>
      </header>

      <div className="fdy-workspace-drafts-bar">
        <label className="fdy-workspace-drafts-toggle">
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
          <span className="fdy-workspace-drafts-scanned">
            {t("drafts.scanned", {
              at: new Date(view.scannedAt).toLocaleString(),
            })}
          </span>
        )}
      </div>

      {error && (
        <p className="fdy-workspace-drafts-alert" role="alert">
          {error}
        </p>
      )}
      {!view && !error && (
        <p className="fdy-workspace-drafts-status" role="status">
          {t("drafts.loading")}
        </p>
      )}
      {view && !view.supported && (
        <p className="fdy-workspace-drafts-status" role="status">
          {t("drafts.unsupported")}
        </p>
      )}
      {view?.skills.length === 0 && (
        <div className="fdy-workspace-drafts-empty">
          <p>{view.scannedAt ? t("drafts.empty") : t("drafts.unscanned")}</p>
        </div>
      )}

      <ul className="fdy-workspace-drafts-list">
        {view?.skills.map((skill) => {
          const statusTone =
            skill.status === "ready"
              ? "online"
              : skill.status === "conflict"
                ? "warn"
                : "error";
          return (
            <li className="fdy-workspace-draft-card" key={skill.id}>
              <div className="fdy-workspace-draft-header">
                <div className="fdy-workspace-draft-title-row">
                  <strong className="fdy-workspace-draft-name">
                    {skill.name}
                  </strong>
                  <Badge tone={statusTone}>{t(`drafts.${skill.status}`)}</Badge>
                </div>
                <div className="fdy-workspace-draft-actions">
                  {skill.status === "ready" && (
                    <Button
                      disabled={
                        busy || !view?.enabled || !view.supported || !canTrial
                      }
                      onClick={() => setTrial(skill)}
                      size="sm"
                    >
                      {t("drafts.trial")}
                    </Button>
                  )}
                  {skill.lastTrial && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        navigateToChat(skill.lastTrial!.sessionId, workspaceId)
                      }
                    >
                      {t("drafts.viewTrial")}
                    </Button>
                  )}
                </div>
              </div>

              {skill.description ? (
                <p className="fdy-workspace-draft-description">
                  {skill.description}
                </p>
              ) : null}

              <div className="fdy-workspace-draft-meta-row">
                <code className="fdy-workspace-draft-path">
                  {skill.relativePath}
                </code>
                {skill.digest ? (
                  <span className="fdy-workspace-draft-version">
                    {t("drafts.version", {
                      digest: skill.digest.slice(0, 12),
                    })}
                  </span>
                ) : null}
                {skill.status === "ready" ? (
                  <span className="fdy-workspace-draft-invoke">
                    {t("drafts.invoke", { name: `draft:${skill.name}` })}
                  </span>
                ) : null}
              </div>

              {skill.lastTrial ? (
                <div className="fdy-workspace-draft-trial-info">
                  <span>
                    {skill.lastTrial.digest !== skill.digest
                      ? t("drafts.staleTrial")
                      : t("drafts.trialRecorded")}
                  </span>
                </div>
              ) : null}

              {skill.error ? (
                <div className="fdy-workspace-draft-error" role="note">
                  <AlertTriangle
                    className="fdy-workspace-draft-error-icon"
                    size={14}
                  />
                  <span>{skill.error}</span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {trial && (
        <DraftTrialDialog
          key={`${trial.id}:${trial.digest}`}
          skill={trial}
          onClose={() => setTrial(undefined)}
        />
      )}
    </section>
  );
}
