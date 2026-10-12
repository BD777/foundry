import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, FileText } from "lucide-react";
import type {
  FoundrySkillDetail,
  FoundryToolRole,
} from "@bd777/foundry-protocol";
import { getFoundrySkill } from "../../api";
import { navigateToSkills } from "../../lib/in-app-navigation";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { PageSurface } from "../../components/ui/page-surface";
import { WorkspaceDialog } from "../../components/workspace/workspace-dialog";

// i18n-ignore: runtime product names
const agentNames = { claude: "Claude Code", codex: "Codex" } as const;

const roleOrder: FoundryToolRole[] = [
  "session",
  "issue_execution",
  "issue_clarification",
  "verifier",
];

/** SKILL.md text with its `inline code` set as code. */
export function inlineCode(text: string): ReactNode[] {
  return text
    .split("`")
    .map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part));
}

/**
 * What the built-in foundry skill gives agents: the Foundry tools, each with
 * what it does, its limits and the roles that get it, then the guidance its
 * SKILL.md gives. All of it comes from the server, read from what agents
 * get; the SKILL.md itself opens in a dialog.
 */
export function FoundrySkillPage() {
  const { t } = useTranslation("skills");
  const [detail, setDetail] = useState<FoundrySkillDetail>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [manifestOpen, setManifestOpen] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    let cancelled = false;
    setError("");
    getFoundrySkill({ signal: abort.signal })
      .then((value) => {
        if (!cancelled) setDetail(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [attempt]);

  const latestRevision = detail
    ? Math.max(...detail.revisions.map((row) => row.revision))
    : 0;

  return (
    <PageSurface variant="skills" className="fdy-foundry-skill-page">
      <Button
        className="fdy-foundry-skill-back"
        size="sm"
        variant="ghost"
        onClick={navigateToSkills}
      >
        <ArrowLeft size={14} />
        {t("foundrySkill.back")}
      </Button>
      <header className="fdy-management-heading fdy-foundry-skill-heading">
        <div>
          <h1>{t("foundrySkill.title")}</h1>
          <p>{t("foundrySkill.intro")}</p>
          {detail ? (
            <p className="fdy-foundry-skill-revisions">
              {detail.revisions
                .map((row) =>
                  t("foundrySkill.revision", {
                    agent: agentNames[row.runtime],
                    revision: row.revision,
                  }),
                )
                .join(" · ")}
            </p>
          ) : null}
        </div>
        {detail ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setManifestOpen(true)}
          >
            <FileText size={14} />
            {t("foundrySkill.viewManifest")}
          </Button>
        ) : null}
      </header>

      {error ? (
        <Alert tone="error" title={t("foundrySkill.loadFailed", { error })}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t("foundrySkill.retry")}
          </Button>
        </Alert>
      ) : !detail ? (
        <p className="fdy-foundry-skill-note" role="status">
          {t("foundrySkill.loading")}
        </p>
      ) : (
        <>
          <FoundryTools detail={detail} />
          <FoundryGuidance detail={detail} />
        </>
      )}

      {detail && manifestOpen ? (
        <WorkspaceDialog
          size="wide"
          title={t("foundrySkill.manifestTitle")}
          description={t("foundrySkill.manifestDescription", {
            revision: latestRevision,
          })}
          onClose={() => setManifestOpen(false)}
        >
          <pre className="fdy-foundry-skill-manifest" tabIndex={0}>
            {detail.manifest}
          </pre>
        </WorkspaceDialog>
      ) : null}
    </PageSurface>
  );
}

function FoundryTools({ detail }: { detail: FoundrySkillDetail }) {
  const { t } = useTranslation("skills");
  return (
    <section
      aria-labelledby="fdy-foundry-skill-tools"
      className="fdy-foundry-skill-section"
    >
      <header className="fdy-foundry-skill-section-heading">
        <h2 id="fdy-foundry-skill-tools">
          {t("foundrySkill.toolsTitle")}
          <span>
            {t("foundrySkill.toolCount", { count: detail.tools.length })}
          </span>
        </h2>
        <p>
          {inlineCode(
            t("foundrySkill.toolsIntro", {
              prefix: "`mcp__foundry__…`",
              command: "`foundry`",
            }),
          )}
        </p>
      </header>
      <dl
        aria-label={t("foundrySkill.rolesTitle")}
        className="fdy-foundry-skill-roles"
      >
        {roleOrder.map((role) => (
          <div key={role}>
            <dt>{t(`foundrySkill.roles.${role}`)}</dt>
            <dd>{t(`foundrySkill.roleDescriptions.${role}`)}</dd>
          </div>
        ))}
      </dl>
      <ul className="fdy-foundry-skill-tools">
        {detail.tools.map((tool) => (
          <li key={tool.name}>
            <div className="fdy-foundry-skill-tool-name">
              <code>{tool.name}</code>
              {tool.readOnly ? (
                <Badge dot={false} tone="slate">
                  {t("foundrySkill.readOnly")}
                </Badge>
              ) : null}
            </div>
            <p>{tool.summary}</p>
            {tool.limits.length ? (
              <ul className="fdy-foundry-skill-limits">
                {tool.limits.map((limit) => (
                  <li key={limit}>{limit}</li>
                ))}
              </ul>
            ) : null}
            <p className="fdy-foundry-skill-tool-roles">
              <span>{t("foundrySkill.availableTo")}</span>
              {roleOrder
                .filter((role) => tool.roles.includes(role))
                .map((role) => (
                  <Badge dot={false} key={role} tone="neutral">
                    {t(`foundrySkill.roles.${role}`)}
                  </Badge>
                ))}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FoundryGuidance({ detail }: { detail: FoundrySkillDetail }) {
  const { t } = useTranslation("skills");
  return (
    <section
      aria-labelledby="fdy-foundry-skill-guidance"
      className="fdy-foundry-skill-section"
    >
      <header className="fdy-foundry-skill-section-heading">
        <h2 id="fdy-foundry-skill-guidance">
          {t("foundrySkill.guidanceTitle")}
        </h2>
        <p>{t("foundrySkill.guidanceIntro")}</p>
      </header>
      {detail.guidance.map((section) => (
        <div className="fdy-foundry-skill-guidance" key={section.heading}>
          <h3>{section.heading}</h3>
          <ul>
            {section.points.map((point) => (
              <li key={point}>{inlineCode(point)}</li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
