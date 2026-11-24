import type { DeviceSkill } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";

export function SkillLibraryRelationBadge({
  relation,
}: {
  relation: DeviceSkill["libraryRelation"];
}) {
  const { t } = useTranslation("skills");
  const status = relation?.status ?? "unknown";
  const older =
    status === "same" && relation?.matchedRevision !== relation?.latestRevision;
  const tone =
    older || status === "differs" || status === "diverged"
      ? "warn"
      : status === "same"
        ? "online"
        : "neutral";
  return (
    <Badge
      tone={tone}
      className="h-auto max-w-full whitespace-normal py-1 leading-tight"
    >
      {t(`libraryRelation.${older ? "sameOlder" : status}`, {
        latest: relation?.latestRevision,
        revision: relation?.matchedRevision,
        base: relation?.baseRevision,
      })}
    </Badge>
  );
}
