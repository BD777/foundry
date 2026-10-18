import { createContext, useContext } from "react";

export const FoundryThemeContext = createContext<"light" | "dark">("light");

export function useFoundryTheme() {
  return useContext(FoundryThemeContext);
}
