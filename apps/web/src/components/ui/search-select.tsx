import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command";

export interface SearchSelectOption {
  value: string;
  label: string;
  /** One line under the label, in the open list only. */
  detail?: string;
  /** Other words the filter matches (a vendor, a kind, a source). */
  keywords?: string[];
  /** Status at the row's end, e.g. a Badge; also shown on the trigger. */
  status?: ReactNode;
}

export interface SearchSelectTrailingOption extends SearchSelectOption {
  onSelect: () => void;
}

export interface SearchSelectGroup {
  key: string;
  heading: string;
  /** Where the group's options come from, under its heading. */
  description?: string;
  options: SearchSelectOption[];
}

export interface SearchSelectProps {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  groups: SearchSelectGroup[];
  searchPlaceholder: string;
  emptyText: string;
  className?: string;
  /** Page-specific content after the option groups, inside the list. */
  footer?: ReactNode;
  /** A non-catalog choice set off after the list, on the same row style. */
  trailingOption?: SearchSelectTrailingOption;
  /** Controlled state, for a footer action that closes the picker. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Every word typed appears in the option's label or keywords, ignoring case.
 * cmdk's default fuzzy score also matches scattered letters, so a long
 * description matched nearly anything and stayed highlighted for Enter.
 */
function matches(_value: string, search: string, keywords?: string[]): number {
  const haystack = (keywords ?? []).join(" ").toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word))
    ? 1
    : 0;
}

const rowClass =
  "grid min-h-[38px] grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 py-1.5";

/*
 * shadcn/ui's Combobox (a Radix Popover holding a cmdk Command) on the
 * select's field look: a trigger naming the choice and its status, a list
 * that filters as you type and groups its options under headings. For a
 * choice among many, where SelectMenu's flat list stops scaling.
 */
export function SearchSelect({
  ariaLabel,
  className,
  emptyText,
  onOpenChange,
  open: controlledOpen,
  groups,
  onChange,
  searchPlaceholder,
  value,
  footer,
  trailingOption,
}: SearchSelectProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const selected =
    groups
      .flatMap((group) => group.options)
      .find((option) => option.value === value) ??
    (trailingOption?.value === value ? trailingOption : undefined);

  return (
    <PopoverPrimitive.Root onOpenChange={setOpen} open={open}>
      <PopoverPrimitive.Trigger asChild>
        <Button
          aria-label={selected ? `${ariaLabel}: ${selected.label}` : ariaLabel}
          className={cn(
            "h-9 w-full justify-between gap-2 rounded-md border border-line bg-panel px-[11px] py-0 text-left text-sm font-[650] text-ink hover:border-brand hover:bg-panel focus-visible:shadow-[0_0_0_2px_var(--fdy-control-focus-soft)] aria-expanded:border-brand aria-expanded:bg-panel active:scale-100 [&>svg]:flex-none",
            className,
          )}
          role="combobox"
          variant="ghost"
        >
          <span className="min-w-0 flex-1 truncate">{selected?.label}</span>
          {selected?.status}
          <ChevronDown aria-hidden="true" size={16} />
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          className="z-110 grid max-h-[min(420px,var(--radix-popover-content-available-height))] w-(--radix-popover-trigger-width) min-w-[min(320px,calc(100vw-24px))] grid-rows-[minmax(0,1fr)] rounded-lg bg-surface p-1.5 text-ink shadow-floating"
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
              {groups.map((group) =>
                group.options.length ? (
                  <CommandGroup
                    heading={
                      <span className="grid gap-0.5">
                        <span>{group.heading}</span>
                        {group.description ? (
                          <span className="font-medium">
                            {group.description}
                          </span>
                        ) : null}
                      </span>
                    }
                    key={group.key}
                  >
                    {group.options.map((option) => (
                      <CommandItem
                        className={rowClass}
                        data-current={option.value === value || undefined}
                        key={option.value}
                        keywords={[option.label, ...(option.keywords ?? [])]}
                        onSelect={() => {
                          onChange(option.value);
                          setOpen(false);
                        }}
                        value={`${group.key}:${option.value} ${option.label}`}
                      >
                        <Check
                          aria-hidden="true"
                          className={cn(
                            "row-start-1",
                            option.value === value
                              ? "opacity-100"
                              : "opacity-0",
                          )}
                          size={15}
                        />
                        <span className="col-start-2 row-start-1 min-w-0 truncate text-sm font-[560]">
                          {option.label}
                        </span>
                        <span className="col-start-3 row-start-1">
                          {option.status}
                        </span>
                        {option.detail ? (
                          <small className="col-start-2 col-end-4 min-w-0 truncate text-xs leading-[1.35] text-ink-faint">
                            {option.detail}
                          </small>
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null,
              )}
              {footer}
              {trailingOption ? (
                <div className="mt-1 border-t border-line pt-1">
                  <CommandItem
                    className={rowClass}
                    data-current={trailingOption.value === value || undefined}
                    keywords={[
                      trailingOption.label,
                      ...(trailingOption.keywords ?? []),
                    ]}
                    onSelect={() => {
                      trailingOption.onSelect();
                      setOpen(false);
                    }}
                    value={`trailing:${trailingOption.value} ${trailingOption.label}`}
                  >
                    <Check
                      aria-hidden="true"
                      className={cn(
                        "row-start-1",
                        trailingOption.value === value
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                      size={15}
                    />
                    <span className="col-start-2 row-start-1 min-w-0 truncate text-sm font-[560]">
                      {trailingOption.label}
                    </span>
                    <span className="col-start-3 row-start-1">
                      {trailingOption.status}
                    </span>
                    {trailingOption.detail ? (
                      <small className="col-start-2 col-end-4 min-w-0 truncate text-xs leading-[1.35] text-ink-faint">
                        {trailingOption.detail}
                      </small>
                    ) : null}
                  </CommandItem>
                </div>
              ) : null}
            </CommandList>
          </Command>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
