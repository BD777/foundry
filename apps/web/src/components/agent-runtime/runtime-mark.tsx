import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export type RuntimeKind = "claude" | "codex" | "mock";

interface RuntimeMeta {
  label: string;
  mark: string;
  /** The agent product's own name, e.g. "Claude Code". */
  productName: string;
}

export function runtimeMeta(runtime: RuntimeKind): RuntimeMeta {
  const meta: Record<RuntimeKind, RuntimeMeta> = {
    // i18n-ignore: runtime brand name
    claude: { label: "Claude", mark: "C", productName: "Claude Code" },
    // i18n-ignore: runtime brand name
    codex: { label: "Codex", mark: "Cx", productName: "Codex" },
    // i18n-ignore: runtime brand name
    mock: { label: "Mock", mark: "M", productName: "Mock" },
  };

  return meta[runtime];
}

/*
 * The runtime's mark: its initials on the product's own colour. Provider
 * identities keep fixed colours (the --fdy-brand-* tokens) in both themes.
 */
export const runtimeMarkVariants = cva(
  "fdy-runtime-mark inline-flex items-center justify-center rounded-xs text-2xs leading-none font-bold text-(--fdy-brand-on-color)",
  {
    variants: {
      runtime: {
        claude:
          "bg-linear-150/srgb from-(--fdy-brand-claude-start) to-(--fdy-brand-claude-end)",
        codex:
          "bg-linear-150/srgb from-(--fdy-brand-codex-start) to-(--fdy-brand-codex-end)",
        mock: "bg-(--fdy-media-surface)",
      },
      size: {
        chat: "size-5.5 rounded-sm",
        lg: "size-8 rounded-md text-md leading-none",
        sm: "size-3.5",
        md: "size-4.75 min-w-4.75",
      },
    },
    compoundVariants: [
      { runtime: "codex", size: "lg", className: "text-sm leading-none" },
    ],
    defaultVariants: {
      size: "md",
    },
  },
);

export interface RuntimeMarkProps
  extends
    HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof runtimeMarkVariants> {
  runtime: RuntimeKind;
}

export function RuntimeMark({
  className,
  runtime,
  size,
  ...props
}: RuntimeMarkProps) {
  return (
    <span
      className={cn(runtimeMarkVariants({ runtime, size }), className)}
      {...props}
    >
      {runtimeMeta(runtime).mark}
    </span>
  );
}
