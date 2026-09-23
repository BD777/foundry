import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, ChevronDown, Plus, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { Button } from "./button";

export interface ModelComboboxProps {
  ariaLabel: string;
  busy?: boolean;
  /** The model a run uses when it picks nothing. */
  value: string;
  /** Every model this profile offers, including `value`. */
  options: string[];
  onChange: (next: { options: string[]; value: string }) => void;
  onRefresh?: () => void;
  /** Shown under the list, e.g. why a refresh came back empty. */
  note?: string;
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
  note,
  onChange,
  onRefresh,
  options,
  placeholder,
  value,
  allowCustom = true,
  disabled = false,
}: ModelComboboxProps) {
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
          className="fdy-model-combobox-trigger"
          variant="secondary"
        >
          <span>{value || placeholder || "Select a model"}</span>
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
          className="fdy-model-combobox-popover"
          data-catalog-only={!allowCustom}
          collisionPadding={12}
          side="bottom"
          sideOffset={6}
        >
          <Command className="fdy-model-combobox-command" loop>
            <div className="fdy-model-combobox-header">
              <Command.Input
                autoFocus
                className="fdy-model-combobox-input"
                onValueChange={setQuery}
                placeholder={
                  allowCustom
                    ? "Filter or type a model"
                    : "Search official models"
                }
                value={query}
              />
              {onRefresh ? (
                <Button
                  aria-busy={busy}
                  aria-label={
                    allowCustom
                      ? "Refresh models from the endpoint"
                      : "Refresh official models"
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
            <Command.List className="fdy-model-combobox-list">
              <Command.Empty className="fdy-model-combobox-empty">
                {busy ? "Loading models…" : "No matching model."}
              </Command.Empty>
              {options.map((option) => (
                <Command.Item
                  className="fdy-model-combobox-item"
                  key={option}
                  onSelect={() => pick(option)}
                  value={option}
                >
                  <Check
                    data-selected={option === value}
                    className="fdy-model-combobox-check"
                    size={13}
                  />
                  <span className="fdy-model-combobox-item-label">
                    {option}
                  </span>
                  {allowCustom ? (
                    <Button
                      aria-label={`Remove ${option}`}
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
                  className="fdy-model-combobox-item"
                  forceMount
                  onSelect={() => pick(candidate)}
                  value={`add-${candidate}`}
                >
                  <Plus size={13} />
                  <span className="fdy-model-combobox-item-label">
                    Use “{candidate}”
                  </span>
                </Command.Item>
              ) : null}
            </Command.List>
          </Command>
          {note ? (
            <small className="fdy-model-combobox-note">{note}</small>
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
