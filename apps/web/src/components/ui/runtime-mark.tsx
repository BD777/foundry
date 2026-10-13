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

export const runtimeMarkVariants = cva("fdy-runtime-mark", {
  variants: {
    runtime: {
      claude: "fdy-runtime-mark-claude",
      codex: "fdy-runtime-mark-codex",
      mock: "fdy-runtime-mark-mock",
    },
    size: {
      chat: "fdy-runtime-mark-chat",
      lg: "fdy-runtime-mark-lg",
      sm: "fdy-runtime-mark-sm",
      md: "fdy-runtime-mark-md",
    },
  },
  defaultVariants: {
    size: "md",
  },
});

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
