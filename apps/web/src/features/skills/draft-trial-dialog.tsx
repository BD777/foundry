import { ToastFeedback } from "../../components/ui/toast";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProjection,
  AgentSession,
  WorkspaceDraftSkill,
} from "@bd777/foundry-protocol";
import { request } from "../../api/http";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Textarea } from "../../components/ui/field";
import { SelectMenu } from "../../components/ui/select-menu";
import { navigateToChat } from "../../lib/in-app-navigation";

export function DraftTrialDialog({
  skill,
  onClose,
}: {
  skill: WorkspaceDraftSkill;
  onClose: () => void;
}) {
  const { t } = useTranslation("skills");
  const [mode, setMode] = useState("with");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [accounts, setAccounts] = useState<AgentProjection[]>([]);
  const [agentId, setAgentId] = useState("");
  useEffect(() => {
    let active = true;
    request<AgentProjection[]>(
      "GET",
      `/api/agents?workspaceId=${encodeURIComponent(skill.workspaceId)}`,
    ).then(
      (value) => {
        if (active) setAccounts(value);
      },
      (e) => {
        if (active) setError(String(e));
      },
    );
    return () => {
      active = false;
    };
  }, [skill.workspaceId]);
  const attempt = useRef<{ body: string; id: string } | undefined>(undefined);
  async function start() {
    const body = {
      workspaceId: skill.workspaceId,
      agentId,
      provider: accounts.find((a) => a.id === agentId)?.provider,
      prompt: prompt.trim(),
      skillSelection: {
        mode: mode === "without" ? "exclude" : "include",
        drafts: [
          {
            id: skill.id,
            digest: mode === "old" ? skill.previousDigest : skill.digest,
          },
        ],
      },
    };
    const key = JSON.stringify(body);
    if (attempt.current?.body !== key)
      attempt.current = { body: key, id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const session = await request<AgentSession>(
        "POST",
        "/api/agent-sessions",
        {
          body: { ...body, inputId: attempt.current.id },
          idempotencyKey: attempt.current.id,
        },
      );
      onClose();
      navigateToChat(session.id, skill.workspaceId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={t("drafts.trialTitle", { name: skill.name })}
      description={t("drafts.trialHint")}
      onClose={onClose}
      busy={busy}
      footer={
        <Button
          busy={busy}
          disabled={!prompt.trim() || !agentId}
          onClick={() => void start()}
        >
          {busy ? t("drafts.starting") : t("drafts.startTrial")}
        </Button>
      }
    >
      <div className="fdy-workspace-drafts">
        <SelectMenu
          insideDialog
          ariaLabel={t("drafts.account")}
          placeholder={t("drafts.chooseAccount")}
          value={agentId}
          disabled={busy}
          onChange={setAgentId}
          options={accounts.map((account) => ({
            value: account.id,
            label: `${account.profileLabel ?? account.profileId ?? account.provider} · ${account.provider}`,
            disabled:
              account.status === "unavailable" ||
              account.status === "missing_auth",
          }))}
        />

        <SelectMenu
          insideDialog
          ariaLabel={t("drafts.trialMode")}
          value={mode}
          disabled={busy}
          onChange={setMode}
          options={[
            { value: "with", label: t("drafts.withSkill") },
            { value: "without", label: t("drafts.withoutSkill") },
            ...(skill.previousDigest
              ? [{ value: "old", label: t("drafts.oldSkill") }]
              : []),
          ]}
        />
        <label>
          {t("drafts.task")}
          <Textarea
            tone="boxed"
            value={prompt}
            disabled={busy}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            rows={5}
          />
        </label>
        {error && <ToastFeedback tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
