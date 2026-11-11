# The page's code: rules of thumb

Rules for `web/app/` (the page: Svelte components, `.svelte.ts` state, the
controller and its helpers). Not for `web/*.ts` (the devices, workers and renderers) or the core, where performance
rules. Follow a rule unless there is a good reason not to; when you break one, say why in a comment where it's broken.
The linters (§7) enforce what can be checked mechanically; the rest is for review.

## 1. Look: one design system

1. **Tokens only.** Colors, spacing, font sizes and weights, radii, shadows and control heights come from the tokens in
   `web/app/theme/tokens.css`, never as literals in a component. A missing value becomes a new token; it doesn't go
   into one component as a literal. Allowed literals: `0`, `1px` borders and hairlines, `50%`/`999px` for round
   shapes, layout widths of one component (`minmax(200px, 260px)`), icon sizes passed to `<Icon>`.
2. **Semantic tokens, not raw palette.** Name a token by its role (`--surface`, `--surface-raised`, `--border`,
   `--text-dim`, `--accent`, `--warn-fg`, `--danger-bg`, `--primary-bg`…), so a re-theme changes one file.
3. **A small scale.** Spacing: `--space-1` to `--space-6` (2, 4, 8, 12, 16, 24 px). Text: `--text-xs` to `--text-lg`
   (11, 12, 13, 14, 16). Radii: `--radius-sm` (4), `--radius` (6), `--radius-lg` (8). Reach for the nearest step
   rather than a new size; a new step needs a reason.
5. **Reaching for a new step is a design smell.** A screen that seems to need a smaller font, a tighter gap or a
   one-off size is usually too dense: split it (more panes, tabs or wizard steps, a details disclosure) before adding
   a token. Consistency and usability come before fitting everything on one screen.
4. **index.html holds no component styles.** The global layer is `theme/tokens.css` (the tokens) and `theme/base.css`
   (the reset, element defaults, `.sr`). The rest belongs to the component that renders it.

## 2. Components: small, reused, owning their own styles

1. **A pattern seen twice becomes a component.** The primitives: `Button` (variants `plain`, `tool`, `bordered`,
   `primary`, `danger`; an `icon`), `Card`/`CardList` (the bordered rows of the panes and dialogs), `Note` (tones
   `dim`, `warn`, `error`), `Field` (a label, its control, its note: lines up in a settings grid), `ErrorBanner`
   (dismissible), `StatusDot`, `Choice` (a wizard's choice), and those that exist: `Check`, `Modal`, `Pane`, `Menu`,
   `Icon`. Use a primitive instead of restyling an element; extend it instead of copying it.
2. **Styles reach only the component's own markup.** No `:global(...)` into children, and no parent styling a child's
   insides. A parent places a child (its own wrapper, or a `class` prop the child applies to its root) and nothing
   more. A primitive that must style what it's given (`Modal`'s body) says so in its header and keeps it to layout.
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
   (`*.svelte.ts`), and is read directly. No plain `let` mirrored into `ui` by hand (`sync*()`), no change counters
   (`tick`, `ui.net++`) and no `(void tick, value())` reads to force a redraw.
2. **`ui` is split by area.** Not one global bag: the machine's run state, the message bar, network, USB, folders,
   clipboard, status bar… each its own state object. A component takes what it needs as props, or imports its area's.
3. **Commands are calls, not state.** To open a menu or a wizard, call a function (`network.openMenu()`); don't bump a
   counter for an `$effect` to notice.
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

1. **`main.ts` is the composition root**: it builds the areas and mounts the page. Each area (screen, run, disks,
   snapshots, network, USB, folders, clipboard) is its own module with its own state and its `page` actions. No new
   top-level code in `main.ts`.
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
   shared helper (busy state, the error as the page shows errors). `catch {}` and `.catch(() => {})` carry a comment
   saying why ignoring is right. The page has an `unhandledrejection` handler that shows what escapes.
7. **`??` for defaults**, not `||`, unless `0` and `''` really mean "absent".

## 6. Working on it

- Use the Svelte plugin's tools when writing components (`.claude/settings.json` enables it): its
  `svelte-core-bestpractices` and `svelte-code-writer` skills, and its MCP server's documentation and autofixer.
- Look at what you changed: a UI change is checked in headless Chromium (a screenshot of the pane or dialog), not
  only by tests.

## 7. Enforcement

- **ESLint** (flat config) with `typescript-eslint` (strict, type-checked) and `eslint-plugin-svelte`, over
  `web/app/`. Among the rules: `no-non-null-assertion`, `consistent-type-assertions`, `no-misused-promises`,
  `no-floating-promises`, `prefer-nullish-coalescing`, `no-empty`, `max-lines`, `max-lines-per-function`,
  `complexity`, `svelte/require-each-key`, `svelte/no-dom-manipulating`, `svelte/no-at-html-tags`, and a restricted
  syntax rule for `getElementById`/`querySelector` in components.
- **Stylelint** (with `postcss-html` for `.svelte`) and a strict-value rule: colors, `font-size`, `font-weight`,
  `border-radius`, `gap`, `padding`, `margin` and `box-shadow` take tokens.
- **Prettier** with `prettier-plugin-svelte` formats `web/app/` (`--check` in CI).
- What doesn't pass yet is grandfathered in ESLint's suppressions file and shrinks as code is refactored; it never
  grows.
