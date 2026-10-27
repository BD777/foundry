import type { ToastTone } from "../components/ui/toast";
import { ConnectorsFeature } from "../features/external-accounts";
import { useAccountSession } from "./accounts-gate";
import type { ConnectorType } from "../lib/connector-types";

export interface ConnectorsViewProps {
  tab: ConnectorType;
  onTabChange: (tab: ConnectorType) => void;
  onNotice: (message: string, tone?: ToastTone) => void;
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
