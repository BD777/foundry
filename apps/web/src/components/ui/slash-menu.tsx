import { useEffect, useRef } from "react";
import { Button } from "./button";

export interface SlashSuggestion {
  /** Inserted token after the slash, e.g. "bits-unit-test-run". */
  value: string;
  /** Primary line; defaults to value. */
  label?: string;
  description?: string;
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
 * relatively-positioned input shell, anchored just above the textarea.
 */
export function SlashMenu({
  items,
  activeIndex,
  query,
  onSelect,
  onActiveIndex,
}: SlashMenuProps) {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(
      "[data-active='true']",
    );
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (items.length === 0) {
    return (
      <div className="fdy-slash-menu" role="listbox" aria-label="Skills">
        <p className="fdy-slash-empty">
          No skills match “{query}”. Promote and select one in workspace →
          Skills.
        </p>
      </div>
    );
  }

  return (
    <ul
      aria-activedescendant={`slash-item-${activeIndex}`}
      aria-label="Skills"
      className="fdy-slash-menu"
      ref={listRef}
      role="listbox"
    >
      {items.map((item, index) => (
        <li key={item.value} role="none">
          <Button
            aria-selected={index === activeIndex}
            className="fdy-slash-item"
            data-active={index === activeIndex}
            id={`slash-item-${index}`}
            // mousedown (not click) so the textarea keeps focus while picking.
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(index);
            }}
            onMouseEnter={() => onActiveIndex(index)}
            role="option"
            type="button"
            variant="ghost"
          >
            <span className="fdy-slash-item-name">/{item.value}</span>
            {item.description ? (
              <span className="fdy-slash-item-desc">{item.description}</span>
            ) : null}
          </Button>
        </li>
      ))}
    </ul>
  );
}
