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
  /** Last time the device reported this port listening (RFC 3339). */
  lastSeenAt?: string;
}
export interface ServiceTunnelView extends ServiceTunnel {
  deviceLabel: string;
  targetWorkspaceName: string;
  url: string;
  status:
    | "ready"
    | "disabled"
    | "preview_domain_unconfigured"
    | "preview_unrouted"
    | "device_offline"
    | "worker_update_required"
    | "not_listening";
  canManage: boolean;
}
/** A listener started from this workspace's folder with no mapping yet. Only
 * the device owner, who may publish it, receives these. */
export interface DetectedService {
  port: number;
  process?: string;
}
export interface ServiceTunnelList {
  items: ServiceTunnelView[];
  detected?: DetectedService[];
  canManage: boolean;
  configured: boolean;
  /** Service hosts were verified to reach this server through the public edge. */
  routed: boolean;
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
