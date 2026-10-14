import type {
  AgentSessionEventMetadata,
  CodexTransport,
} from "@bd777/foundry-protocol";
import { processLabels } from "@bd777/foundry-protocol";
import type { AgentProfileLocalConfig } from "../profiles.js";
import type { SessionEventEmitter } from "../session-state.js";

/**
 * Whether Codex may open the Responses WebSocket to a compatible endpoint,
 * and whether this session reports what it showed. Foundry never probes the
 * endpoint: Codex tries the WebSocket itself and falls back to HTTPS.
 *
 * - The person's override (`websocket` / `https`) is final; nothing is learned.
 * - `auto` with a current observation follows it; a WebSocket observation is
 *   still reported should Codex fall back, so a changed endpoint is noticed.
 * - `auto` without one (new profile, base URL changed, profile edited,
 *   observation expired) is a trial: WebSocket on, the outcome reported.
 * - No mode at all (a device profile, or a server that does not learn) keeps
 *   HTTPS, as before.
 */
export interface CodexTransportPlan {
  websockets: boolean;
  learn: "none" | "fallback" | "outcome";
}

export function codexTransportPlan(
  profile: Pick<
    AgentProfileLocalConfig,
    "codexTransport" | "codexTransportLearned"
  >,
): CodexTransportPlan {
  switch (profile.codexTransport) {
    case "websocket":
      return { websockets: true, learn: "none" };
    case "https":
      return { websockets: false, learn: "none" };
    case "auto": {
      const learned = profile.codexTransportLearned?.transport;
      if (learned === "https") return { websockets: false, learn: "none" };
      if (learned === "websocket")
        return { websockets: true, learn: "fallback" };
      return { websockets: true, learn: "outcome" };
    }
    default:
      return { websockets: false, learn: "none" };
  }
}

/**
 * How long Codex waits for one WebSocket handshake. Codex retries five times
 * before it falls back, so an endpoint that never answers the upgrade costs
 * about six of these once, not minutes.
 */
export const codexWebsocketConnectTimeoutMs = 5_000;

/** The item Codex adds when it gives up on the WebSocket for the turn. */
const fallbackNotice = "Falling back from WebSockets to HTTPS transport.";

/** Codex's reason for falling back, when the event is its fallback notice. */
export function codexWebsocketFallback(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  if (record.type !== "item.completed") return undefined;
  const item = record.item as Record<string, unknown> | undefined;
  if (item?.type !== "error" || typeof item.message !== "string")
    return undefined;
  if (!item.message.startsWith(fallbackNotice)) return undefined;
  return item.message.slice(fallbackNotice.length).trim();
}

/**
 * Watches one Codex turn's events for what they show about the transport
 * and reports it once on the session's transcript, where the server keeps
 * it for the profile (session event metadata `codexTransport`).
 */
export class CodexTransportLearner {
  private reported = false;

  constructor(
    private readonly plan: CodexTransportPlan,
    private readonly profile: AgentProfileLocalConfig,
    private readonly emit: SessionEventEmitter,
  ) {}

  /** Call for every stream event; turnCompleted on its turn.completed. */
  async observe(event: unknown, turnCompleted: boolean): Promise<void> {
    if (this.reported || this.plan.learn === "none") return;
    const fallback = codexWebsocketFallback(event);
    if (fallback !== undefined) {
      await this.report("https", fallback);
      return;
    }
    if (turnCompleted && this.plan.learn === "outcome")
      await this.report("websocket");
  }

  private async report(
    transport: CodexTransport,
    detail?: string,
  ): Promise<void> {
    this.reported = true;
    const profileId = this.profile.id?.trim();
    const baseUrl = this.profile.baseUrl?.trim();
    if (!profileId || !baseUrl) return;
    const metadata: AgentSessionEventMetadata = {
      codexTransport: {
        profileId,
        baseUrl,
        transport,
        ...(detail ? { detail: detail.slice(0, 500) } : {}),
      },
    };
    await this.emit(
      processLabels.notice,
      transport === "https"
        ? `This endpoint does not take the Responses WebSocket; its sessions use HTTPS from now on. ${detail ?? ""}`.trim()
        : "This endpoint takes the Responses WebSocket; its sessions keep using it.",
      "info",
      metadata,
    );
  }
}
