// The block map (web/app/ui/BlockGrid.svelte) in a floating window (web/app/ui/FloatingWindow.svelte) with made-up
// data, no guest: what tests/block-grid.test.ts drives, and a page to look at them (`npm run serve`, then
// /tests/browser/block-grid.html). `?cells=N` shows N cells (by default as many as the grid has room for), `?flash=0`
// none of the flashes. `window.__grid` has what the grid reported and lets the test send another flash.
import { mount } from 'svelte';
import Demo from './BlockGridDemo.svelte';

mount(Demo, { target: document.body });
