/**
 * The forwarder's former, Feishu-only name. It is the same module as
 * gateway-forwarder.ts (Feishu and Cloudflare share it); this alias keeps the
 * old import path and names working for callers outside the worker, such as
 * the server's feishu-cli contract test, which loads the built module by path.
 */
export {
  startGatewayForwarder as startFeishuGatewayForwarder,
  type GatewayForwarder as FeishuGatewayForwarder,
  type GatewayForwarderOptions as FeishuGatewayForwarderOptions,
} from "./gateway-forwarder.js";
