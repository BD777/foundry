import type {
  ServiceTunnel,
  ServiceTunnelInput,
  ServiceTunnelList,
} from "@bd777/foundry-protocol";
import { request } from "./http";
const path = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/service-tunnels`;
export function listServiceTunnels(
  workspaceId: string,
): Promise<ServiceTunnelList> {
  return request("GET", path(workspaceId));
}
export function saveServiceTunnel(
  workspaceId: string,
  input: ServiceTunnelInput,
  id?: string,
): Promise<ServiceTunnel> {
  return request(
    id ? "PUT" : "POST",
    path(workspaceId) + (id ? `/${encodeURIComponent(id)}` : ""),
    { body: input },
  );
}
/** Closes web access for good; the application process keeps running. */
export function removeServiceTunnel(
  workspaceId: string,
  id: string,
): Promise<void> {
  return request("DELETE", path(workspaceId) + `/${encodeURIComponent(id)}`);
}
