/**
 * Connector kinds Foundry has built in (apps/server/internal/connectors/
 * catalog.json); an extension may not provide one. The server refuses such
 * a connector too, this only says so at install time.
 */
export const builtinConnectorKinds = ["feishu", "cloudflare", "aws", "github"];
