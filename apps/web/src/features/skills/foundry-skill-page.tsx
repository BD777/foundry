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
import { runtimeMeta } from "../../components/agent-runtime/runtime-mark";
import { WorkspaceDialog } from "../../components/workspace/workspace-dialog";
import { Skeleton } from "../../components/ui/loading";
import { PageHeader } from "../../components/ui/page-header";
import { RowCard } from "../../components/ui/row-card";

const roleOrder: FoundryToolRole[] = [
  "session",
  "issue_execution",
  "issue_clarification",
  "verifier",
  "personal_agent",
];

/** SKILL.md text with its `inline code` set as code. */
export function inlineCode(text: string): ReactNode[] {
  return text.split("`").map((part, index) =>
    index % 2 ? (
      <code className="font-mono text-xs [overflow-wrap:anywhere]" key={index}>
        {part}
      </code>
    ) : (
      part
    ),
  );
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
    <PageSurface variant="skills" className="gap-6">
      <Button
        className="self-start"
        size="sm"
        variant="ghost"
        onClick={navigateToSkills}
      >
        <ArrowLeft size={14} />
        {t("foundrySkill.back")}
      </Button>
      <PageHeader
        title={t("foundrySkill.title")}
        description={t("foundrySkill.intro")}
        actions={
          detail ? (
            <Button
              className="shrink-0"
              size="sm"
              variant="secondary"
              onClick={() => setManifestOpen(true)}
            >
              <FileText size={14} />
              {t("foundrySkill.viewManifest")}
            </Button>
          ) : null
        }
      />
      {detail ? (
        <p className="fdy-foundry-skill-revisions text-xs text-ink-faint">
          {detail.revisions
            .map((row) =>
              t("foundrySkill.revision", {
                agent: runtimeMeta(row.runtime).productName,
                revision: row.revision,
              }),
            )
            .join(" · ")}
        </p>
      ) : null}

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
        <Skeleton label={t("foundrySkill.loading")} rows={5} />
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
          <pre
            className="fdy-foundry-skill-manifest rounded-md bg-surface p-3.5 font-mono text-xs leading-[1.6] whitespace-pre-wrap text-ink shadow-card [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-soft"
            tabIndex={0}
          >
            {detail.manifest}
          </pre>
        </WorkspaceDialog>
      ) : null}
    </PageSurface>
  );
}

function SectionHeading({
  count,
  description,
  id,
  title,
}: {
  count?: string;
  description: ReactNode;
  id: string;
  title: string;
}) {
  return (
    <header>
      <h2 className="flex items-baseline gap-2.5 text-lg text-ink" id={id}>
        {title}
        {count ? (
          <span className="text-xs font-normal text-ink-muted">{count}</span>
        ) : null}
      </h2>
      <p className="mt-1.5 text-sm leading-[1.6] text-ink-muted">
        {description}
      </p>
    </header>
  );
}

function FoundryTools({ detail }: { detail: FoundrySkillDetail }) {
  const { t } = useTranslation("skills");
  return (
    <section
      aria-labelledby="fdy-foundry-skill-tools"
      className="grid min-w-0 gap-3.5"
    >
      <SectionHeading
        count={t("foundrySkill.toolCount", { count: detail.tools.length })}
        description={inlineCode(
          t("foundrySkill.toolsIntro", {
            prefix: "`mcp__foundry__…`",
            command: "`foundry`",
          }),
        )}
        id="fdy-foundry-skill-tools"
        title={t("foundrySkill.toolsTitle")}
      />
      <dl
        aria-label={t("foundrySkill.rolesTitle")}
        className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-5 gap-y-2"
      >
        {roleOrder.map((role) => (
          <div className="min-w-0" key={role}>
            <dt className="text-xs font-semibold text-ink">
              {t(`foundrySkill.roles.${role}`)}
            </dt>
            <dd className="mt-0.5 text-xs leading-normal text-ink-muted">
              {t(`foundrySkill.roleDescriptions.${role}`)}
            </dd>
          </div>
        ))}
      </dl>
      <RowCard as="ul" className="fdy-foundry-skill-tools grid" tone="ring">
        {detail.tools.map((tool) => (
          <li
            className="grid min-w-0 gap-1.5 px-3.5 py-3 not-first:border-t not-first:border-line-soft"
            key={tool.name}
          >
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-sm font-semibold text-ink [overflow-wrap:anywhere]">
                {tool.name}
              </code>
              {tool.readOnly ? (
                <Badge dot={false} tone="slate">
                  {t("foundrySkill.readOnly")}
                </Badge>
              ) : null}
            </div>
            <p className="text-sm leading-[1.55] text-ink">{tool.summary}</p>
            {tool.limits.length ? (
              <ul className="grid list-disc gap-0.5 pl-4.5 text-xs leading-[1.55] text-ink-muted">
                {tool.limits.map((limit) => (
                  <li key={limit}>{limit}</li>
                ))}
              </ul>
            ) : null}
            <p className="flex flex-wrap items-center gap-1.5 text-xs leading-[1.55] text-ink-faint">
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
      </RowCard>
    </section>
  );
}

function FoundryGuidance({ detail }: { detail: FoundrySkillDetail }) {
  const { t } = useTranslation("skills");
  return (
    <section
      aria-labelledby="fdy-foundry-skill-guidance"
      className="grid min-w-0 gap-3.5"
    >
      <SectionHeading
        description={t("foundrySkill.guidanceIntro")}
        id="fdy-foundry-skill-guidance"
        title={t("foundrySkill.guidanceTitle")}
      />
      {detail.guidance.map((section) => (
        <div
          className="fdy-foundry-skill-guidance grid min-w-0 gap-1.5"
          key={section.heading}
        >
          <h3 className="text-sm text-ink">{section.heading}</h3>
          <ul className="grid list-disc gap-1 pl-4.5 text-sm leading-[1.55] text-ink">
            {section.points.map((point) => (
              <li key={point}>{inlineCode(point)}</li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
