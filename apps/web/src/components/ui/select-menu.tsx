import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cva } from "class-variance-authority";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Button } from "./button";
import { Spinner } from "./loading";

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

/**
 * A row that does something instead of selecting a value, e.g. "Set up…"
 * for a connection not on this device yet. Rendered after the options as a
 * keyboard-reachable menu item; choosing it closes the menu and calls
 * `onSelect`.
 */
export interface SelectMenuAction {
  key: string;
  label: string;
  /** Why it is offered (e.g. "Not set up on this device"); wraps. */
  detail?: string;
  /** The visible verb on the row's right, e.g. "Set up…". */
  actionLabel?: string;
  prefix?: ReactNode;
  disabled?: boolean;
  /** Shows a spinner by the verb and makes the row inert. */
  busy?: boolean;
  onSelect: () => void;
}

export interface SelectMenuProps {
  /** Action rows after the options (see SelectMenuAction). */
  actions?: SelectMenuAction[];
  ariaLabel: string;
  className?: string;
  /**
   * Icon-only trigger (runtime prefix + chevron); the open menu still shows
   * full labels and descriptions. `true` always; "auto" only inside a narrow
   * composer (the `fdy-composer` container under 400px).
   */
  compactTrigger?: boolean | "auto";
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
  /** Class of the trigger button, e.g. to cap its width. */
  triggerClassName?: string;
  /**
   * "icon": a borderless square holding only the trigger prefix, for toolbars.
   * Its public --fdy-select-icon-size CSS variable defaults to 26px; a
   * containing toolbar may set it to match its other controls.
   */
  tone?: "field" | "pill" | "icon";
  value: string;
}

/*
 * A select on shadcn/ui's DropdownMenu (a radio group in a Radix menu, so the
 * options can carry a note and the menu can end in actions and a footer), on
 * Beautiful UI's field, pill and menu looks. Radix's Select is not a
 * dependency of the Web.
 */
const triggerVariants = cva(
  "w-full justify-between gap-2 text-left disabled:opacity-55 [&>svg]:flex-none",
  {
    variants: {
      tone: {
        field:
          "h-9 rounded-md border border-line bg-panel px-[11px] py-0 text-xs font-[650] text-ink hover:border-brand hover:bg-panel aria-expanded:border-brand aria-expanded:bg-panel focus-visible:shadow-[0_0_0_2px_var(--fdy-control-focus-soft)]",
        pill: "h-8 rounded-md bg-transparent px-2 py-0 text-xs font-[560] text-ink hover:bg-control-ghost-hover aria-expanded:bg-control-ghost-hover",
        icon: "size-[var(--fdy-select-icon-size,26px)] justify-center rounded-sm bg-transparent p-0 text-ink-muted hover:bg-control-ghost-hover hover:text-ink aria-expanded:bg-control-ghost-hover aria-expanded:text-ink",
      },
      compact: {
        none: "",
        always: "gap-0 px-2",
        auto: "@max-[400px]/fdy-composer:min-w-0 @max-[400px]/fdy-composer:gap-0 @max-[400px]/fdy-composer:px-2",
      },
    },
    defaultVariants: { tone: "field", compact: "none" },
  },
);

/** The selected value beside the chevron; an icon-only trigger hides it. */
const triggerCopyVariants = cva(
  "grid min-w-0 flex-1 gap-px [&_strong]:truncate [&_strong]:[font:inherit] [&_strong]:text-inherit",
  {
    variants: {
      compact: {
        none: "",
        always: "hidden",
        auto: "@max-[400px]/fdy-composer:hidden",
      },
    },
  },
);

/** One row: prefix, label and check on the first line, notes under the label. */
const optionClass =
  "group grid h-auto min-h-[34px] w-full grid-cols-[auto_minmax(0,1fr)_18px] items-center gap-x-2.5 gap-y-0.5 rounded-sm px-2.5 py-1.5 text-left leading-[1.3] whitespace-normal hover:bg-control-ghost-hover data-highlighted:bg-control-ghost-hover data-[selected=true]:bg-selection data-[selected=true]:text-ink disabled:opacity-[0.62] [&_svg]:flex-none";
const optionPrefixClass = "col-start-1 row-start-1 inline-flex self-center";
const optionLabelClass =
  "col-start-2 row-start-1 min-w-0 truncate text-sm font-[560] leading-[1.3] text-ink";
const optionMetaClass =
  "col-start-2 min-w-0 text-xs font-medium not-italic leading-[1.35] whitespace-normal text-ink-faint";
const optionDetailClass =
  "col-start-2 min-w-0 text-2xs font-medium leading-[1.35] whitespace-normal text-ink-faint group-disabled:opacity-90";

export function SelectMenu({
  actions = [],
  ariaLabel,
  className,
  compactTrigger = false,
  popoverClassName,
  disabled = false,
  footer,
  insideDialog = false,
  onChange,
  options,
  placeholder: placeholderProp,
  renderOptionPrefix,
  renderTriggerPrefix,
  side = "bottom",
  tone = "field",
  triggerClassName,
  value,
}: SelectMenuProps) {
  const { t } = useTranslation("ui");
  const placeholder = placeholderProp ?? t("selectMenu.placeholder");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const selectedOption = options.find((option) => option.value === value);
  const visibleOption =
    selectedOption ?? (value ? { label: value, value } : undefined);
  const compact =
    compactTrigger === "auto" ? "auto" : compactTrigger ? "always" : "none";

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
    <div className={cn("relative min-w-0", className)}>
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
            className={cn(triggerVariants({ compact, tone }), triggerClassName)}
            disabled={disabled}
            ref={triggerRef}
            title={visibleOption?.label}
            variant="ghost"
          >
            {renderTriggerPrefix?.(visibleOption)}
            {tone === "icon" ? null : (
              <>
                <span className={triggerCopyVariants({ compact })}>
                  <strong>{visibleOption?.label ?? placeholder}</strong>
                </span>
                <ChevronDown size={16} />
              </>
            )}
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            aria-label={ariaLabel}
            data-inside-dialog={insideDialog ? "true" : undefined}
            align="start"
            // Radix copies the z-index onto its positioning wrapper. The menu
            // portals to the body, so it has to clear any dialog it opens over
            // (a dialog layer is z 100) or it renders behind the overlay.
            className={cn(
              "z-90 max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))] w-max max-w-[min(440px,calc(100vw-24px))] min-w-[max(var(--radix-dropdown-menu-trigger-width),220px)] overflow-y-auto rounded-lg bg-panel p-1.5 text-ink shadow-floating data-[inside-dialog=true]:z-110",
              popoverClassName,
            )}
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
                className="grid gap-0.5"
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
                      className={optionClass}
                      data-selected={option.value === value}
                      disabled={option.disabled}
                      title={option.title ?? option.detail}
                      variant="ghost"
                    >
                      <span className={optionPrefixClass}>
                        {renderOptionPrefix?.(option)}
                      </span>
                      <strong className={optionLabelClass}>
                        {option.label}
                      </strong>
                      {option.meta ? (
                        <em className={optionMetaClass}>{option.meta}</em>
                      ) : null}
                      {option.detail ? (
                        <small className={optionDetailClass}>
                          {option.detail}
                        </small>
                      ) : null}
                      {option.value === value ? (
                        <Check
                          className="col-start-3 row-start-1 self-center"
                          size={17}
                        />
                      ) : null}
                    </Button>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            ) : actions.length ? null : (
              <div className="p-3 text-sm font-[650] text-ink-faint">
                {placeholder}
              </div>
            )}
            {actions.length ? (
              <DropdownMenu.Group
                className={cn(
                  "grid gap-0.5",
                  options.length > 0 && "mt-1 border-t border-line pt-1",
                )}
              >
                {actions.map((action) => (
                  <DropdownMenu.Item
                    asChild
                    disabled={action.disabled || action.busy}
                    key={action.key}
                    onSelect={() => action.onSelect()}
                    textValue={action.label}
                  >
                    <Button
                      aria-busy={action.busy ? "true" : undefined}
                      className={cn(
                        optionClass,
                        "grid-cols-[auto_minmax(0,1fr)_auto]",
                      )}
                      disabled={action.disabled || action.busy}
                      title={action.detail}
                      variant="ghost"
                    >
                      <span className={optionPrefixClass}>{action.prefix}</span>
                      <strong className={optionLabelClass}>
                        {action.label}
                      </strong>
                      {action.actionLabel || action.busy ? (
                        <span className="col-start-3 row-start-1 inline-flex items-center gap-1 text-xs font-[650] whitespace-nowrap text-brand group-disabled:text-ink-faint">
                          {action.busy ? <Spinner size={12} /> : null}
                          {action.actionLabel}
                        </span>
                      ) : null}
                      {action.detail ? (
                        <small className={optionDetailClass}>
                          {action.detail}
                        </small>
                      ) : null}
                    </Button>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Group>
            ) : null}
            {footer ? (
              <div className="mt-1.5 border-t border-line px-2.5 pt-[9px] pb-[3px] empty:hidden [&_a:hover]:text-brand [&_a:hover]:underline [&_a]:inline-flex [&_a]:h-[30px] [&_a]:w-auto [&_a]:items-center [&_a]:justify-start [&_a]:gap-1.5 [&_a]:px-2 [&_a]:text-xs [&_a]:font-[650] [&_a]:text-ink-muted">
                {footer}
              </div>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
