import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  KnowledgePublication,
  PersonalAgentRunSnapshot,
} from "@bd777/foundry-protocol";
import { allowAssistantMemory, previewAssistantMemoryAccount } from "../../api";
import { Button } from "../../components/ui/button";
import { FieldHint } from "../../components/ui/field";
import { SettingsGroup } from "./settings-field";

export function KnowledgeRecallSection({
  assistantId,
  devices,
  primaryId,
  busy,
  publications,
  requestId,
  run,
}: {
  assistantId?: string;
  devices: DeviceProjection[];
  primaryId: string;
  busy: boolean;
  publications: KnowledgePublication[];
  requestId: (key: string) => string;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const { t } = useTranslation("personalAgent");
  const [recallPreview, setRecallPreview] =
    useState<PersonalAgentRunSnapshot>();

  return (
    <SettingsGroup title={t("knowledge.recallTitle")}>
      <FieldHint>{t("knowledge.recallHint")}</FieldHint>
      <Button
        disabled={busy}
        onClick={() =>
          void run(async () =>
            setRecallPreview(await previewAssistantMemoryAccount(assistantId)),
          )
        }
      >
        {t("knowledge.previewRecall")}
      </Button>
      {recallPreview ? (
        <>
          <p>
            {t("knowledge.recallAccount", {
              profile: recallPreview.profileId,
              device:
                devices.find((device) => device.id === recallPreview.deviceId)
                  ?.label ?? recallPreview.deviceId,
              provider: recallPreview.providerOrigin || recallPreview.runtime,
            })}
          </p>
          <FieldHint>
            {t("knowledge.cachedAccount", {
              label:
                recallPreview.accountLabel || t("knowledge.accountNotNamed"),
            })}
          </FieldHint>
          <Button
            disabled={busy || !recallPreview.profileFingerprint}
            onClick={() =>
              void run(() =>
                allowAssistantMemory(
                  assistantId,
                  primaryId,
                  requestId(
                    JSON.stringify([
                      "recall",
                      primaryId,
                      recallPreview.configHash,
                      publications
                        .filter(
                          (publication) => publication.scope === "memory_root",
                        )
                        .map((publication) => [
                          publication.id,
                          publication.revision,
                        ]),
                    ]),
                  ),
                  recallPreview.configHash,
                ),
              )
            }
          >
            {t("knowledge.enableRecall")}
          </Button>
        </>
      ) : null}
    </SettingsGroup>
  );
}
