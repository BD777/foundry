import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelGuide, ModelGuideSections } from "@bd777/foundry-protocol";
import { getModelGuideRevision } from "../../api";
import { Alert } from "../../components/ui/alert";
import { FileDiff } from "../../components/ui/file-diff";
import { MutedText } from "../../components/ui/text";
import {
  SelectMenu,
  type SelectMenuOption,
} from "../../components/ui/select-menu";
import { modelGuideSectionKeys } from "./model-guide-sections";

/** The guide's sections as one text, a heading per section, so a diff reads section by section. */
function sectionText(
  sections: ModelGuideSections,
  heading: (key: keyof ModelGuideSections) => string,
): string {
  return modelGuideSectionKeys
    .map((key) => `## ${heading(key)}\n${(sections[key] ?? "").trim()}\n`)
    .join("\n");
}

/** Pick a revision and read how it differs from the current guide. */
export function ModelGuideRevisions({
  guide,
  revisions,
}: {
  guide: ModelGuide;
  revisions: { revision: number; changeSummary: string }[];
}) {
  const { t } = useTranslation("profiles");
  const [picked, setPicked] = useState("");
  const [snapshot, setSnapshot] = useState<ModelGuide>();
  const [error, setError] = useState(false);
  useEffect(() => {
    setSnapshot(undefined);
    setError(false);
    if (!picked) return;
    let cancelled = false;
    getModelGuideRevision(guide.id, Number(picked)).then(
      (revision) => {
        if (!cancelled) setSnapshot(revision.snapshot);
      },
      () => {
        if (!cancelled) setError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [guide.id, picked]);
  const heading = (key: keyof ModelGuideSections) =>
    t(`modelGuides.sections.${key}`);
  const before = useMemo(
    () => (snapshot ? sectionText(snapshot.sections, heading) : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, t],
  );
  const after = useMemo(
    () => sectionText(guide.sections, heading),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [guide, t],
  );
  const options: SelectMenuOption[] = [
    { value: "", label: t("modelGuides.compareNone") },
    ...revisions.map((item) => ({
      value: String(item.revision),
      label: t("modelGuides.revisionOption", {
        revision: item.revision,
        summary: item.changeSummary,
      }),
      disabled: item.revision === guide.revision,
      meta:
        item.revision === guide.revision
          ? t("modelGuides.historyCurrent")
          : undefined,
    })),
  ];
  return (
    <div className="grid min-w-0 gap-3">
      <SelectMenu
        ariaLabel={t("modelGuides.compareWith")}
        className="w-full max-w-full"
        insideDialog
        options={options}
        value={picked}
        onChange={setPicked}
      />
      {error ? (
        <Alert
          size="compact"
          tone="error"
          title={t("modelGuides.compareFailed")}
        />
      ) : snapshot ? (
        before === after ? (
          <MutedText>{t("modelGuides.compareSame")}</MutedText>
        ) : (
          <FileDiff before={before} after={after} errorCopy="file" />
        )
      ) : null}
    </div>
  );
}
