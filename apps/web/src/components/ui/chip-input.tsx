import { forwardRef, useState, type KeyboardEvent } from "react";
import { RemovableChip } from "./chip";
import { TextInput } from "./field";

/** Typed words end at a comma (ASCII or full-width), an enumeration comma or a space. */
const separators = /[\s,，、]+/;

export interface ChipInputProps {
  id?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  /** Words past this many are not added. */
  maxItems?: number;
  /** The longest word, in characters. */
  maxLength?: number;
  removeLabel: (value: string) => string;
  invalid?: boolean;
  "aria-describedby"?: string;
  "aria-label"?: string;
}

/**
 * A boxed field of words: type one and press Enter, a comma or a space to
 * add it as a chip; Backspace in the empty box removes the last chip. Words
 * are trimmed and kept once each, ignoring case.
 */
export const ChipInput = forwardRef<HTMLInputElement, ChipInputProps>(
  function ChipInput(
    {
      id,
      values,
      onChange,
      placeholder,
      maxItems,
      maxLength,
      removeLabel,
      invalid,
      "aria-describedby": describedBy,
      "aria-label": ariaLabel,
    },
    ref,
  ) {
    const [text, setText] = useState("");
    const full = maxItems !== undefined && values.length >= maxItems;

    const add = (words: string[]): void => {
      const next = [...values];
      const seen = new Set(next.map((value) => value.toLowerCase()));
      for (const raw of words) {
        const word = raw.trim();
        if (!word || seen.has(word.toLowerCase())) continue;
        if (maxItems !== undefined && next.length >= maxItems) break;
        seen.add(word.toLowerCase());
        next.push(word);
      }
      if (next.length !== values.length) onChange(next);
    };

    // Words before a separator become chips; what follows stays typed.
    const takeWords = (value: string): void => {
      if (!separators.test(value)) {
        setText(value);
        return;
      }
      const pieces = value.split(separators);
      const rest = pieces.pop() ?? "";
      add(pieces);
      setText(rest);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        add([text]);
        setText("");
      } else if (event.key === "Backspace" && text === "" && values.length) {
        event.preventDefault();
        onChange(values.slice(0, -1));
      }
    };

    return (
      <div className="flex min-h-9 w-full min-w-0 flex-wrap items-center gap-1 rounded-md bg-control px-1.5 py-1 shadow-field transition-shadow duration-150 ease-out-strong focus-within:shadow-field-focus hover:not-focus-within:shadow-field-hover">
        {values.map((value) => (
          <RemovableChip
            key={value}
            onRemove={() => onChange(values.filter((entry) => entry !== value))}
            removeLabel={removeLabel(value)}
          >
            {value}
          </RemovableChip>
        ))}
        <TextInput
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-label={ariaLabel}
          enterKeyHint="done"
          fieldSize="token"
          id={id}
          maxLength={maxLength}
          onBlur={() => {
            add([text]);
            setText("");
          }}
          onChange={(event) => {
            const composing =
              "isComposing" in event.nativeEvent &&
              Boolean(event.nativeEvent.isComposing);
            if (composing) setText(event.target.value);
            else takeWords(event.target.value);
          }}
          // An input method commits its text after its last input event.
          onCompositionEnd={(event) => takeWords(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder={values.length || full ? undefined : placeholder}
          readOnly={full && text === ""}
          ref={ref}
          value={text}
        />
      </div>
    );
  },
);
