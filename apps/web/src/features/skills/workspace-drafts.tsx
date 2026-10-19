import { DraftTrialDialog } from "./draft-trial-dialog";
import { navigateToChat } from "../../lib/in-app-navigation";
import type { WorkspaceDraftSkill } from "@bd777/foundry-protocol";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceDraftSkills } from "@bd777/foundry-protocol";
import { request, send } from "../../api/http";
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
      <div className="fdy-workspace-drafts-heading">
        <h2>{t("drafts.title")}</h2>
        <Button
          disabled={busy || !view?.enabled || !view.supported || !canTrial}
          onClick={() => void update(true)}
        >
          {busy ? t("drafts.refreshing") : t("drafts.refresh")}
        </Button>
      </div>
      <p>{t("drafts.hint")}</p>
      <label className="fdy-workspace-drafts-toggle">
        <Checkbox
          checked={view?.enabled ?? false}
          disabled={!view || busy || readOnly}
          onChange={(event) => void update(false, event.currentTarget.checked)}
        />
        {t("drafts.enable")}
      </label>
      {error && <p role="alert">{error}</p>}
      {!view && !error && <p role="status">{t("drafts.loading")}</p>}
      {view && !view.supported && (
        <p role="status">{t("drafts.unsupported")}</p>
      )}
      {view?.scannedAt && (
        <p>
          {t("drafts.scanned", {
            at: new Date(view.scannedAt).toLocaleString(),
          })}
        </p>
      )}
      {view?.skills.length === 0 && (
        <p>{view.scannedAt ? t("drafts.empty") : t("drafts.unscanned")}</p>
      )}
      <ul className="fdy-workspace-drafts-list">
        {view?.skills.map((skill) => (
          <li key={skill.id}>
            <div>
              <strong>{skill.name}</strong>{" "}
              <span>{t(`drafts.${skill.status}`)}</span>
            </div>
            <p>{skill.description}</p>
            <code>{skill.relativePath}</code>
            {skill.digest && (
              <p>
                {t("drafts.version", { digest: skill.digest.slice(0, 12) })}
              </p>
            )}
            {skill.status === "ready" && (
              <p>{t("drafts.invoke", { name: `draft:${skill.name}` })}</p>
            )}
            {skill.status === "ready" && (
              <Button
                disabled={
                  busy || !view?.enabled || !view.supported || !canTrial
                }
                onClick={() => setTrial(skill)}
              >
                {t("drafts.trial")}
              </Button>
            )}
            {skill.lastTrial && (
              <div>
                <span>
                  {skill.lastTrial.digest !== skill.digest
                    ? t("drafts.staleTrial")
                    : t("drafts.trialRecorded")}
                </span>
                <Button
                  variant="ghost"
                  onClick={() =>
                    navigateToChat(skill.lastTrial!.sessionId, workspaceId)
                  }
                >
                  {t("drafts.viewTrial")}
                </Button>
              </div>
            )}
            {skill.error && <p role="note">{skill.error}</p>}
          </li>
        ))}
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
