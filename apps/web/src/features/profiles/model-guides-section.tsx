import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelGuideSummary } from "@bd777/foundry-protocol";
import { listModelGuides } from "../../api";
import { ActionRow } from "../../components/ui/action-row";
import { Alert } from "../../components/ui/alert";
import { EmptyState } from "../../components/ui/empty-state";
import { LoadingState } from "../../components/ui/loading";
import { SectionHeader } from "../../components/ui/page-header";
import { SectionPanel } from "../../components/ui/section-panel";
import { MutedText } from "../../components/ui/text";
import { readPageQuery, replacePageQuery } from "../../lib/page-query";
import { relativeWhen } from "../../lib/time-format";
import { UnlinkedModels } from "./unlinked-models";
import { ModelGuideDialog } from "./model-guide-dialog";

/** The orchestrator's guides to each model, read-only; a row opens its details. */
export function ModelGuidesSection() {
  const { t } = useTranslation("profiles");
  const [guides, setGuides] = useState<ModelGuideSummary[]>();
  const [error, setError] = useState(false);
  const requested = useRef(readPageQuery("guide"));
  const [openId, setOpenId] = useState(requested.current);

  useEffect(() => {
    let active = true;
    listModelGuides().then(
      (list) => {
        if (active) setGuides(list.guides);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  function show(id: string) {
    setOpenId(id);
    replacePageQuery({ guide: id });
  }

  return (
    <SectionPanel className="grid min-w-0 gap-3">
      <SectionHeader
        level={3}
        title={t("modelGuides.title")}
        description={t("modelGuides.intro")}
      />
      <UnlinkedModels />
      {error ? (
        <Alert
          size="compact"
          tone="error"
          title={t("modelGuides.loadFailed")}
        />
      ) : !guides ? (
        <LoadingState label={t("modelGuides.loading")} />
      ) : guides.length === 0 ? (
        <EmptyState
          title={t("modelGuides.title")}
          body={t("modelGuides.empty")}
        />
      ) : (
        <ul className="m-0 grid min-w-0 list-none p-0">
          {guides.map((guide) => (
            <li className="min-w-0" key={guide.id}>
              <ActionRow
                aria-label={t("modelGuides.open", { name: guide.displayName })}
                className="flex items-center gap-3"
                density="compact"
                variant="table"
                onClick={() => show(guide.id)}
              >
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <strong className="min-w-0 truncate text-sm">
                      {guide.displayName}
                    </strong>
                    <code className="min-w-0 truncate font-mono text-2xs text-ink-faint">
                      {guide.id}
                    </code>
                    <MutedText as="small" tone="faint">
                      {t("modelGuides.aliasCount", { count: guide.aliasCount })}
                    </MutedText>
                  </span>
                  <MutedText as="span">
                    {guide.summary || t("modelGuides.noSummary")}
                  </MutedText>
                  <MutedText as="small" tone="faint">
                    {t("modelGuides.updated", {
                      name: guide.updatedBy.name,
                      time: relativeWhen(guide.updatedAt),
                    })}
                  </MutedText>
                </span>
                <ChevronRight
                  aria-hidden
                  className="flex-none text-ink-faint"
                  size={16}
                />
              </ActionRow>
            </li>
          ))}
        </ul>
      )}
      {openId ? (
        <ModelGuideDialog
          guideId={openId}
          onClose={() => {
            setOpenId("");
            replacePageQuery({ guide: "" });
          }}
        />
      ) : null}
    </SectionPanel>
  );
}
