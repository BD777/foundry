import type { NativeCli } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { HelpHint } from "../../components/ui/help-hint";

export function AgentRuntimeStatus({
  cli,
  online,
  busy,
  onCheck,
}: {
  cli: NativeCli;
  online: boolean;
  busy: boolean;
  onCheck: () => void;
}) {
  const { t } = useTranslation("profiles");
  const update = cli.update;
  return (
    <div className="min-w-0">
      <div className="my-3 flex items-center gap-1.5 text-xs">
        <strong>{t("runtimeUpdates.title")}</strong>
        <HelpHint label={t("runtimeUpdates.policyLabel")}>
          {t("runtimeUpdates.policy")}
        </HelpHint>
      </div>
      <dl className="grid grid-cols-[minmax(7rem,1fr)_minmax(0,3fr)] gap-x-4 gap-y-2 [&>dd]:wrap-anywhere">
        <dt>{t("runtimeUpdates.current")}</dt>
        <dd>{cli.version ?? "—"}</dd>
        <dt>{t("runtimeUpdates.path")}</dt>
        <dd>{cli.path ?? "—"}</dd>
        <dt>{t("runtimeUpdates.target")}</dt>
        <dd>{update?.target ?? "—"}</dd>
        {update?.sdkTarget ? (
          <>
            <dt>{t("runtimeUpdates.sdk")}</dt>
            <dd>{update.sdkTarget}</dd>
          </>
        ) : null}
        <dt>{t("runtimeUpdates.status")}</dt>
        <dd>{t(`runtimeUpdates.states.${update?.state ?? "unknown"}`)}</dd>
      </dl>
      {update?.detail ? (
        <Alert
          className="my-3"
          size="compact"
          tone={update.state === "failed" ? "error" : "info"}
          title={update.detail}
        />
      ) : null}
      <Button
        size="sm"
        variant="secondary"
        busy={busy}
        disabled={!online}
        onClick={onCheck}
      >
        {busy ? t("runtimeUpdates.checking") : t("runtimeUpdates.check")}
      </Button>
    </div>
  );
}
