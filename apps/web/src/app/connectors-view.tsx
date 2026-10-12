import { ConnectorsFeature } from "../features/external-accounts";
import { useAccountSession } from "./accounts-gate";
import type { ConnectorTab } from "./navigation";

export interface ConnectorsViewProps {
  tab: ConnectorTab;
  onTabChange: (tab: ConnectorTab) => void;
  onNotice: (message: string) => void;
}

/** The Connectors page for the signed-in person. */
export function ConnectorsView(props: ConnectorsViewProps) {
  const user = useAccountSession().user;
  return (
    <ConnectorsFeature
      currentUserId={user?.id ?? ""}
      isAdmin={user?.role === "admin"}
      {...props}
    />
  );
}
