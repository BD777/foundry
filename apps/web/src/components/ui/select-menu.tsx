import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";

export interface SelectMenuOption {
  disabled?: boolean;
  /**
   * Short, human explanation rendered under the label inside the open menu
   * (e.g. why the row is unavailable). Wraps to a couple of lines. The closed
   * trigger never shows it.
   */
  detail?: string;
  label: string;
  /**
   * Short source/status line, rendered under the label in the open menu only.
   */
  meta?: string;
  /** Full text exposed as the row's native tooltip / accessible description. */
  title?: string;
  value: string;
}

export interface SelectMenuProps {
  ariaLabel: string;
  className?: string;
  /**
   * Force the trigger to icon-only (runtime prefix + chevron). The open menu
   * still shows full labels and descriptions. The owned stylesheet also
   * collapses the trigger automatically inside a narrow composer container.
   */
  compactTrigger?: boolean;
  popoverClassName?: string;
  disabled?: boolean;
  /**
   * Optional content rendered after the options, outside the radio group.
   * Use for a reachable help/management link that must stay clickable while
   * every option in the list is disabled.
   */
  footer?: ReactNode;
  /**
   * Set when the menu opens inside a dialog. An open dialog puts
   * `pointer-events: none` on the body and re-enables it only for the topmost
   * dismissable layer, which a non-modal menu never joins — so its options
   * cannot be clicked. Opening modally puts the menu on that stack. The
   * popover's z-index has to clear the dialog too; both are required.
   */
  insideDialog?: boolean;
  onChange: (value: string) => void;
  options: SelectMenuOption[];
  placeholder?: string;
  renderOptionPrefix?: (option: SelectMenuOption) => ReactNode;
  renderTriggerPrefix?: (option: SelectMenuOption | undefined) => ReactNode;
  side?: "top" | "bottom";
  tone?: "field" | "pill";
  value: string;
}

export function SelectMenu({
  ariaLabel,
  className,
  compactTrigger = false,
  popoverClassName,
  disabled = false,
  footer,
  insideDialog = false,
  onChange,
  options,
  placeholder = "Select",
  renderOptionPrefix,
  renderTriggerPrefix,
  side = "bottom",
  tone = "field",
  value,
}: SelectMenuProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const selectedOption = options.find((option) => option.value === value);
  const visibleOption =
    selectedOption ?? (value ? { label: value, value } : undefined);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    const trigger = triggerRef.current;
    if (!open || !trigger) return;
    const observer = new ResizeObserver(() => {
      if (!trigger.getClientRects().length) setOpen(false);
    });
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [open]);

  return (
    <div className={["fdy-select-menu", className].filter(Boolean).join(" ")}>
      <DropdownMenu.Root
        open={open}
        onOpenChange={setOpen}
        modal={insideDialog}
      >
        <DropdownMenu.Trigger asChild>
          <Button
            aria-label={
              visibleOption ? `${ariaLabel}: ${visibleOption.label}` : ariaLabel
            }
            className="fdy-select-trigger"
            data-compact={compactTrigger ? "true" : undefined}
            data-tone={tone}
            disabled={disabled}
            ref={triggerRef}
            title={visibleOption?.label}
            variant="ghost"
          >
            {renderTriggerPrefix?.(visibleOption)}
            <span className="fdy-select-trigger-copy">
              <strong>{visibleOption?.label ?? placeholder}</strong>
            </span>
            <ChevronDown size={16} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            aria-label={ariaLabel}
            align="start"
            className={["fdy-select-popover", popoverClassName]
              .filter(Boolean)
              .join(" ")}
            collisionPadding={12}
            side={side}
            sideOffset={8}
            onCloseAutoFocus={(event) => {
              if (!triggerRef.current?.getClientRects().length)
                event.preventDefault();
            }}
          >
            {options.length > 0 ? (
              <DropdownMenu.RadioGroup
                className="fdy-select-options"
                value={value}
                onValueChange={onChange}
              >
                {options.map((option) => (
                  <DropdownMenu.RadioItem
                    asChild
                    disabled={option.disabled}
                    key={option.value}
                    textValue={option.label}
                    value={option.value}
                  >
                    <Button
                      className="fdy-select-option"
                      data-selected={option.value === value}
                      disabled={option.disabled}
                      title={option.title ?? option.detail}
                      variant="ghost"
                    >
                      <span className="fdy-select-option-prefix">
                        {renderOptionPrefix?.(option)}
                      </span>
                      <strong className="fdy-select-option-label">
                        {option.label}
                      </strong>
                      {option.meta ? (
                        <em className="fdy-select-option-meta">
                          {option.meta}
                        </em>
                      ) : null}
                      {option.detail ? (
                        <small className="fdy-select-option-detail">
                          {option.detail}
                        </small>
                      ) : null}
                      {option.value === value ? (
                        <Check className="fdy-select-option-check" size={17} />
                      ) : null}
                    </Button>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            ) : (
              <div className="fdy-select-empty">{placeholder}</div>
            )}
            {footer ? <div className="fdy-select-footer">{footer}</div> : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
