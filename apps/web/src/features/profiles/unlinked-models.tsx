import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExecutionModelDefault,
  WorkerGroup,
} from "@bd777/foundry-protocol";
import {
  getExecutionDefault,
  listWorkerGroups,
  type ModelGuideTarget,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { CopyButton } from "../../components/ui/copy-button";
import { FieldHint } from "../../components/ui/field";
import { MutedText } from "../../components/ui/text";
import { guideTargetKey, useModelGuideLookup } from "./use-model-guide-lookup";

interface UsedModel {
  target: ModelGuideTarget;
  usedBy: string[];
}

/** Every model the default and the worker groups run, with where it is used. */
export function usedModels(
  defaultModel: ExecutionModelDefault | undefined,
  groups: WorkerGroup[],
  defaultLabel: string,
): UsedModel[] {
  const used = new Map<string, UsedModel>();
  const add = (target: ModelGuideTarget, label: string) => {
    const key = guideTargetKey(target);
    const found = used.get(key);
    if (!found) used.set(key, { target, usedBy: [label] });
    else if (!found.usedBy.includes(label)) found.usedBy.push(label);
  };
  if (defaultModel?.providerId && defaultModel.model)
    add(
      {
        providerKind: defaultModel.providerKind ?? "",
        providerId: defaultModel.providerId,
        runtime: defaultModel.runtime ?? "",
        model: defaultModel.model,
      },
      defaultLabel,
    );
  for (const group of groups)
    for (const member of group.members)
      add(
        {
          providerKind: member.providerKind,
          providerId: member.providerId,
          runtime: member.runtime,
          model: member.model,
        },
        group.label,
      );
  return [...used.values()];
}

/**
 * The models the default execution model and the worker groups use that no
 * guide covers yet, each with the id to create one under and a sentence to
 * ask the orchestrator with.
 */
export function UnlinkedModels() {
  const { t } = useTranslation("profiles");
  const [used, setUsed] = useState<UsedModel[]>([]);
  const defaultLabel = t("page.sections.default");
  useEffect(() => {
    let active = true;
    Promise.all([getExecutionDefault(), listWorkerGroups()]).then(
      ([view, groups]) => {
        if (active) setUsed(usedModels(view.effective, groups, defaultLabel));
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [defaultLabel]);
  const { resolutionOf } = useModelGuideLookup(used.map((row) => row.target));
  const unlinked = used.flatMap((row) => {
    const resolution = resolutionOf(row.target);
    return resolution && !resolution.guide ? [{ ...row, resolution }] : [];
  });
  if (!unlinked.length) return null;
  return (
    <Alert
      data-unlinked-models
      size="compact"
      tone="warning"
      title={t("modelGuides.unlinkedTitle")}
    >
      <div className="grid min-w-0 gap-2">
        <FieldHint className="mt-0">{t("modelGuides.unlinkedIntro")}</FieldHint>
        <ul className="m-0 grid min-w-0 list-none gap-2 p-0">
          {unlinked.map(({ target, usedBy, resolution }) => {
            const example = t(
              resolution.suggestedIdTaken
                ? "modelGuides.unlinkedAliasExample"
                : "modelGuides.unlinkedCreateExample",
              { id: resolution.suggestedId, model: target.model },
            );
            return (
              <li
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
                key={guideTargetKey(target)}
              >
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <code className="min-w-0 truncate font-mono text-sm">
                      {target.model}
                    </code>
                    <MutedText as="small" tone="faint">
                      {t("modelGuides.unlinkedSuggested", {
                        id: resolution.suggestedId,
                      })}
                    </MutedText>
                  </span>
                  <MutedText as="small" tone="faint">
                    {t("modelGuides.unlinkedUsedBy", {
                      places: usedBy.join(", "),
                    })}
                  </MutedText>
                </span>
                <CopyButton
                  copiedLabel={t("modelGuides.copiedExample")}
                  label={t("modelGuides.copyExample")}
                  text={example}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </Alert>
  );
}
