// The page's Svelte components, for the TypeScript that imports them (Vite's Svelte plugin compiles them; tsc doesn't read them,
// svelte-check checks their types: `npm run svelte-check`, tsconfig.svelte.json).
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component<Record<string, unknown>>;
  export default component;
}
