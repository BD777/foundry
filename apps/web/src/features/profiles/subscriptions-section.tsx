import { createAgentProfile } from "../../api";
import { Dialog } from "../../components/ui/dialog";
import { TextInput } from "../../components/ui/field";
import { Alert } from "../../components/ui/alert";
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
import { RuntimeAccountRow, type NativeRuntime } from "./device-accounts";
import {
  NativeSignInDialog,
  type NativeSignInTarget,
} from "./native-sign-in-dialog";
import {
  executionSources,
  sourceModels,
} from "../../components/workspace/execution-sources";
import { ModelGuideTags } from "./model-guide-tag";
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
  const [creating, setCreating] = useState<{
    device: DeviceProjection;
    id: string;
  }>();
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  function openCreate(device: DeviceProjection) {
    setLabel("");
    setError("");
    setCreating({ device, id: crypto.randomUUID() });
  }
  async function create() {
    if (!creating || saving || !label.trim()) return;
    setSaving(true);
    setError("");
    const { device, id } = creating;
    try {
      const profile = await createAgentProfile({
        id,
        deviceId: device.id,
        runtime: "antigravity",
        label: label.trim(),
        connectionType: "local_login",
        configScope: "device",
      });
      await onRefresh();
      setCreating(undefined);
      setSigningIn({
        deviceId: device.id,
        deviceName: device.label,
        runtime: "antigravity",
        profileId: profile.id,
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("page.requestFailed"),
      );
    } finally {
      setSaving(false);
    }
  }
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
          const signedIn = devices.filter((device) =>
            profiles.some(
              (profile) =>
                profile.deviceId === device.id &&
                profile.runtime === runtime &&
                profile.origin === "device" &&
                profile.connectionType === "local_login" &&
                profile.status === "healthy",
            ),
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
                  {devices.map((device) => {
                    const named =
                      runtime === "antigravity"
                        ? profiles.filter(
                            (profile) =>
                              profile.runtime === runtime &&
                              profile.deviceId === device.id &&
                              profile.origin === "device" &&
                              profile.connectionType === "local_login",
                          )
                        : [];
                    return (
                      <div key={device.id}>
                        {(named.length ? named : [undefined]).map((account) => (
                          <RuntimeAccountRow
                            key={account?.id ?? device.id}
                            account={account}
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
                              runtime === "antigravity" && !account
                                ? openCreate(device)
                                : setSigningIn({
                                    profileId: account?.id,
                                    deviceId: device.id,
                                    deviceName: device.label,
                                    runtime,
                                  })
                            }
                          />
                        ))}
                        {runtime === "antigravity" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="my-2"
                            disabled={device.status !== "connected"}
                            onClick={() => openCreate(device)}
                          >
                            {t("subscriptions.addProfile")}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {open ? (
                <div className="border-t border-line px-3.5 py-2">
                  <ModelGuideTags
                    targets={executionSources(profiles, serverProfiles)
                      .filter(
                        (source) =>
                          source.providerKind === "subscription" &&
                          source.runtime === runtime,
                      )
                      .flatMap((source) =>
                        sourceModels(source).map((model) => ({
                          providerKind: source.providerKind,
                          providerId: source.providerId,
                          runtime: source.runtime,
                          model,
                        })),
                      )}
                  />
                </div>
              ) : null}
            </SectionPanel>
          );
        })
      )}
      <Dialog
        title={t("subscriptions.addProfile")}
        description={creating?.device.label}
        open={!!creating}
        busy={saving}
        layout="compact"
        onClose={() => {
          if (!saving) setCreating(undefined);
        }}
      >
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label className="grid gap-2">
            {t("editor.name")}
            <TextInput
              tone="boxed"
              value={label}
              onChange={(event) => setLabel(event.currentTarget.value)}
            />
          </label>
          {error ? <Alert tone="error" title={error} /> : null}
          <Button
            type="submit"
            variant="primary"
            busy={saving}
            disabled={saving || !label.trim()}
          >
            {t("accounts.signIn")}
          </Button>
        </form>
      </Dialog>
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
