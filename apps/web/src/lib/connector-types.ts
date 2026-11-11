/**
 * A connector's kind, as the catalog names it: one Foundry has built in
 * (feishu, cloudflare, aws) or one a connector extension on the person's
 * device provides (docs/connector-extensions.md). The Connectors page has a
 * tab per kind the catalog lists (GET /api/connectors).
 */
export type ConnectorType = string;

/** The tab the Connectors page opens on when the address names none. */
export const defaultConnectorType: ConnectorType = "feishu";

/** The Connectors page's final, non-connector entry for edge credentials. */
export const edgeAccessConnectorTab: ConnectorType = "edge-access";

const kindPattern = /^[a-z][a-z0-9-]{0,31}$/;

/** The kind an address names, if it is one at all. */
export function connectorTypeFrom(value: string | undefined): ConnectorType {
  return value && kindPattern.test(value) ? value : defaultConnectorType;
}
