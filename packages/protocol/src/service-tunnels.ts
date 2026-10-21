/** Explicit web endpoint in the existing Workspace Services surface. */
export interface ServiceTunnel {
  hostLabel?: string;
  id: string;
  workspaceId: string;
  targetWorkspaceId: string;
  deviceId: string;
  ownerUserId: string;
  workId?: string;
  name: string;
  port: number;
  protocol: "http" | "https";
  visibility: "private" | "workspace";
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ServiceTunnelView extends ServiceTunnel {
  deviceLabel: string;
  targetWorkspaceName: string;
  url: string;
  status:
    | "ready"
    | "disabled"
    | "preview_domain_unconfigured"
    | "device_offline"
    | "worker_update_required";
  canManage: boolean;
}
export interface ServiceTunnelList {
  items: ServiceTunnelView[];
  canManage: boolean;
  configured: boolean;
  targets: import("./workspace.js").WorkspaceProjection[];
}
export interface ServiceTunnelInput {
  registrationKey?: string;
  targetWorkspaceId?: string;
  name: string;
  port: number;
  protocol: "http" | "https";
  visibility: "private" | "workspace";
  enabled: boolean;
  workId?: string;
  expectedRevision?: number;
}
