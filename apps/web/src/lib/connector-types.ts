/**
 * Kinds of external service a person connects accounts for. The Connectors
 * page has a tab per type and a workspace's Connectors tab a section per type.
 */
export const connectorTypes = ["feishu"] as const;
export type ConnectorType = (typeof connectorTypes)[number];
