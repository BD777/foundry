import type { AgentProfileProjection } from "@bd777/foundry-protocol";

/**
 * A model provider as runtime × access × launch layers
 * (docs/model-providers-design.md, "数据模型"). It is derived from a profile
 * row's connection type, origin and connector; nothing stores or sends it.
 */
export type ModelProviderAccess =
  | { kind: "official_login" }
  | {
      kind: "endpoint";
      protocol: "anthropic" | "openai";
      baseUrl?: string;
      credential: "server" | "device";
    }
  /** Endpoint and credential come entirely from a launch layer. */
  | { kind: "environment" };

export type LaunchLayerEffect =
  "endpoint" | "credential" | "proxy" | "certificates" | "telemetry";

export interface LaunchLayer {
  source:
    | { kind: "connector"; connectorKind: string; label: string }
    | { kind: "device_config" };
  provides: LaunchLayerEffect[];
}

export interface ModelProviderShape {
  runtime: AgentProfileProjection["runtime"];
  access: ModelProviderAccess;
  /** In launch order; one layer at most until layering is supported. */
  layers: LaunchLayer[];
}

/** The shape of a profile row, or undefined for one that is no provider. */
export function modelProviderShape(
  row: Pick<
    AgentProfileProjection,
    "runtime" | "connectionType" | "origin" | "baseUrl" | "connector"
  >,
): ModelProviderShape | undefined {
  switch (row.connectionType) {
    case "local_login":
      return {
        runtime: row.runtime,
        access: { kind: "official_login" },
        layers: [],
      };
    case "anthropic_compatible":
    case "openai_compatible":
      return {
        runtime: row.runtime,
        access: {
          kind: "endpoint",
          protocol:
            row.connectionType === "anthropic_compatible"
              ? "anthropic"
              : "openai",
          ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
          credential: row.origin === "server" ? "server" : "device",
        },
        layers: [],
      };
    case "external":
      return {
        runtime: row.runtime,
        access: { kind: "environment" },
        layers: [
          {
            source: row.connector
              ? {
                  kind: "connector",
                  connectorKind: row.connector.kind,
                  label: row.connector.label,
                }
              : { kind: "device_config" },
            provides: ["endpoint", "credential"],
          },
        ],
      };
    default:
      return undefined;
  }
}
