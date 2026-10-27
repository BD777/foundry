import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { FieldHint } from "./field";
import { Popover } from "./popover";

/** Optional help behind a visible, keyboard/touch accessible info control. */
export function FieldHelp({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Popover
      label={label}
      trigger={
        <Button variant="ghost" size="icon" aria-label={label}>
          <Info size={15} aria-hidden="true" />
        </Button>
      }
    >
      <FieldHint>{children}</FieldHint>
    </Popover>
  );
}
