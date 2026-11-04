import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Command, CommandEmpty, CommandItem, CommandList } from "./command";

export interface SlashSuggestion {
  /** Inserted token after the slash, e.g. "bits-unit-test-run". */
  value: string;
  /** Primary line; defaults to value. */
  label?: string;
  description?: string;
  /** Where the item comes from, shown beside its name (e.g. "Claude Code"). */
  tag?: string;
}

interface SlashMenuProps {
  items: SlashSuggestion[];
  activeIndex: number;
  query: string;
  onSelect: (index: number) => void;
  onActiveIndex: (index: number) => void;
}

/**
 * Floating list for a "/token" being typed. Rendered inside the composer's
 * relatively-positioned input shell, anchored just above the textarea. The
 * textarea keeps focus and the keys: the host sets `activeIndex` from the
 * arrow keys, and the menu only reports the pointer's choice.
 */
export function SlashMenu({
  items,
  activeIndex,
  query,
  onSelect,
  onActiveIndex,
}: SlashMenuProps) {
  const { t } = useTranslation("ui");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[aria-selected='true']")
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <Command
      className="fdy-slash-menu absolute bottom-[calc(100%-6px)] left-0 z-40 w-[min(440px,90vw)] p-1.5 shadow-panel-focus"
      label={t("slashMenu.label")}
      onValueChange={(value) => {
        const index = items.findIndex((item) => item.value === value);
        if (index >= 0) onActiveIndex(index);
      }}
      shouldFilter={false}
      value={items[activeIndex]?.value ?? ""}
      vimBindings={false}
    >
      <CommandList className="max-h-[252px]" ref={listRef}>
        <CommandEmpty>{t("slashMenu.empty", { query })}</CommandEmpty>
        {items.map((item, index) => (
          <CommandItem
            className="fdy-slash-item flex-col items-start gap-0.5"
            key={item.value}
            // mousedown (not click) so the textarea keeps focus while picking.
            onMouseDown={(event) => event.preventDefault()}
            onSelect={() => onSelect(index)}
            value={item.value}
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="text-sm font-[650] text-ink">/{item.value}</span>
              {item.tag ? (
                <span className="text-2xs text-ink-faint">{item.tag}</span>
              ) : null}
            </span>
            {item.description ? (
              <span className="line-clamp-2 text-2xs leading-[1.4] text-ink-faint">
                {item.description}
              </span>
            ) : null}
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}
