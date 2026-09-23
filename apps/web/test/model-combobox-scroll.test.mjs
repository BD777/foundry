import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const src = fileURLToPath(new URL("../src", import.meta.url));
const combobox = readFileSync(
  join(src, "components/ui/model-combobox.tsx"),
  "utf8",
);
const styleDirectory = join(src, "styles");
const profiles = readFileSync(join(styleDirectory, "67-profiles.css"), "utf8");

/** The declarations of one rule, so the assertions can read it as a block. */
function ruleFor(selector) {
  const rule = new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`).exec(profiles);
  assert.ok(rule, `${selector} must be styled`);
  return rule[1];
}

/**
 * The picker opens inside the profile dialog. Radix's dialog exempts only its
 * own panel from the scroll lock, so a non-modal popover portals outside that
 * exemption and the lock cancels its wheel events — the catalog renders but
 * will not scroll. A modal popover owns the topmost lock instead.
 */
test("the model popover is modal so its list can scroll inside a dialog", () => {
  const root = /<Popover\.Root([^>]*)>/.exec(combobox);
  assert.ok(root, "the combobox must render a Popover.Root");
  assert.match(
    root[1],
    /\bmodal\b/,
    "Popover.Root must be modal or the dialog's scroll lock cancels wheel events",
  );
});

test("the scrolling list is bounded by its own class, not a cmdk internal", () => {
  assert.match(combobox, /<Command\.List className="fdy-model-combobox-list"/);
});

/**
 * Height has to be handed down every step: the popover caps itself, gives the
 * catalog the one flexible row, and the Command wrapper repeats that split.
 * If any step falls back to an `auto` track the list grows to all 19 rows and
 * overflows instead of scrolling — verified in headless Chrome.
 */
test("every box between the popover and the list passes its bound down", () => {
  const popover = ruleFor("fdy-model-combobox-popover");
  assert.match(popover, /max-height:\s*min\(/);
  assert.match(
    popover,
    /grid-template-rows:\s*minmax\(0,\s*1fr\)\s*auto/,
    "the catalog row must flex while the note row stays auto",
  );

  const command = ruleFor("fdy-model-combobox-command");
  assert.match(command, /grid-template-rows:\s*auto\s*minmax\(0,\s*1fr\)/);
  assert.match(command, /min-height:\s*0/);

  const list = ruleFor("fdy-model-combobox-list");
  assert.match(list, /overflow-y:\s*auto/);
});

/**
 * The panel opens downward and stays put. Radix flips a colliding popover above
 * its trigger, and re-decides as filtering changes the height, so the list used
 * to jump around while typing.
 */
test("the panel opens downward instead of flipping over the trigger", () => {
  const content = /<Popover\.Content([\s\S]*?)>/.exec(combobox);
  assert.ok(content, "the combobox must render a Popover.Content");
  assert.match(content[1], /side="bottom"/);
  assert.match(content[1], /avoidCollisions=\{false\}/);
});

/**
 * With flipping off, the remaining jump was the panel resizing as results were
 * filtered out. The catalog holds a floor so the geometry settles, and that
 * floor subtracts the panel's own chrome so a panel clamped by a nearby
 * viewport edge still fits its list rather than overflowing it.
 */
test("the catalog holds a floor that yields to the available height", () => {
  const list = ruleFor("fdy-model-combobox-list");
  const floor = /min-height:\s*min\(([\s\S]*?)\);/.exec(list);
  assert.ok(floor, "the catalog needs a min-height floor to settle the panel");
  assert.match(
    floor[1],
    /--radix-popover-content-available-height/,
    "the floor must yield to the space below the trigger",
  );
  assert.equal(
    (floor[1].match(/--fdy-model-combobox-chrome/g) ?? []).length,
    2,
    "both terms must subtract the panel chrome",
  );
  assert.match(
    ruleFor("fdy-model-combobox-popover"),
    /--fdy-model-combobox-chrome:\s*\d/,
    "the chrome allowance belongs to the panel that owns it",
  );
});

test("no stylesheet reaches into cmdk's private part attributes", () => {
  const offenders = [];
  for (const file of readdirSync(styleDirectory)) {
    if (!file.endsWith(".css")) continue;
    const sheet = readFileSync(join(styleDirectory, file), "utf8");
    // `[cmdk-item]` and friends are cmdk's internal part hooks. Styling them
    // couples us to its DOM; every part forwards `className` instead.
    for (const match of sheet.matchAll(/\[cmdk-[a-z-]+/g)) {
      offenders.push(`${file}: ${match[0]}]`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "style cmdk parts through their className prop, not their internal attributes",
  );
});

/**
 * Two separate things kept these menus unusable inside the profile dialog, and
 * both had to be fixed: the popover rendered behind the dialog overlay, and an
 * open dialog disables body pointer events for every layer but the topmost
 * dismissable one, which a non-modal menu never joins.
 */
test("dropdowns inside the profile dialog open modally", () => {
  const selectMenu = readFileSync(
    join(src, "components/ui/select-menu.tsx"),
    "utf8",
  );
  assert.match(
    selectMenu,
    /modal=\{insideDialog\}/,
    "the menu must open modally exactly when it sits inside a dialog",
  );

  const editor = readFileSync(
    join(src, "features/profiles/profile-editor.tsx"),
    "utf8",
  );
  assert.match(
    editor,
    /<RuntimeDefaultFields[\s\S]*?insideDialog/,
    "the profile editor passes dialog context into shared controls",
  );
  const fields = readFileSync(
    join(src, "components/ui/runtime-default-fields.tsx"),
    "utf8",
  );
  assert.match(fields, /<SelectMenu[\s\S]*?insideDialog=\{insideDialog\}/);
});

test("a portalled menu stacks above the dialog it opens over", () => {
  const chat = readFileSync(join(styleDirectory, "20-chat.css"), "utf8");
  const popover = /\.fdy-select-popover\s*\{([^}]*)\}/.exec(chat);
  assert.ok(popover, ".fdy-select-popover must be styled");
  const layer = /z-index:\s*(\d+)/.exec(popover[1]);
  assert.ok(layer, "the portalled menu needs an explicit layer");

  // Every dialog this menu can open over, so the guard tracks the real ceiling.
  const dialogs = [...profiles.matchAll(/z-index:\s*(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  assert.ok(
    Number(layer[1]) >= Math.max(...dialogs),
    `the menu (${layer[1]}) must clear the profile dialog (${Math.max(...dialogs)})`,
  );
});

/**
 * A centred dialog whose height follows its content re-centres itself whenever
 * the fields change, so switching runtime moved the whole window. A settled
 * height with the form as the one scrolling row keeps it still.
 */
test("the profile dialog keeps a settled height", () => {
  const modal = ruleFor("fdy-profile-modal");
  assert.match(
    modal,
    /\n\s+height:\s*min\(/,
    "the dialog needs a height, not only a max-height, to stop re-centring",
  );
  assert.doesNotMatch(
    modal,
    /overflow:\s*auto/,
    "the form scrolls, not the whole dialog, so the header stays put",
  );
  assert.match(modal, /grid-template-areas:/);
});
