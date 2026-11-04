import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  AgentProfileProjection,
  DeviceProfileBinding,
  DeviceProjection,
  ProfileDefinition,
  ProviderHealth,
} from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { SectionPanel } from "../../components/ui/section-panel";
import { SectionHeader } from "../../components/ui/page-header";
import { RuntimeMark } from "../../components/agent-runtime/runtime-mark";
import {
  localLoginRow,
  RuntimeAccountRow,
  type NativeRuntime,
} from "./device-accounts";
import {
  NativeSignInDialog,
  type NativeSignInTarget,
} from "./native-sign-in-dialog";
import { subscriptionName } from "./subscription-text";

/**
 * The official subscriptions, one group per runtime: each of the person's
 * devices is a row with that device's own login. Signing in, checking,
 * usage and defaults all happen here.
 */
export function SubscriptionsSection({
  devices,
  runtimes,
  profiles,
  providerHealth,
  bindings,
  serverProfiles,
  onRefresh,
}: {
  devices: DeviceProjection[];
  runtimes: NativeRuntime[];
  profiles: AgentProfileProjection[];
  providerHealth: ProviderHealth[];
  bindings: DeviceProfileBinding[];
  serverProfiles: ProfileDefinition[];
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("profiles");
  const [signingIn, setSigningIn] = useState<NativeSignInTarget>();
  const [collapsed, setCollapsed] = useState<Set<NativeRuntime>>(new Set());
  return (
    <section className="grid min-w-0 gap-4">
      <SectionHeader
        title={t("subscriptions.title")}
        description={t("subscriptions.intro")}
      />
      {devices.length === 0 ? (
        <SectionPanel>
          <p className="m-0 text-sm text-ink-muted">
            {t("subscriptions.noDevices")}
          </p>
        </SectionPanel>
      ) : (
        runtimes.map((runtime) => {
          const name = subscriptionName(t, runtime);
          const signedIn = devices.filter(
            (device) =>
              localLoginRow(profiles, device.id, runtime)?.status === "healthy",
          ).length;
          const open = !collapsed.has(runtime);
          return (
            <SectionPanel className="gap-0 py-2" key={runtime}>
              <Button
                variant="ghost"
                className="-mx-2 h-auto justify-start gap-3 rounded-lg p-2 text-left whitespace-normal active:scale-100"
                aria-expanded={open}
                onClick={() => {
                  const next = new Set(collapsed);
                  if (open) next.add(runtime);
                  else next.delete(runtime);
                  setCollapsed(next);
                }}
              >
                <RuntimeMark runtime={runtime} size="lg" />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <strong className="text-md text-ink">{name}</strong>
                  <small className="text-xs font-normal text-ink-muted">
                    {t("subscriptions.meta")}
                  </small>
                </span>
                <Badge tone={signedIn ? "online" : "neutral"}>
                  {t("subscriptions.signedInCount", {
                    count: signedIn,
                    total: devices.length,
                  })}
                </Badge>
                {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </Button>
              {open ? (
                <div className="grid border-t border-line">
                  {devices.map((device) => (
                    <RuntimeAccountRow
                      key={device.id}
                      device={device}
                      runtime={runtime}
                      profiles={profiles}
                      health={providerHealth.filter(
                        (row) => row.deviceId === device.id,
                      )}
                      bindings={bindings}
                      serverProfiles={serverProfiles}
                      onRefresh={onRefresh}
                      onSignIn={() =>
                        setSigningIn({
                          deviceId: device.id,
                          deviceName: device.label,
                          runtime,
                        })
                      }
                    />
                  ))}
                </div>
              ) : null}
            </SectionPanel>
          );
        })
      )}
      <NativeSignInDialog
        target={signingIn}
        onClose={() => setSigningIn(undefined)}
        onSignedIn={() => {
          setSigningIn(undefined);
          void onRefresh();
        }}
      />
    </section>
  );
}
