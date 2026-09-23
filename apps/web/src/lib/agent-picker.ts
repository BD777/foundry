import type {
  AgentProfileProjection,
  AgentProjection,
  ProviderStatus,
} from "@foundry/protocol";
import { runtimeMeta } from "../components/ui/runtime-mark";

/**
 * A promoted connection exists as two agent rows with a real linkage: the
 * machine's own configuration and the server profile it was promoted into,
 * named by the device profile's `promotedProfileId`. People must see it as
 * one connection, never as two same-named choices — but the two identities
 * can diverge (different knobs/credentials), so collapsing is presentation
 * only: which id a session actually runs is never rewritten.
 */
interface PromotedLinks {
  /** Legacy device agent id -> its promoted server agent id. */
  legacyToServer: Map<string, string>;
  /**
   * All legacy ids linked to one server agent id. A device profile can point
   * at a server id several devices/workspaces project; per workspace this is
   * queried for one selected legacy id, so a one-to-many list is safe here.
   */
  serverToLegacies: Map<string, string[]>;
}

/**
 * Build the promoted pairs for one agent list. A pair forms only when every
 * link is independently provable:
 * - the agent has a device-origin profile carrying an explicit
 *   `promotedProfileId` pointer (never inferred from label/baseURL);
 * - a server-origin projection row proves that profile id exists on this
 *   device;
 * - a server agent row exists in the same workspace AND same provider.
 *
 * Health never gates the collapse. When the promoted server agent is
 * unavailable the pair still renders once, represented by that row with its
 * honest unavailable reason — otherwise a status flip would re-introduce a
 * second row. The legacy row only stays visible when no server agent projects
 * the profile at all.
 */
function promotedLinks(
  agents: AgentProjection[],
  profiles: AgentProfileProjection[],
): PromotedLinks {
  const legacyToServer = new Map<string, string>();
  const serverToLegacies = new Map<string, string[]>();
  for (const agent of agents) {
    if (!agent.profileId || !agent.deviceId) {
      continue;
    }
    const deviceProfile = profiles.find(
      (profile) =>
        profile.origin === "device" &&
        profile.id === agent.profileId &&
        profile.deviceId === agent.deviceId,
    );
    const promotedProfileId = deviceProfile?.promotedProfileId;
    if (!promotedProfileId) {
      continue;
    }
    // A server-origin projection row proves the promoted id is a real server
    // profile on this device, not a stale pointer the client could invent.
    const hasServerProfile = profiles.some(
      (profile) =>
        profile.origin === "server" &&
        profile.deviceId === agent.deviceId &&
        profile.id === promotedProfileId,
    );
    if (!hasServerProfile) {
      continue;
    }
    const serverAgent = agents.find(
      (candidate) =>
        candidate.deviceId === agent.deviceId &&
        candidate.workspaceId === agent.workspaceId &&
        candidate.provider === agent.provider &&
        candidate.profileId === promotedProfileId,
    );
    if (!serverAgent) {
      continue;
    }
    legacyToServer.set(agent.id, serverAgent.id);
    const list = serverToLegacies.get(serverAgent.id) ?? [];
    list.push(agent.id);
    serverToLegacies.set(serverAgent.id, list);
  }
  return { legacyToServer, serverToLegacies };
}

/** Legacy device agent ids linked to an actual same-workspace server agent. */
export function promotedLegacyAgentIds(
  agents: AgentProjection[],
  profiles: AgentProfileProjection[],
): Set<string> {
  return new Set(promotedLinks(agents, profiles).legacyToServer.keys());
}

/**
 * The agents a picker shows, with each promoted pair collapsed to one row.
 * `selectedAgentId` decides which identity represents the pair:
 * - an existing chat still running the legacy device config keeps that row
 *   (value/checked identity unchanged, so execution is never switched);
 * - everywhere else, including fresh chats, the server definition represents
 *   the connection and the legacy alias is hidden.
 *
 * The server row hides only when the *selected* legacy id is one of its
 * aliases: server-to-legacy is a list, never one value, so several legacy
 * rows cannot overwrite each other.
 */
export function canonicalPickerAgents(
  agents: AgentProjection[],
  profiles: AgentProfileProjection[],
  selectedAgentId?: string,
): AgentProjection[] {
  const { legacyToServer, serverToLegacies } = promotedLinks(agents, profiles);
  return agents.filter((agent) => {
    if (legacyToServer.has(agent.id)) {
      return agent.id === selectedAgentId;
    }
    const aliases = serverToLegacies.get(agent.id);
    if (aliases) {
      return selectedAgentId !== undefined
        ? !aliases.includes(selectedAgentId)
        : true;
    }
    return true;
  });
}

export interface PickerAgentMeta {
  /** Short, human reason for an unavailable row, shown in the open menu. */
  detail?: string;
  /** Full technical text (paths included), kept for the native tooltip. */
  title?: string;
}

/**
 * The raw status detail can carry file paths and long backend sentences. The
 * picker needs one short, readable line; the full text stays reachable via the
 * row's native title and on the device management page.
 */
export function shortUnavailableReason(
  status: ProviderStatus,
  statusDetail?: string,
): string {
  const text = statusDetail ?? "";
  if (status === "unavailable") {
    if (/offline/i.test(text)) {
      return "Device is offline.";
    }
    return "Unavailable on this device.";
  }
  if (status === "missing_auth") {
    if (/not enabled|no device|unbound/i.test(text)) {
      return "Not enabled on a device yet.";
    }
    if (/credential|api key|key is stored/i.test(text)) {
      return "No credential stored for this profile.";
    }
    if (/login|sign|\.codex|claude/i.test(text)) {
      return "Worker configuration is not signed in.";
    }
    return "No sign-in or credential on this device.";
  }
  return "Unavailable.";
}

/**
 * The only sub-line a picker row carries is why it is unavailable. Healthy
 * rows expose no local/server source distinction: a promoted connection reads
 * as one connection regardless of which identity currently represents it.
 */
export function pickerAgentMeta(agent: AgentProjection): PickerAgentMeta {
  if (agent.status !== "healthy") {
    return {
      detail: shortUnavailableReason(agent.status, agent.statusDetail),
      title: agent.statusDetail,
    };
  }
  return {};
}

/** Current label rule shared by the chat and issue pickers. */
export function pickerAgentLabel(agent: AgentProjection): string {
  return agent.connectionType === "local_login"
    ? `${runtimeMeta(agent.provider).label} · Device account`
    : (agent.profileLabel ?? runtimeMeta(agent.provider).label);
}

export interface PickerAgentOption {
  disabled?: boolean;
  detail?: string;
  deviceId?: string;
  label: string;
  runtime: AgentProjection["provider"];
  title?: string;
  value: string;
}

/**
 * Project the canonical agent rows into composer SelectMenu options. The chat
 * picker passes the current selection so a promoted pair keeps presenting its
 * legacy identity for an existing chat; the issue picker passes nothing and
 * always gets the server representative.
 */
export function buildPickerAgentOptions(
  agents: AgentProjection[],
  profiles: AgentProfileProjection[],
  selectedAgentId?: string,
): PickerAgentOption[] {
  return canonicalPickerAgents(agents, profiles, selectedAgentId).map(
    (agent) => {
      const meta = pickerAgentMeta(agent);
      return {
        detail: meta.detail,
        deviceId: agent.deviceId,
        disabled: agent.status !== "healthy",
        label: pickerAgentLabel(agent),
        runtime: agent.provider,
        title: meta.title,
        value: agent.id,
      };
    },
  );
}

/** Device owning the first unavailable row, for the picker's manage entry. */
export function firstDisabledDeviceId(
  options: PickerAgentOption[],
): string | undefined {
  return options.find((option) => option.disabled)?.deviceId;
}

/**
 * The profile that drives the model controls (configured models, native
 * metadata discovery, default model/knobs). Normally that is the agent's own
 * profile, server origin preferred.
 *
 * A promoted legacy device agent still executes under its machine config
 * (identity is never switched for an existing chat), but that device config's
 * credential moved into the sealed server profile and its own metadata call
 * is dead (401). The model controls therefore follow the explicit
 * `promotedProfileId` pointer to the server definition the picker shows as
 * the same connection. No pointer, or no live server profile on this device:
 * the device profile is used unchanged.
 */
export function modelControlProfile(
  profiles: AgentProfileProjection[],
  agent: AgentProjection | undefined,
): AgentProfileProjection | undefined {
  if (!agent?.profileId || !agent.deviceId) {
    return undefined;
  }
  const matching = profiles.filter(
    (profile) =>
      profile.id === agent.profileId && profile.deviceId === agent.deviceId,
  );
  const direct =
    matching.find((profile) => profile.origin === "server") ?? matching[0];
  if (!direct || direct.origin === "server") {
    return direct;
  }
  const deviceRow = matching.find((profile) => profile.origin === "device");
  const promotedId = deviceRow?.promotedProfileId;
  if (!promotedId) {
    return direct;
  }
  const promoted = profiles.find(
    (profile) =>
      profile.origin === "server" &&
      profile.deviceId === agent.deviceId &&
      profile.id === promotedId,
  );
  return promoted ?? direct;
}
