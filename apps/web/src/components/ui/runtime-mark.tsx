import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export type RuntimeKind = "claude" | "codex" | "mock";

export function runtimeMeta(runtime: RuntimeKind): {
  label: string;
  mark: string;
} {
  const meta: Record<RuntimeKind, { label: string; mark: string }> = {
    claude: { label: "Claude", mark: "C" },
    codex: { label: "Codex", mark: "Cx" },
    mock: { label: "Mock", mark: "M" },
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
