import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  DiagramPlugin,
  MermaidErrorComponentProps,
  MermaidOptions,
} from "streamdown";
import { Alert } from "../ui/alert";
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
    <Alert
      actions={
        <Button onClick={retry} size="sm" variant="secondary">
          {t("diagram.retry")}
        </Button>
      }
      size="compact"
      title={t("diagram.error")}
      tone="warning"
    >
      <pre className="max-h-80 overflow-auto whitespace-pre">
        <code>{chart}</code>
      </pre>
    </Alert>
  );
}

function mermaidConfig(theme: "light" | "dark"): MermaidOptions["config"] {
  return {
    theme: theme === "dark" ? "dark" : "default",
    securityLevel: "strict",
    // SVG text keeps exports portable, including Chinese labels and <br/>.
    htmlLabels: false,
    fontFamily: "sans-serif",
  };
}

export function useMarkdownMermaid(): MermaidOptions {
  const theme = useFoundryTheme();
  return useMemo(
    () => ({ config: mermaidConfig(theme), errorComponent: MermaidError }),
    [theme],
  );
}

/**
 * A diagram Foundry draws itself (not one in an answer), as SVG markup in
 * the same look as answers' diagrams. `id` must be unique on the page.
 */
export async function renderMermaidSvg(
  id: string,
  source: string,
  theme: "light" | "dark",
): Promise<string> {
  const { svg } = await mermaid
    .getMermaid(mermaidConfig(theme))
    .render(id, source);
  return svg;
}
