import { UserRound, Users } from "lucide-react";
import type { ReactNode } from "react";
import type { AccountRole } from "../api-types";
import type { SidebarNavSection } from "../components/ui/app-shell";
import {
  AccountFeature,
  MembersFeature,
  type AccountFeatureEvent,
} from "../features/accounts";
import { useAccountSession } from "./accounts-gate";
import type { SidebarView } from "./navigation";

/** Members is admin-only; Account is for every signed-in user. */
export function withAccountNav(
  sections: Array<SidebarNavSection<SidebarView>>,
  role: AccountRole | undefined,
): Array<SidebarNavSection<SidebarView>> {
  if (!role) return sections;
  const accountItems: SidebarNavSection<SidebarView>["items"] = [
    ...(role === "admin"
      ? [{ id: "members" as const, label: "Members", icon: Users }]
      : []),
    { id: "account", label: "Account", icon: UserRound },
  ];
  return sections.map((section) =>
    section.label === "Manage"
      ? { ...section, items: [...section.items, ...accountItems] }
      : section,
  );
}

export interface AccountViewProps {
  view: "account" | "members";
  /** Rendered when the route is not available to this session. */
  fallback: ReactNode;
  onNotice: (message: string) => void;
}

export function AccountView({ view, fallback, onNotice }: AccountViewProps) {
  const session = useAccountSession();
  const user = session.user;
  if (!user || (view === "members" && user.role !== "admin")) {
    return <>{fallback}</>;
  }
  if (view === "members") {
    return <MembersFeature currentUserId={user.id} />;
  }

  async function handleEvent(event: AccountFeatureEvent): Promise<void> {
    if (event.type === "account.updated") {
      session.replaceUser(event.user);
      return;
    }
    try {
      await session.signOut();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Sign out failed");
    }
  }

  return (
    <AccountFeature onEvent={(event) => void handleEvent(event)} user={user} />
  );
}
