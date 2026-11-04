import {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Check } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { Button, type ButtonProps } from "./button";
import {
  DropdownMenuEntry,
  DropdownMenuLabel,
  DropdownMenuSurface,
} from "./row-menu-parts";

export interface ChoiceMenuOption<Value extends string> {
  value: Value;
  label: string;
  /** What choosing it does, under the label. */
  reason?: string;
  /** Its keyboard shortcut, shown at the end of the row (e.g. "Ctrl+Enter"). */
  shortcut?: string;
  disabled?: boolean;
}

/**
 * A button that opens a short list of choices: each row names what it does
 * and its shortcut, and the current one carries a check. Used for a split
 * button's chevron and for a row's mode switch.
 */
export function ChoiceMenu<Value extends string>({
  label,
  options,
  value,
  onChoose,
  children,
  disabled,
  align = "end",
  side = "top",
  triggerClassName,
  triggerSize = "icon",
  triggerVariant = "ghost",
  triggerRef,
  heading,
}: {
  /** The trigger's accessible name. */
  label: string;
  options: ChoiceMenuOption<Value>[];
  /** The current choice, if any: marked with a check. */
  value?: Value;
  onChoose: (value: Value) => void;
  /** The trigger's content (an icon, or a label and a chevron). */
  children: ReactNode;
  disabled?: boolean;
  align?: "start" | "end";
  side?: "top" | "bottom";
  triggerClassName?: string;
  triggerSize?: ButtonProps["size"];
  triggerVariant?: ButtonProps["variant"];
  triggerRef?: Ref<HTMLButtonElement>;
  /** A short line above the choices. */
  heading?: ReactNode;
}) {
  const marks = value !== undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          aria-label={label}
          className={triggerClassName}
          disabled={disabled}
          ref={triggerRef}
          size={triggerSize}
          variant={triggerVariant}
        >
          {children}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSurface align={align} side={side}>
          {heading ? <DropdownMenuLabel>{heading}</DropdownMenuLabel> : null}
          {options.map((option) => (
            <DropdownMenuEntry
              disabled={option.disabled}
              icon={
                marks && option.value === value ? (
                  <Check size={14} />
                ) : undefined
              }
              key={option.value}
              onSelect={() => onChoose(option.value)}
              reason={option.reason}
              reserveIcon={marks}
              selected={false}
              trailing={
                option.shortcut ? (
                  <kbd className="whitespace-nowrap rounded-xs border border-line px-[5px] py-px font-mono text-2xs leading-4 text-ink-muted">
                    {option.shortcut}
                  </kbd>
                ) : undefined
              }
              aria-current={option.value === value ? "true" : undefined}
            >
              {option.label}
            </DropdownMenuEntry>
          ))}
        </DropdownMenuSurface>
      </DropdownMenuPortal>
    </DropdownMenu>
  );
}
