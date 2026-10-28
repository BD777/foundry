import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  PersonalAgent,
  PersonalAgentOverview,
} from "@bd777/foundry-protocol";
import { ownedDeviceCandidates } from "../../lib/devices";
import { setupPersonalAgent } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { browserTimezone } from "./assistant-model";
import { AssistantSetup } from "./assistant-setup";
import type { AssistantController } from "./use-assistant";
import { LoadingState } from "../../components/ui/loading";

/**
 * What both assistant pages show until there is an assistant: loading, an
 * older server, a failed read, or the one-tap setup.
 */
export function AssistantGate({
  assistant,
  devices,
  onConnectComputer,
  children,
}: {
  assistant: AssistantController;
  devices: DeviceProjection[];
  onConnectComputer: () => void;
  children: (
    agent: PersonalAgent,
    overview: PersonalAgentOverview,
  ) => ReactNode;
}) {
  const { t } = useTranslation("personalAgent");
  const { load } = assistant;
  if (load.state === "ready" && load.overview.agent)
    return <>{children(load.overview.agent, load.overview)}</>;
  return (
    <div className="fdy-pa-state">
      {load.state === "loading" ? (
        <LoadingState label={t("loading")} layout="block" />
      ) : load.state === "unavailable" ? (
        <EmptyState
          body={t("unavailable.body")}
          title={t("unavailable.title")}
        />
      ) : load.state === "failed" ? (
        <Alert tone="error" title={t("loadFailed")}>
          <p>{load.message}</p>
          <Button onClick={() => void assistant.reload()} size="sm">
            {t("retry")}
          </Button>
        </Alert>
      ) : (
        <AssistantSetup
          devices={ownedDeviceCandidates(devices)}
          onConnectComputer={onConnectComputer}
          onSetUp={async (deviceId) => {
            await setupPersonalAgent({
              deviceId,
              timezone: browserTimezone() || undefined,
            });
            await assistant.reload();
          }}
          suggestedDeviceId={load.overview.suggestedHomeDeviceId}
        />
      )}
    </div>
  );
}
