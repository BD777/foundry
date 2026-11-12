import {
  ChartNoAxesCombined,
  Columns2,
  Inbox,
  LayoutDashboard,
  KeyRound,
  Library,
  MessageSquareText,
  Monitor,
  Plug,
  Server,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import type { SidebarNavSection } from "../components/ui/app-shell";
import { issuesEnabled } from "../lib/feature-flags";
import type { NavView, SidebarView } from "../lib/routes";
import type { shell } from "../i18n/locales/en/shell";

/** A sidebar label: a key of the shell namespace's `nav`. */
export type NavLabel = keyof typeof shell.nav;

export type DevicePairingMode = "auto" | "offline" | "online";

export function initialDevicePairingMode(): DevicePairingMode {
  const value = new URLSearchParams(window.location.search).get("device");
  return value === "offline" || value === "online" ? value : "auto";
}

/** Pages that scroll as a whole; the others (chats, Issues) scroll their parts. */
const pageViews = new Set<string>([
  "assistants",
  "assistantSettings",
  "pending",
  "account",
  "members",
  "assets",
  "skills",
  "foundrySkill",
  "settings",
  "channels",
  "sharing",
  "workspace",
  "devices",
  "locations",
  "profiles",
  "connectors",
  "usage",
  "resources",
  "workspaceConnectors",
  "library",
]);

/** Views that show the selected workspace; they need one to show anything. */
export const workspaceScopedViews = new Set<NavView>([
  "workspace",
  "chats",
  "issues",
  "issue",
  "assets",
  "skills",
  "settings",
  "channels",
  "workspaceConnectors",
  "sharing",
]);

export function scrollModeForView(view: string): "page" | "contained" {
  return pageViews.has(view) ? "page" : "contained";
}

/** Views whose primary controls (a conversation's composer) sit at the bottom. */
const bottomComposerViews = new Set<string>(["chats", "assistant", "issue"]);

/** Where toasts float in a view: away from its primary controls. */
export function toastPlacementForView(view: string): "top" | "bottom" {
  return bottomComposerViews.has(view) ? "top" : "bottom";
}

const assistantNavSection: SidebarNavSection<SidebarView> = {
  id: "assistant",
  label: "assistantSection",
  items: [
    { id: "assistant", label: "assistant", icon: Sparkles },
    { id: "pending", label: "pending", icon: Inbox },
    {
      id: "assistantSettings",
      label: "assistantSettings",
      icon: SlidersHorizontal,
    },
  ],
};

/**
 * The sidebar: the selected workspace, then the global assistant and
 * management. Labels are keys of the shell namespace's `nav`; the shell
 * translates them.
 */
export const navSections: Array<SidebarNavSection<SidebarView>> = [
  {
    id: "workspace",
    label: "workspace",
    items: [
      { id: "workspace", label: "overview", icon: LayoutDashboard },
      ...(issuesEnabled
        ? [{ id: "issues" as const, label: "issues" as const, icon: Columns2 }]
        : []),
      { id: "chats", label: "chats", icon: MessageSquareText },
    ],
  },
  { ...assistantNavSection, dividerBefore: true },
  {
    id: "manage",
    label: "manage",
    items: [
      { id: "devices", label: "devices", icon: Monitor },
      { id: "resources", label: "resources", icon: Server },
      { id: "library", label: "library", icon: Library },
      { id: "profiles", label: "profiles", icon: KeyRound },
      { id: "connectors", label: "connectors", icon: Plug },
      { id: "usage", label: "usage", icon: ChartNoAxesCombined },
    ],
  },
];

/**
 * The simple interface's sidebar: the assistant and its settings; the
 * account entries join the empty "manage" section (withAccountNav).
 */
export const simpleNavSections: Array<SidebarNavSection<SidebarView>> = [
  assistantNavSection,
  { id: "manage", label: "manage", items: [] },
];
