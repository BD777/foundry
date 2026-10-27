import { FieldHint } from "../../components/ui/field";
import type { NativeCli } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";

/** Updates are managed by the worker; the user need not open a terminal. */
export function AgentRuntimeUpdateNotice({
  cli,
  name,
  online,
  busy,
  onUpdate,
}: {
  cli: NativeCli;
  name: string;
  online: boolean;
  busy: boolean;
  onUpdate: () => void;
}) {
  const { t } = useTranslation("profiles");
  const state = cli.update?.state;
  if (
    !cli.outdated &&
    !["failed", "waiting_idle", "updating", "available"].includes(state ?? "")
  )
    return null;
  const updating = busy || state === "updating";
  return (
    <Alert
      tone={state === "failed" ? "error" : "warning"}
      title={t("runtimeUpdates.noticeTitle", {
        name,
        version: cli.version,
        target: cli.update?.target ?? cli.minimumVersion,
      })}
    >
      <FieldHint>
        {!cli.generation
          ? t("runtimeUpdates.workerRequired")
          : state === "external"
            ? t("runtimeUpdates.externalHint")
            : state === "waiting_idle"
              ? t("runtimeUpdates.waitingHint", { name })
              : state === "updating"
                ? t("runtimeUpdates.updatingHint")
                : state === "failed"
                  ? t("runtimeUpdates.failedHint")
                  : t("runtimeUpdates.automaticHint")}
      </FieldHint>
      {cli.generation && state !== "external" ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={!online || updating}
          aria-busy={updating}
          aria-label={t("runtimeUpdates.updateNowLabel", { name })}
          onClick={onUpdate}
        >
          {updating
            ? t("runtimeUpdates.checking")
            : t("runtimeUpdates.updateNow")}
        </Button>
      ) : null}
    </Alert>
  );
}
