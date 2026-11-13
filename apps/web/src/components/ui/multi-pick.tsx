import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";
import { RemovableChip } from "./chip";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command";

export interface MultiPickOption {
  value: string;
  label: string;
  /** One small line under the label, such as a kind and an id. */
  detail?: string;
  /** Shown at the row's end, such as how often it was seen. */
  status?: ReactNode;
}

export interface MultiPickProps {
  ariaLabel: string;
  addLabel: string;
  options: MultiPickOption[];
  values: string[];
  onChange: (values: string[]) => void;
  searchPlaceholder: string;
  emptyText: string;
  removeLabel: (label: string) => string;
  /** A chosen value's label when it is not among the options (else its value). */
  labelFor?: (value: string) => string;
}

function matches(_value: string, search: string, keywords?: string[]): number {
  const haystack = (keywords ?? []).join(" ").toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word))
    ? 1
    : 0;
}

/*
 * A searchable pick of several values (a Radix Popover holding a cmdk
 * Command, like SearchSelect): the chosen ones as removable chips, then an
 * Add button whose list toggles values on and off and stays open.
 */
export function MultiPick({
  addLabel,
  ariaLabel,
  emptyText,
  labelFor,
  onChange,
  options,
  removeLabel,
  searchPlaceholder,
  values,
}: MultiPickProps) {
  const label = (value: string) =>
    options.find((option) => option.value === value)?.label ||
    labelFor?.(value) ||
    value;
  const toggle = (value: string) =>
    onChange(
      values.includes(value)
        ? values.filter((entry) => entry !== value)
        : [...values, value],
    );

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {values.map((value) => (
        <RemovableChip
          key={value}
          mono={false}
          onRemove={() => toggle(value)}
          removeLabel={removeLabel(label(value))}
          title={value}
        >
          {label(value)}
        </RemovableChip>
      ))}
      <PopoverPrimitive.Root>
        <PopoverPrimitive.Trigger asChild>
          <Button
            aria-label={`${ariaLabel} · ${addLabel}`}
            size="sm"
            variant="ghost"
          >
            <Plus aria-hidden="true" size={14} />
            {addLabel}
          </Button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            align="start"
            className="z-110 grid max-h-[min(360px,var(--radix-popover-content-available-height))] w-[min(340px,calc(100vw-24px))] grid-rows-[minmax(0,1fr)] rounded-lg bg-surface p-1.5 text-ink shadow-floating"
            collisionPadding={12}
            sideOffset={6}
          >
            <Command
              className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] rounded-none bg-transparent"
              filter={matches}
              label={ariaLabel}
              loop
            >
              <CommandInput
                autoFocus
                className="border-b border-line"
                placeholder={searchPlaceholder}
              />
              <CommandList className="min-h-0 pt-1">
                <CommandEmpty>{emptyText}</CommandEmpty>
                {options.map((option) => {
                  const chosen = values.includes(option.value);
                  return (
                    <CommandItem
                      className="grid min-h-[38px] grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 py-1.5"
                      key={option.value}
                      keywords={[option.label, option.value]}
                      onSelect={() => toggle(option.value)}
                      value={option.value}
                    >
                      <Check
                        aria-hidden="true"
                        className={cn(
                          "row-start-1",
                          chosen ? "opacity-100" : "opacity-0",
                        )}
                        size={15}
                      />
                      <span className="col-start-2 row-start-1 min-w-0 truncate text-sm font-[560]">
                        {option.label}
                      </span>
                      <span className="col-start-3 row-start-1 text-xs text-ink-faint">
                        {option.status}
                      </span>
                      {option.detail ? (
                        <small className="col-start-2 col-end-4 min-w-0 truncate text-xs leading-[1.35] text-ink-faint">
                          {option.detail}
                        </small>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandList>
            </Command>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </div>
  );
}
