/**
 * Kinds of external service a person connects for their sessions. The
 * Connectors page has a tab per type and a workspace's Connectors tab a
 * section per type. A server-held type keeps its logins on the server; a
 * device-held one leaves them on each device (docs/connectors.md).
 */
export const connectorTypes = ["feishu", "bytedcli"] as const;
export type ConnectorType = (typeof connectorTypes)[number];

export const connectorHolding: Record<
  ConnectorType,
  "server_held" | "device_held"
> = {
  feishu: "server_held",
  bytedcli: "device_held",
};
