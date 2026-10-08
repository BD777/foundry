import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type { DeviceProjection, DeviceSkill } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { SkillCatalogList } from "../../components/skills/skill-catalog-list";
import {
  toNormalizedDeviceSkill,
  type NormalizedSkill,
} from "../../components/skills/skill-models";
import { SkillPromotionDialog } from "../../components/skills/skill-promotion-dialog";
import { skillServerLabel } from "../../components/skills/skill-version-state";

/** Skills on a device that the server has no identical copy of. */
export function localOnlySkills(
  deviceSkills: DeviceSkill[],
  deviceId: string,
): DeviceSkill[] {
  return deviceSkills.filter(
    (skill) =>
      skill.deviceId === deviceId &&
      skill.serverState !== "in_sync" &&
      skill.serverState !== "reusable",
  );
}

/**
 * Skills on the workspace's device that the server has no identical copy of.
 * Adding one publishes it, after reviewing any difference from a same-named
 * server entry, and hands back the server entry for the workspace to select.
 */
export function LocalSkillsSection({
  device,
  deviceSkills,
  readOnly,
  onChanged,
  onPromoted,
}: {
  device: DeviceProjection;
  deviceSkills: DeviceSkill[];
  readOnly: boolean;
  onChanged: () => Promise<void>;
  onPromoted: (skillId: string) => void;
}) {
  const { t } = useTranslation("skills");
  const [adding, setAdding] = useState<DeviceSkill>();
  const onDevice = useMemo(
    () => deviceSkills.filter((skill) => skill.deviceId === device.id),
    [deviceSkills, device.id],
  );
  const localOnly = useMemo(
    () => localOnlySkills(onDevice, device.id).map(toNormalizedDeviceSkill),
    [onDevice, device.id],
  );
  const online = device.status === "connected";
  if (!localOnly.length) return null;
  return (
    <>
      <SkillCatalogList<NormalizedSkill>
        description={t("workspace.localDescription", { device: device.label })}
        mode="device"
        renderActions={(skill) => {
          const raw = skill.deviceSkill;
          if (!raw) return null;
          return (
            <Button
              disabled={readOnly || raw.sizeBytes < 0 || !online}
              onClick={() => setAdding(raw)}
              size="sm"
              variant="secondary"
            >
              <Plus size={14} />
              {t("workspace.addLocal")}
            </Button>
          );
        }}
        renderBadges={(skill) =>
          skill.deviceSkill?.serverState === "different" ||
          skill.deviceSkill?.serverState === "name_conflict" ? (
            <Badge tone="warn">{skillServerLabel(skill.deviceSkill)}</Badge>
          ) : null
        }
        searchPlaceholder={t("workspace.localSearchPlaceholder")}
        skills={localOnly}
        title={t("workspace.localTitle", { device: device.label })}
      />
      {adding ? (
        <SkillPromotionDialog
          onChanged={onChanged}
          onClose={() => setAdding(undefined)}
          onPromoted={async (promoted) => onPromoted(promoted.id)}
          online={online}
          skill={adding}
          skills={onDevice}
        />
      ) : null}
    </>
  );
}
