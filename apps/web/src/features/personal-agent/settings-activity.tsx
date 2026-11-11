import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PersonalAgentActionRecord } from "@bd777/foundry-protocol";
import { listPersonalAgentActions } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { serverErrorText } from "../../lib/errors";
import { fullWhen, relativeWhen } from "../../lib/time-format";
import { Skeleton } from "../../components/ui/loading";
import { PaMuted } from "./pa-muted";
import { DividedList } from "../../components/ui/divided-list";
import { SettingsGroup } from "./settings-field";

type OutcomeKey = "auto" | "confirmed" | "proposed" | "refused" | "failed";

function outcomeOf(record: PersonalAgentActionRecord): OutcomeKey {
  if (record.outcome === "applied")
    return record.confirmedVia ? "confirmed" : "auto";
  return record.outcome;
}

const outcomeTone: Record<OutcomeKey, NonNullable<BadgeProps["tone"]>> = {
  auto: "online",
  confirmed: "online",
  proposed: "brass",
  refused: "neutral",
  failed: "error",
};

const knownTools = new Set([
  "create_workspace",
  "update_workspace",
  "archive_workspace",
  "remember",
  "update_rules",
  "register_folder",
  "rename_workspace",
  "add_skill",
  "remove_skill_created",
  "remove_skill",
  "bind_connector",
  "unbind_connector",
  "restore_workspace",
  "relax_rules",
]);

/**
 * What a row says it concerned, in the person's words: the card's question
 * for what they confirmed, else the project's name. The record's own
 * summary (ids, action keys) and error (written for the assistant) are the
 * audit's, not the person's.
 */
function concerning(
  record: PersonalAgentActionRecord,
  projectName: (workspaceId: string) => string | undefined,
): string | undefined {
  if (record.confirmedVia) return record.argsSummary;
  return record.workspaceId ? projectName(record.workspaceId) : undefined;
}

/** The audit trail: what it changed, or tried to, and how that ended. */
export function ActivitySection({
  projectName,
}: {
  projectName: (workspaceId: string) => string | undefined;
}) {
  const { t } = useTranslation("personalAgent");
  const [records, setRecords] = useState<PersonalAgentActionRecord[]>();
  const [error, setError] = useState("");
  const read = useCallback(async () => {
    try {
      setRecords(await listPersonalAgentActions());
      setError("");
    } catch (reason) {
      setError(serverErrorText(reason));
    }
  }, []);
  useEffect(() => {
    void read();
  }, [read]);

  if (error)
    return (
      <SettingsGroup title={t("settings.activity.title")}>
        <Alert tone="error" title={t("settings.activity.loadFailed")}>
          <p>{error}</p>
          <Button onClick={() => void read()} size="sm">
            {t("retry")}
          </Button>
        </Alert>
      </SettingsGroup>
    );
  if (!records)
    return (
      <SettingsGroup title={t("settings.activity.title")}>
        <Skeleton label={t("loading")} rows={4} variant="rows" />
      </SettingsGroup>
    );
  return (
    <SettingsGroup title={t("settings.activity.title")}>
      <PaMuted className="max-w-[680px] leading-[1.6]" size="sm">
        {t("settings.activity.intro")}
      </PaMuted>
      {records.length ? (
        <DividedList density="none">
          {records.map((record) => {
            const outcome = outcomeOf(record);
            const subject = concerning(record, projectName);
            return (
              <li
                className="grid grid-cols-[110px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 py-2.25 text-sm max-[860px]:grid-cols-[minmax(0,1fr)]"
                key={record.id}
              >
                <PaMuted as="span" title={fullWhen(record.createdAt)}>
                  {relativeWhen(record.createdAt)}
                </PaMuted>
                <span className="grid min-w-0 gap-0.5 wrap-anywhere text-ink">
                  <strong>
                    {knownTools.has(record.tool)
                      ? t(
                          `settings.activity.tools.${record.tool as "remember"}`,
                        )
                      : record.tool}
                  </strong>
                  {subject ? <span>{subject}</span> : null}
                </span>
                <Badge tone={outcomeTone[outcome]}>
                  {t(`settings.activity.outcome.${outcome}`)}
                  {record.refusal
                    ? ` · ${t(`settings.activity.refusal.${record.refusal}`)}`
                    : ""}
                </Badge>
              </li>
            );
          })}
        </DividedList>
      ) : (
        <PaMuted>{t("settings.activity.empty")}</PaMuted>
      )}
    </SettingsGroup>
  );
}
