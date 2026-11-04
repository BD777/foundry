import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, ChevronDown, Plus, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { FieldHint } from "../ui/field";
import { LoadingState } from "../ui/loading";

/** cmdk marks the active row with `data-selected`. */
const itemClass =
  "flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1.5 font-mono text-xs text-ink data-[selected=true]:bg-control-hover";
const itemLabelClass = "min-w-0 flex-1 truncate";

export interface ModelComboboxProps {
  ariaLabel: string;
  busy?: boolean;
  /** The model a run uses when it picks nothing. */
  value: string;
  /** Every model this profile offers, including `value`. */
  options: string[];
  onChange: (next: { options: string[]; value: string }) => void;
  onRefresh?: () => void;
  /** What the catalog is and where it comes from, at the foot of the list. */
  hint?: string;
  placeholder?: string;
  /** Official catalogs are selection-only, never user-editable. */
  allowCustom?: boolean;
  disabled?: boolean;
}

/**
 * An editable model picker: type to filter, pick to use, or add what you typed
 * when the endpoint's catalog does not list it. Every entry belongs to the
 * profile, so anything added here is selectable wherever a run is configured.
 */
export function ModelCombobox({
  ariaLabel,
  busy = false,
  hint,
  onChange,
  onRefresh,
  options,
  placeholder,
  value,
  allowCustom = true,
  disabled = false,
}: ModelComboboxProps) {
  const { t } = useTranslation("agents");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const candidate = query.trim();
  const canAdd =
    allowCustom && candidate !== "" && !options.includes(candidate);

  function pick(model: string): void {
    onChange({
      options: options.includes(model) ? options : [...options, model],
      value: model,
    });
    setQuery("");
    setOpen(false);
  }

  function remove(model: string): void {
    onChange({
      options: options.filter((option) => option !== model),
      value: value === model ? "" : value,
    });
  }

  return (
    // `modal` is what makes the list scrollable. This picker opens inside the
    // profile dialog, whose scroll lock only exempts the dialog panel itself.
    // A non-modal popover portals outside that exemption, so the lock cancels
    // its wheel events. A modal popover owns the topmost lock and scrolls.
    <Popover.Root modal onOpenChange={setOpen} open={open}>
      <Popover.Trigger asChild>
        <Button
          aria-label={ariaLabel}
          disabled={disabled}
          className="fdy-model-combobox-trigger h-auto min-h-8.5 w-full justify-between gap-2 rounded-md px-2.5 py-1.75 font-mono text-xs font-normal active:scale-100"
          variant="secondary"
        >
          <span>{value || placeholder || t("modelCombobox.selectModel")}</span>
          <ChevronDown size={14} />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          // Always downward. Radix would otherwise flip the panel above the
          // trigger once the catalog got tall, and re-decide on every keystroke
          // as filtering changed its height, so the list jumped while typing.
          // `size` still runs with collisions off, so a panel with little room
          // below shrinks to fit instead of flipping or leaving the viewport.
          avoidCollisions={false}
          // The catalog takes the one flexible row and the note its own; an
          // `auto` track would size to the whole list and overflow the panel.
          // The panel is bounded and normally settled at that bound: the
          // list below holds a floor, so filtering changes what is listed,
          // not how tall the panel is (a content-sized panel resized on
          // every keystroke and moved rows out from under the pointer). It
          // still yields to a trigger with little room beneath it. Radix
          // copies the z-index onto its wrapper: it must clear the profile
          // dialog (81) or the dialog swallows every click in the list.
          className={cn(
            "z-90 grid min-h-0 w-(--radix-popover-trigger-width) grid-rows-[minmax(0,1fr)_auto] gap-1.5 rounded-lg bg-panel p-1.5 shadow-raised",
            "max-h-[min(320px,var(--radix-popover-content-available-height))]",
            // Everything the panel puts around the catalog (filter row, note,
            // gaps, padding); the list's floor is derived from it.
            allowCustom
              ? "[--fdy-model-combobox-chrome:66px]"
              : "[--fdy-model-combobox-chrome:82px]",
          )}
          collisionPadding={12}
          side="bottom"
          sideOffset={6}
        >
          <Command
            // The filter row stays put while only the list scrolls. Command
            // renders a visually hidden label of its own first, so the rows
            // are addressed by area name, not position.
            className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] [grid-template-areas:'filter'_'catalog']"
            loop
          >
            <div className="flex items-center gap-1 border-b border-line pb-1 [grid-area:filter]">
              <Command.Input
                autoFocus
                className="min-w-0 flex-1 border-0 bg-transparent px-1.5 py-1.25 text-xs text-ink outline-none"
                onValueChange={setQuery}
                placeholder={
                  allowCustom
                    ? t("modelCombobox.filterOrType")
                    : t("modelCombobox.searchOfficial")
                }
                value={query}
              />
              {onRefresh ? (
                <Button
                  aria-busy={busy}
                  aria-label={
                    allowCustom
                      ? t("modelCombobox.refreshFromEndpoint")
                      : t("modelCombobox.refreshOfficial")
                  }
                  // Never disabled: disabling the focused button drops focus out
                  // of the popover, which closes it mid-refresh.
                  onClick={() => {
                    if (!busy) onRefresh();
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <RefreshCw size={14} />
                </Button>
              ) : null}
            </div>
            <Command.List
              // The floor keeps the panel still while typing: filtering
              // narrows the catalog and, without it, the panel resized on
              // every keystroke. Both terms subtract the panel's own chrome
              // so a clamped panel still fits its list. Catalog-only mode
              // stays compact instead.
              className={cn(
                "overflow-y-auto overscroll-contain [grid-area:catalog]",
                allowCustom
                  ? "min-h-[min(320px_-_var(--fdy-model-combobox-chrome),var(--radix-popover-content-available-height)_-_var(--fdy-model-combobox-chrome))]"
                  : "max-h-56 min-h-0",
              )}
            >
              <Command.Empty className="p-2 text-xs text-ink-faint">
                {busy ? (
                  <LoadingState label={t("modelCombobox.loading")} />
                ) : (
                  t("modelCombobox.noMatch")
                )}
              </Command.Empty>
              {options.map((option) => (
                <Command.Item
                  className={itemClass}
                  key={option}
                  onSelect={() => pick(option)}
                  value={option}
                >
                  <Check
                    data-selected={option === value}
                    className="flex-none opacity-0 data-[selected=true]:opacity-100"
                    size={13}
                  />
                  <span className={itemLabelClass}>{option}</span>
                  {allowCustom ? (
                    <Button
                      aria-label={t("modelCombobox.remove", { model: option })}
                      onClick={(event) => {
                        event.stopPropagation();
                        remove(option);
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      <X size={12} />
                    </Button>
                  ) : null}
                </Command.Item>
              ))}
              {canAdd ? (
                <Command.Item
                  className={itemClass}
                  forceMount
                  onSelect={() => pick(candidate)}
                  value={`add-${candidate}`}
                >
                  <Plus size={13} />
                  <span className={itemLabelClass}>
                    {t("modelCombobox.use", { model: candidate })}
                  </span>
                </Command.Item>
              ) : null}
            </Command.List>
          </Command>
          {hint ? (
            <FieldHint as="small" className="mt-0 text-2xs leading-normal">
              {hint}
            </FieldHint>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Discovered models join the profile's list without disturbing what is already
 * there: the user's own entries and their chosen default survive a refresh.
 */
export function mergeDiscoveredModels(
  existing: string[],
  discovered: string[],
): string[] {
  const merged = [...existing];
  for (const candidate of discovered) {
    const model = candidate.trim();
    if (model && !merged.includes(model)) merged.push(model);
  }
  return merged;
}
