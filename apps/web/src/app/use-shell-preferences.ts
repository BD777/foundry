import { useEffect, useState } from "react";
import type { FoundryThemeMode } from "../components/ui/app-shell";
import {
  persistSidebarCollapsed,
  persistThemeMode,
  storedSidebarCollapsed,
  storedThemeMode,
} from "./navigation";

/** The sidebar's collapsed state and the theme, kept across visits. */
export function useShellPreferences() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    storedSidebarCollapsed,
  );
  const [themeMode, setThemeMode] = useState<FoundryThemeMode>(storedThemeMode);

  useEffect(() => {
    persistSidebarCollapsed(sidebarCollapsed);
  }, [sidebarCollapsed]);

  useEffect(() => {
    persistThemeMode(themeMode);
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  return {
    sidebarCollapsed,
    themeMode,
    toggleSidebarCollapsed: () =>
      setSidebarCollapsed((collapsed) => !collapsed),
    toggleThemeMode: () =>
      setThemeMode((current) => (current === "dark" ? "light" : "dark")),
  };
}

export type ShellPreferences = ReturnType<typeof useShellPreferences>;
