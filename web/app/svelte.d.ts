// The page's Svelte components, for the TypeScript that imports them (tools/svelte.ts compiles them; tsc doesn't read them).
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component<Record<string, unknown>>;
  export default component;
}
