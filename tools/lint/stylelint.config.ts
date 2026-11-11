// Stylelint over the page's styles (the `<style>` of web/app/**/*.svelte through postcss-html, and the theme's CSS;
// docs/frontend-code.md §7): stylelint-config-recommended's correctness rules (no duplicate selectors or properties,
// no unknown properties, units or pseudo-classes, no invalid values…), and the rule that values come from the tokens.
import type { Config } from 'stylelint';

/**
 * Tokens only (docs/frontend-code.md §1): colors, sizes of text, weights, radii, gaps, paddings, margins and shadows
 * take a `var(--…)`. The literals the rules allow pass as they are.
 */
const TOKENS: [string[], Record<string, unknown>] = [
  ['/color$/', 'fill', 'stroke', 'background', 'font-size', 'font-weight', 'border-radius', 'gap', 'row-gap', 'column-gap', '/^padding/', '/^margin/', 'box-shadow'],
  {
    ignoreValues: ['0', 'inherit', 'initial', 'unset', 'currentColor', 'transparent', 'none', 'auto', '1px', '50%', '999px', '/^-?var\\(/'],
    expandShorthand: true,
    disableFix: true,
  },
];

const config: Config = {
  extends: ['stylelint-config-recommended'],
  plugins: ['stylelint-declaration-strict-value'],
  overrides: [{ files: ['**/*.svelte', '**/*.html'], customSyntax: 'postcss-html' }],
  rules: {
    // Source order against specificity across a sheet's unrelated rules: noise in a component's small scoped sheet.
    'no-descending-specificity': null,
    // Svelte's scoping: `:global(…)`.
    'selector-pseudo-class-no-unknown': [true, { ignorePseudoClasses: ['global'] }],
    // Off until the tokens exist (web/app/theme/tokens.css): phase 1b of the frontend refactor turns it on as
    // `'scale-unlimited/declaration-strict-value': TOKENS`.
    'scale-unlimited/declaration-strict-value': null,
  },
};
export { TOKENS };
export default config;
