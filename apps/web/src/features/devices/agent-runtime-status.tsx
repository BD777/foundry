import type { NativeCli } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";

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
    <div className="fdy-agent-runtime-status">
      <p>{t("runtimeUpdates.policy")}</p>
      <dl>
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
        <p role={update.state === "failed" ? "alert" : "status"}>
          {update.detail}
        </p>
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
