# The page's code: rules of thumb

Rules for `web/app/` (the page: Svelte components, `.svelte.ts` state, the
controller and its helpers). Not for `web/*.ts` (the devices, workers and renderers) or the core, where performance
rules. Follow a rule unless there is a good reason not to; when you break one, say why in a comment where it's broken.
The linters (§7) enforce what can be checked mechanically; the rest is for review.

## 1. Look: one design system

1. **Tokens only.** Colors, spacing, font sizes and weights, radii, shadows and control heights come from the tokens in
   `web/app/theme/tokens.css`, never as literals in a component. A missing value becomes a new token; it doesn't go
   into one component as a literal. Allowed literals (what Stylelint lets through): `0`, `1px` borders and hairlines,
   `50%`/`999px` for round shapes, `auto`, `none`, `normal`, `inherit`, `currentColor`, `transparent`, `calc()` over
   tokens; layout widths and heights of one component (`minmax(200px, 260px)`, a menu's `260px`: not checked), icon
   sizes passed to `<Icon>`.
2. **Semantic tokens, not raw palette.** A token is named by its role, so a re-theme changes one file:
   - surfaces `--surface` (the page; a field, a row in a dialog), `--surface-raised` (panes' rows, menus, dialogs, the
     machines' list), `--surface-bar` (the toolbar, the status bar), `--screen-bg`, `--screen-overlay`, `--backdrop`;
     `--border`;
   - text `--text`, `--text-dim`, `--accent`;
   - a control's states `--hover-bg`, `--pressed-bg`, `--pressed-border`; the main button `--primary-bg`,
     `--primary-border`, `--primary-fg`; the destructive one `--danger-bg`, `--danger-border`, `--danger-fg`;
   - tones: words `--ok-fg`, `--warn-fg`, `--error-fg`; the bars that carry one `--warn-bar-fg`, `--warn-bg`,
     `--warn-border`, `--error-bar-fg`, `--error-bg`, `--error-border`; a state's light `--status-ok`, `--status-busy`,
     `--status-bad`, `--status-off`;
   - a block map's looks `--map-*` (`--map-empty`, `--map-absent`, `--map-opaque`, `--map-rim-1..4`, `--map-core-1..4`,
     `--map-hollow`, `--map-tick`, `--map-read`, `--map-write`, `--map-end`, `--map-pin`: BlockGrid's canvas reads them);
   - shadows `--shadow-menu`, `--shadow-dialog`, `--shadow-rule` (a hairline under tabs), `--shadow-focus`,
     `--shadow-frame`;
   - fonts `--font`, `--font-mono`, `--line-height`; weights `--weight-normal`, `--weight-bold`;
   - heights `--control-h` (a button, a field: 28 px), `--tool-h` (a toolbar button: 32 px).
3. **A small scale.** Spacing: `--space-1` to `--space-6` (2, 4, 8, 12, 16, 24 px). Text: `--text-xs` (11),
   `--text-sm` (12: notes, small lines), `--text-md` (13: a dialog's explanation, a compact row), `--text-base` (14: the
   page's words), `--text-lg` (16: titles). Radii: `--radius-sm` (4), `--radius` (6), `--radius-lg` (8). Reach for the
   nearest step rather than a new size; a new step needs a reason.
4. **index.html holds no component styles.** The global layer is `theme/tokens.css` (the tokens) and `theme/base.css`
   (the reset, element defaults, `.sr`); `index.html` links both and keeps only the few rules of its own fallback (the
   page saying its scripts didn't load). The rest belongs to the component that renders it.
5. **Reaching for a new step is a design smell.** A screen that seems to need a smaller font, a tighter gap or a
   one-off size is usually too dense: split it (more panes, tabs or wizard steps, a details disclosure) before adding
   a token. Consistency and usability come before fitting everything on one screen.

## 2. Components: small, reused, owning their own styles

1. **A pattern seen twice becomes a component.** The primitives are in `web/app/ui/`, each with a header that says
   what it's for:
   - `Button`: `variant` `bordered` (the default), `plain`, `primary`, `danger`, `tool` (`labelled`), `item` (a menu's
     command), `link` (words that read as a link), `inline` (an icon inside a field's frame); `icon`; `tone` `warn` (words and icon in the warning colour); the rest of its props go on the `<button>`, `ref` binds it.
   - `Card` in a `CardList`: the bordered rows of the panes and dialogs (the main column, `actions` beside it;
     `empty` for the list's empty line).
   - `Note`: fine print, `tone` `dim`/`warn`/`error`/`ok`, `size` `sm`/`md`, `inline` for a row's small line.
   - `Field` in `Fields`: a label, its control, a button beside it (`after`), a note; in a `Fields` grid the rows line
     up, elsewhere the label sits over the control.
   - `Slider`: a number on a slider, notches under it at the suggested values (a pointer snaps to one nearby), the
     value in words beside it (a machine's vCPUs, RAM, JIT cache).
   - `Check`, `Radio`: a checkbox or a radio button and its words (`ref` binds Check's box).
   - `Choice`: a wizard's big choice button (`label`, `icon`, `pressed`, a dim line).
   - `Step`: a wizard's step (a column, hidden unless `active`); `Steps`: numbered steps to follow; `Disclosure`: more
     of a form folded under a small line (Advanced).
   - `ErrorBanner`: the dismissible error, warning or notice bar, across the page or floating, with a notice's countdown (the message bar, the Home page's error).
   - `StatusDot`: a state's light.
   - `NameInput`: a row's name, edited where it is (a connection's, a folder's).
   - `ValueField`: a value to copy or a secret to show, its Copy and Show icons inside the field (an address, a key, a
     link, a command; a pasted secret).
   - `BlockGrid`: a block map on a canvas (a defragmenter's squares: per cell a rim, a core inset in it, a flash, and
     a `tick`, a static mark of its own along its bottom edge, half or whole width (`TICK`: the disk surface's "kept
     in this browser"); its room reported, hover and pick, a keyboard's cursor); `BlockSwatch` (a `tick` too): a
     legend's cell drawn the same way, its words beside it (`block-grid.ts` the looks and the layout, `block-draw.ts` the drawing).
   - `FloatingWindow`: a window over the page (the disk's surface, the on-screen keyboard), moved by its title bar,
     resized by its corner, or with `aspect` (its height for a width) by its width alone from a ↔ in the bar; kept in
     the window and remembered under a settings key, a size per shape (`sizeKey`: the keyboard's layouts;
     `floating-frame.svelte.ts`); a click on it leaves the focus where it was. `tool`: a tool's slim bar, see-through,
     nothing in it taking the focus.
   - `Modal` (a dialog's shell), `Pane` (a pane of the Home page), `Menu` (a toolbar menu; `variant="bordered"` for one among a pane's or a card's buttons, a disk's Export), `Icon`.

   Use a primitive instead of restyling an element; extend it (a prop, a variant) instead of copying it.
2. **Styles reach only the component's own markup.** No `:global(...)` into children, and no parent styling a child's
   insides. A parent places a child (its own wrapper) and can pass a CSS custom property the child reads
   (`--card-bg`); `class` on a primitive is a test's hook. A primitive that must style what it's given says so in its
   header and keeps it to layout (`Fields` spans its other children over the grid's row). Content passed as a snippet
   is the parent's markup: the parent's styles reach it. `:global` is for state outside any component
   (`body[data-view]`, `body:fullscreen`) qualifying the component's own elements, and for a library's markup.
3. **Size.** A component over ~250 lines (script and markup), or with more than one screen's worth of unrelated
   state, is split: one component per pane, tab and wizard step. A page composes; it doesn't implement every tab.
4. **Markup is markup.** No chained ternaries (more than one `?`) or multi-step computations in a template: name them
   in the script (`$derived`, a function, a `Record<Kind, …>` table). Markup is formatted by the formatter (one
   element per line once it has more than a few attributes); no 300-character lines.
5. **Typed props.** Every component declares `type Props`; callbacks are `onX`; `$bindable` only where two-way
   binding is the point. Shared content goes through snippets.
6. **Every `{#each}` has a key.**

## 3. State and reactivity

1. **One source of truth, reactive.** State that the page shows lives in `$state`, in a class or module of its area
   (`web/app/areas/*.svelte.ts`), and is read directly. No plain `let` mirrored into an area by hand (`sync*()`), no
   change counters (`tick`, `n++`) and no `(void tick, value())` reads to force a redraw. State kept in a plain class
   (the live network, a DOM-free class the tests run in Node) tracks its reads with `changes.ts` `Changes`
   (`createSubscriber`); state the page reads from elsewhere (IndexedDB, Web Locks) is read into `$state` by a store
   that reads again on a change (`areas/records.svelte.ts`).
2. **State is split by area.** Not one global bag: `power`, `messageBar`, `current`, `network`, `usb`, `shares`,
   `clipboard`, `status`… each its own state object in `web/app/areas/`. A component takes what it needs as props, or
   imports its area's.
3. **Commands are calls, not state.** To open a menu or a wizard, call a function (`network.openMenu()`): the component
   that owns it answers its `Command` (`command.ts`) while mounted; an event a component follows is a listener it adds
   in an `$effect` (`keys.typed.on(f)`). Don't bump a counter for an `$effect` to notice.
4. **`$derived` for what follows from state; `$effect` only to touch the outside** (the DOM, timers, subscriptions),
   always returning its cleanup. An `$effect` that writes `$state` is almost always a `$derived`.
5. **`page` is complete before the components mount**: no `{} as Page` filled in later.

## 4. The DOM

1. **Components own the DOM.** TypeScript outside components doesn't query, replace or mutate rendered elements, or
   keep values in `dataset`. Elements come from `bind:this`, an action (`use:`) or a callback.
2. **No `document.getElementById`/`querySelector` in components** to reach their own or another component's elements:
   `bind:this`, an exported method (`picker.open()`), an action (`use:autofocus`).
3. **Global listeners** (`keydown`, `paste`, `drop`, `fullscreenchange`, `beforeunload`) are `<svelte:window>` /
   `<svelte:document>` in the component that handles them, calling its area's functions.
4. **Test hooks are a contract.** The `id`s and `data-*` attributes tests and tools use stay, or the tests change in
   the same commit. New hooks are semantic `data-*` (`data-action`, `data-field`), not classes.

## 5. TypeScript

1. **`main.ts` is the composition root**: it builds the areas and mounts the page. Each area is its own module with its
   own state and its `page` actions: the run in `web/app/run/` (`page-machine.svelte.ts`, the page's machine every
   area is given; `runner.ts`, `power-actions.ts`, `size-actions.ts`, `memory-signal.ts`), the others in `web/app/areas/`
   (`screen-view.ts`, `serial-terminal.ts`, `page-window.ts`, `disk-actions.ts`, `disk-changes.ts`, `disk-export.ts`,
   `snapshot-actions.ts`, `snapshot-restore.ts`, `network-actions.ts`, `usb-actions.ts`, `usb-attach.ts`,
   `folder-actions.ts`, `clipboard-actions.ts`, `keys-actions.ts`). An area's module is a class given what it takes
   in its constructor (a later one as a function called once all are built), not module globals. No new top-level
   code in `main.ts`.
2. **No god functions.** A function over ~80 lines, or a message handler with more than a few branches, is split
   (a handler table keyed by the message's `type`).
3. **Parse at the edge, once.** URL parameters and knobs are parsed into one typed object; no `params.get` scattered
   through the code, no `slice(N)` offsets.
4. **Few casts and `!`.** Prefer narrowing, discriminated unions and types that state the invariant. Browser APIs
   missing from `lib.dom` go in one ambient `.d.ts`; test and bench hooks in one typed module (`declare global`), not
   `window as unknown as {...}` inline.
5. **Name what's repeated.** A predicate or a union used twice gets a name (`isLive(state)`, `type MessageKind`);
   a flow used twice (a resource held by another tab: confirm, take) is one function.
6. **Errors reach the user or say why not.** Async actions return their promise; components run them through one
   shared helper (`actions.svelte.ts` `Actions`: busy state, the error as the page shows errors, `ErrorWords.svelte`),
   or, from a control with no place for an error (the toolbar, a menu, a file picker), through `page.ts` `inBar` (the
   message bar's runner). `catch {}` and `.catch(() => {})` carry a comment
   saying why ignoring is right. The page has an `unhandledrejection` handler that shows what escapes.
7. **`??` for defaults**, not `||`, unless `0` and `''` really mean "absent".

## 6. Working on it

- Use the Svelte plugin's tools when writing components (`.claude/settings.json` enables it): its
  `svelte-core-bestpractices` and `svelte-code-writer` skills, and its MCP server's documentation and autofixer.
- Look at what you changed: a UI change is checked in headless Chromium (a screenshot of the pane or dialog), not
  only by tests.

## 7. Enforcement

`npm run lint` (a step of `scripts/ci.sh`, beside svelte-check; ~10 s) runs the three over `web/app/`, from the
TypeScript 6 package `tools/lint` ([frontend.md](frontend.md) "Types"); `npm run format` rewrites what Prettier would.

- **ESLint** (`tools/lint/eslint.config.ts`, flat config; `npm run lint:eslint`) with `typescript-eslint`'s
  `strictTypeChecked` and `stylisticTypeChecked` and `eslint-plugin-svelte`'s recommended set, over `web/app/` (not
  `web/*.ts` or the core), typed through `tsconfig.svelte.json`. Besides the sets: `max-lines` 300 (blank lines and
  comments not counted), `max-lines-per-function` 80, `complexity` 15, `no-empty` (a catch too: a comment inside says
  why), `no-non-null-assertion`, `consistent-type-assertions`, `no-floating-promises`, `no-misused-promises`,
  `prefer-nullish-coalescing`, `svelte/require-each-key`, `svelte/no-dom-manipulating`, `svelte/no-at-html-tags`,
  and in components `document.getElementById` (`no-restricted-properties`) and `querySelector`/`querySelectorAll`
  (`no-restricted-syntax`). `no-empty-function` (in the sets) wants a comment in a `.catch(() => {})`. Tuned out as
  taste that fights the code's style: `consistent-type-definitions` (`type X = {…}` is how the code writes object
  types), `consistent-indexed-object-style`, `no-confusing-void-expression` (`() => f()` and `return f()` out of a
  function that returns nothing), `restrict-template-expressions` allows numbers and booleans, and `no-unused-vars`
  ignores a key dropped by a rest (`const { id: _, ...rest } = x`). The typed lint sees another component only as
  `svelte.d.ts`'s `Component`: a callback prop is a property (`close: () => void`, not `close(): void`), a markup
  callback's parameters are typed (`onchange={(on: boolean) => …}`), and a bound dialog is a `ui/dialog.ts` `Dialog`.
- **Stylelint** (`tools/lint/stylelint.config.ts`, `npm run lint:style`) over the `<style>` of `web/app/**/*.svelte`
  and `web/app/index.html` (`postcss-html`) and over `web/app/theme/*.css`: `stylelint-config-recommended`'s correctness rules (duplicate selectors
  and properties, unknown properties, units and pseudo-classes, invalid values…; `:global` allowed,
  `no-descending-specificity` off), and `stylelint-declaration-strict-value` with the tokens' rule (`TOKENS` in the
  config: colors, `font-size`, `font-weight`, `border-radius`, `gap`, `padding`, `margin` and `box-shadow` take a
  `var(--…)`, a `calc()` over tokens or an allowed literal, §1).
- **Prettier** (`tools/lint/prettier.config.ts` with `prettier-plugin-svelte`: 120 columns, single quotes; `npm run
  lint:format` checks, `npm run format` writes) formats `web/app/**/*.{svelte,ts}`. The commit that formatted it
  first is in `.git-blame-ignore-revs` (`git config blame.ignoreRevsFile .git-blame-ignore-revs`). A comment that must
  stay on its line (`// i18n-ignore`) goes at the end of the line Prettier keeps, or as `// i18n-ignore-next` on the
  line before; in markup, as a comment inside the tag before the attribute (Svelte allows `//` there).
- **Suppressions:** what ESLint finds that predates the rules is grandfathered in `tools/lint/eslint-suppressions.json`
  (counts per file and rule; ESLint's bulk suppressions). It only shrinks: a new violation fails the lint, and so does
  a suppression no longer used. After a fix, `npm run lint:eslint -- --prune-suppressions` lowers the counts (commit
  the file with the fix). Never `--suppress-all` or `--suppress-rule` to let new code in: fix it, or, where a rule is
  wrong at one place, an `// eslint-disable-next-line <rule> -- why` there.
