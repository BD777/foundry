import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MessageChannelPrerequisites } from "@bd777/foundry-protocol";
import { grantMessageChannelSource } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { serverErrorText } from "../../lib/errors";

/** Whether the channel's sessions can reach its source yet. */
export function prerequisitesMissing(
  prerequisites: MessageChannelPrerequisites,
): boolean {
  return !prerequisites.allowed;
}

/**
 * What the channel's source still lacks, and the one click that grants it:
 * never granted without that click.
 */
export function PrerequisiteNotice({
  assistantId,
  accountId,
  prerequisites,
  onGranted,
}: {
  assistantId?: string;
  accountId: string;
  prerequisites: MessageChannelPrerequisites;
  onGranted: (next: MessageChannelPrerequisites) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState("");
  if (!prerequisitesMissing(prerequisites)) return null;
  async function grant(): Promise<void> {
    setGranting(true);
    setError("");
    try {
      onGranted(await grantMessageChannelSource(assistantId, accountId));
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setGranting(false);
    }
  }
  return (
    <Alert
      actions={
        <Button
          busy={granting}
          disabled={granting}
          onClick={() => void grant()}
          size="sm"
          variant="primary"
        >
          {granting
            ? t("settings.channels.prerequisites.granting")
            : t("settings.channels.prerequisites.grant")}
        </Button>
      }
      size="compact"
      title={t("settings.channels.prerequisites.title")}
      tone="warning"
    >
      <ul className="grid gap-0.5">
        {!prerequisites.allowed ? (
          <li>{t("settings.channels.prerequisites.notAllowed")}</li>
        ) : null}
        {error ? (
          <li>
            {t("settings.channels.prerequisites.grantFailed")}: {error}
          </li>
        ) : null}
      </ul>
    </Alert>
  );
}
