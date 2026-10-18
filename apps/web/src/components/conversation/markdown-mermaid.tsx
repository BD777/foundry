import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  DiagramPlugin,
  MermaidErrorComponentProps,
  MermaidOptions,
} from "streamdown";
import { Button } from "../ui/button";
import { useFoundryTheme } from "../ui/theme-context";

// Keep Mermaid's diagram engines out of the initial chat bundle. Streamdown
// owns the UI; its official plugin loads only when a visible diagram renders.
const mermaid: DiagramPlugin = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid(config) {
    let currentConfig = config;
    return {
      initialize(nextConfig) {
        currentConfig = nextConfig;
      },
      async render(id, source) {
        const module = await import("@streamdown/mermaid");
        const plugin: DiagramPlugin = module.mermaid;
        return plugin.getMermaid(currentConfig).render(id, source);
      },
    };
  },
};

export const markdownPlugins = { mermaid };

function MermaidError({ chart, retry }: MermaidErrorComponentProps) {
  const { t } = useTranslation("conversation");
  return (
    <div className="fdy-mermaid-error" role="status">
      <p>{t("diagram.error")}</p>
      <pre>
        <code>{chart}</code>
      </pre>
      <Button onClick={retry} size="sm" variant="secondary">
        {t("diagram.retry")}
      </Button>
    </div>
  );
}

export function useMarkdownMermaid(): MermaidOptions {
  const theme = useFoundryTheme();
  return useMemo(
    () => ({
      config: {
        theme: theme === "dark" ? "dark" : "default",
        securityLevel: "strict",
        // SVG text keeps exports portable, including Chinese labels and <br/>.
        htmlLabels: false,
        fontFamily: "sans-serif",
      },
      errorComponent: MermaidError,
    }),
    [theme],
  );
}
