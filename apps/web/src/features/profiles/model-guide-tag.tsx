import { useTranslation } from "react-i18next";
import type { ModelGuideTarget } from "../../api";
import { Button } from "../../components/ui/button";
import { navigateToModelGuide } from "../../lib/in-app-navigation";
import { useModelGuideLookup } from "./use-model-guide-lookup";

/**
 * A small link to the guide of each listed model that has one; models
 * without a guide show nothing.
 */
export function ModelGuideTags({ targets }: { targets: ModelGuideTarget[] }) {
  const { t } = useTranslation("profiles");
  const { resolutionOf } = useModelGuideLookup(targets);
  const linked = targets.flatMap((target) => {
    const guide = resolutionOf(target)?.guide;
    return guide ? [{ target, guide }] : [];
  });
  if (!linked.length) return null;
  return (
    <ul
      className="m-0 flex min-w-0 list-none flex-wrap items-center gap-x-3 gap-y-0.5 p-0"
      data-model-guide-tags
    >
      {linked.map(({ target, guide }) => (
        <li className="flex min-w-0 items-baseline gap-1.5" key={target.model}>
          <code className="min-w-0 truncate font-mono text-2xs text-ink-faint">
            {target.model}
          </code>
          <Button
            aria-label={t("modelGuides.tagOpen", {
              name: guide.displayName,
              model: target.model,
            })}
            className="text-2xs"
            size="sm"
            variant="link"
            onClick={() => navigateToModelGuide(guide.id)}
          >
            {t("modelGuides.tag")}
          </Button>
        </li>
      ))}
    </ul>
  );
}
