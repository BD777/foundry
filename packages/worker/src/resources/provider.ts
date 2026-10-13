// Providers run operations on a resource a session leases (operate_resource
// → resource_operate). A provider is one backend (e.g. cua-driver for
// computer_use); it opens a ProviderSession per lease, which runs typed
// actions in order and is reset and closed when the lease ends or idles.
// To add a backend: implement ResourceProvider and register it in a
// ProviderRegistry (operations.ts builds the default one).

import type {
  ResourceAction,
  ResourceActionResult,
  ResourceTypeId,
} from "@bd777/foundry-protocol";

export interface ProviderLease {
  id: string;
  generation: number;
}

export interface ProviderSession {
  /**
   * Runs one action. Failures are results (ok: false, errorCode), not
   * exceptions; an aborted signal ends the action as soon as it can.
   */
  invoke(
    action: ResourceAction,
    signal: AbortSignal,
  ): Promise<ResourceActionResult>;
  /** Releases held keys and buttons and closes popped contexts. */
  reset(): Promise<void>;
  close(): Promise<void>;
  /** False once the backend went away: a new session is opened instead. */
  readonly alive: boolean;
}

export interface ResourceProvider {
  /** The backend id, as instances list it (ResourceBackend.id). */
  id: string;
  type: ResourceTypeId;
  platforms: NodeJS.Platform[];
  /** The longest a request may take (default: maxDeadlineMs). */
  maxDeadlineMs?: number;
  /**
   * How long an idle session stays open (default: sessionIdleMs); 0 keeps
   * it until its lease ends.
   */
  idleCloseMs?: number;
  /** Throws a ProviderError when the backend cannot be started. */
  open(key: string, lease: ProviderLease): Promise<ProviderSession>;
}

/** A failure with a machine-readable code (errorCode in results). */
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ResourceProvider>();

  constructor(providers: readonly ResourceProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: ResourceProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): ResourceProvider | undefined {
    return this.providers.get(id);
  }
}
