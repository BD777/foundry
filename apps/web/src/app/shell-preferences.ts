import { noWorkspaceSelected } from "../api";
import type { FoundryThemeMode } from "../components/ui/app-shell";
import type { InterfaceMode } from "../lib/assistant-settings-sections";
import { workspaceIdFromLocation } from "../lib/in-app-navigation";

const activeWorkspaceStorageKey = "foundry.activeWorkspaceId";
const activeAssistantStoragePrefix = "foundry.activeAssistantId.";
const themeStorageKey = "foundry.themeMode";
const interfaceModeStorageKey = "foundry.interfaceMode";
const sidebarCollapsedStorageKey = "foundry.sidebarCollapsed";

function storedWorkspaceId(): string {
  try {
    return window.localStorage.getItem(activeWorkspaceStorageKey)?.trim() ?? "";
  } catch {
    return "";
  }
}

function assistantStorageKey(userId: string): string {
  return userId ? `${activeAssistantStoragePrefix}${userId}` : "";
}

/** The assistant this person opened last in this browser. */
export function storedAssistantId(userId: string): string {
  const key = assistantStorageKey(userId);
  if (!key) return "";
  try {
    return window.localStorage.getItem(key)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function persistAssistantId(userId: string, assistantId: string): void {
  const key = assistantStorageKey(userId);
  if (!key || !assistantId) return;
  try {
    window.localStorage.setItem(key, assistantId);
  } catch {
    return;
  }
}

export function clearStoredAssistantId(userId: string): void {
  const key = assistantStorageKey(userId);
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
}

export function initialWorkspaceId(fallback: string): string {
  const stored = storedWorkspaceId();
  return (
    workspaceIdFromLocation() ||
    (stored === noWorkspaceSelected ? "" : stored) ||
    fallback
  );
}

/**
 * The workspace a data read asks for: the one shown; with none shown, none
 * when the person has no workspace selected (it stays so across reloads),
 * else nothing, and the server shows the first there is (a first visit, the
 * first folder added).
 */
export function workspaceToRead(activeWorkspaceId: string): string {
  if (activeWorkspaceId) return activeWorkspaceId;
  return storedWorkspaceId() === noWorkspaceSelected ? noWorkspaceSelected : "";
}

/**
 * Remembers that no workspace is selected (the current one was removed):
 * reads, here and after a reload, show none until Switch picks one.
 */
export function clearWorkspaceSelection(): void {
  try {
    window.localStorage.setItem(activeWorkspaceStorageKey, noWorkspaceSelected);
  } catch {
    return;
  }
}

/**
 * Remembers the workspace a read showed. A read that showed none while
 * workspaces exist (`workspaceCount`, when it read the list) leaves none
 * selected; with none left, the next folder added is shown again.
 */
export function persistWorkspaceId(
  workspaceId: string,
  workspaceCount?: number,
): void {
  try {
    if (workspaceId) {
      window.localStorage.setItem(activeWorkspaceStorageKey, workspaceId);
    } else if (workspaceCount === undefined) {
      return;
    } else if (workspaceCount > 0) {
      window.localStorage.setItem(
        activeWorkspaceStorageKey,
        noWorkspaceSelected,
      );
    } else {
      window.localStorage.removeItem(activeWorkspaceStorageKey);
    }
  } catch {
    return;
  }
}

/**
 * The interface this browser chose before the choice moved to the
 * assistant's settings (simpleInterface); read once to carry it over.
 */
export function storedInterfaceMode(): InterfaceMode | undefined {
  try {
    const value = window.localStorage.getItem(interfaceModeStorageKey);
    return value === "simple" || value === "full" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function forgetStoredInterfaceMode(): void {
  try {
    window.localStorage.removeItem(interfaceModeStorageKey);
  } catch {
    return;
  }
}

export function storedThemeMode(): FoundryThemeMode {
  try {
    return window.localStorage.getItem(themeStorageKey) === "dark"
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export function persistThemeMode(themeMode: FoundryThemeMode): void {
  try {
    window.localStorage.setItem(themeStorageKey, themeMode);
  } catch {
    return;
  }
}

export function storedSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(sidebarCollapsedStorageKey) === "true";
  } catch {
    return false;
  }
}

export function persistSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(sidebarCollapsedStorageKey, String(collapsed));
  } catch {
    return;
  }
}
