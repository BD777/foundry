import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelGuideSummary, WorkerGroup } from "@bd777/foundry-protocol";
import { resolveModelGuide, type ModelGuideTarget } from "../../api";
import { navigateToModelGuide } from "../../lib/in-app-navigation";
import { Button } from "../ui/button";
import { MutedText } from "../ui/text";

type GuideTarget = ModelGuideTarget;

interface Resolved {
  target: GuideTarget;
  guide?: ModelGuideSummary;
}

/**
 * The model guide of a model, or of each member of `group` when one is
 * chosen. A guide opens its details; none says so.
 */
export function ModelGuideLink({
  group,
  ...model
}: Partial<GuideTarget> & { group?: WorkerGroup }) {
  const { t } = useTranslation("agents");
  const targets: GuideTarget[] = group
    ? group.members.map((member) => ({
        providerKind: member.providerKind,
        providerId: member.providerId,
        runtime: member.runtime,
        model: member.model,
      }))
    : model.providerId && model.model
      ? [
          {
            providerKind: model.providerKind ?? "",
            providerId: model.providerId,
            runtime: model.runtime ?? "",
            model: model.model,
          },
        ]
      : [];
  const [resolved, setResolved] = useState<Resolved[]>([]);
  const key = JSON.stringify(targets);
  useEffect(() => {
    let active = true;
    setResolved([]);
    const wanted = JSON.parse(key) as GuideTarget[];
    Promise.all(
      wanted.map((target) =>
        resolveModelGuide(target).then(
          (result): Resolved => ({ target, guide: result.guide }),
          (): Resolved => ({ target }),
        ),
      ),
    ).then((rows) => {
      if (active) setResolved(rows);
    });
    return () => {
      active = false;
    };
  }, [key]);
  if (!resolved.length) return null;
  const guides = new Map<string, ModelGuideSummary>();
  const missing: string[] = [];
  for (const row of resolved) {
    if (row.guide) guides.set(row.guide.id, row.guide);
    else missing.push(row.target.model);
  }
  const several = resolved.length > 1;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      {several ? (
        <MutedText as="span">{t("executionDefault.guideGroup")}</MutedText>
      ) : null}
      {[...guides.values()].map((guide) => (
        <Button
          aria-label={t("executionDefault.guideOpen", {
            name: guide.displayName,
          })}
          key={guide.id}
          size="sm"
          variant="link"
          onClick={() => navigateToModelGuide(guide.id)}
        >
          {t("executionDefault.guide", { name: guide.displayName })}
          <ChevronRight aria-hidden size={13} />
        </Button>
      ))}
      {missing.length ? (
        <MutedText as="span">
          {several
            ? `${t("executionDefault.guideNone")}: ${missing.join(", ")}`
            : t("executionDefault.guideNone")}
        </MutedText>
      ) : null}
    </div>
  );
}
