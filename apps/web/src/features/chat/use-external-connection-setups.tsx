import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AgentProfileProjection,
  AgentProjection,
  ExternalConnectionOffer,
} from "@bd777/foundry-protocol";
import { listExternalConnectionOffers } from "../../api";
import { RuntimeMark } from "../../components/ui/runtime-mark";
import type { SelectMenuAction } from "../../components/ui/select-menu";
import { ExternalConnectionSetupDialog } from "./external-connection-setup-dialog";
import { pickerSetupRows } from "./external-connection-setup-model";

/**
 * External connections the person can set up on the workspace's device
 * (DEV-086): one picker row each, which opens the setup panel. Offers come
 * from the server for the device's owner only; anyone else gets none.
 */
export function useExternalConnectionSetups({
  active,
  agents,
  deviceId,
  profiles,
  onSelectAgent,
}: {
  active: boolean;
  agents: readonly AgentProjection[];
  deviceId?: string;
  profiles: readonly AgentProfileProjection[];
  onSelectAgent: (agentId: string) => void;
}): { actions: SelectMenuAction[]; dialog: ReactNode } {
  const [offers, setOffers] = useState<ExternalConnectionOffer[]>([]);
  const [open, setOpen] = useState("");
  // Read again when an external connection changes anywhere, or a panel
  // closes; not on every projection update.
  const externalKey = useMemo(
    () =>
      profiles
        .filter((profile) => profile.connectionType === "external")
        .map(
          (profile) =>
            `${profile.deviceId}/${profile.id}/${profile.status}/${profile.check?.status ?? ""}/${profile.externalSetup?.command ?? ""}`,
        )
        .sort()
        .join("|"),
    [profiles],
  );
  useEffect(() => {
    if (!active || !deviceId || open) return;
    let current = true;
    listExternalConnectionOffers(deviceId).then(
      (answer) => {
        if (current) setOffers(answer.offers);
      },
      () => {
        if (current) setOffers([]);
      },
    );
    return () => {
      current = false;
    };
  }, [active, deviceId, externalKey, open]);

  const actions = useMemo<SelectMenuAction[]>(
    () =>
      deviceId
        ? pickerSetupRows(offers, agents, deviceId).map((row) => ({
            key: `connection-setup:${row.profileId}`,
            label: row.label,
            detail: row.detail,
            actionLabel: row.actionLabel,
            prefix: <RuntimeMark runtime="claude" size="sm" />,
            onSelect: () => setOpen(row.profileId),
          }))
        : [],
    [agents, deviceId, offers],
  );

  const dialog =
    open && deviceId ? (
      <ExternalConnectionSetupDialog
        agents={agents}
        deviceId={deviceId}
        profileId={open}
        onClose={() => setOpen("")}
        onSelectAgent={onSelectAgent}
      />
    ) : null;
  return { actions, dialog };
}
