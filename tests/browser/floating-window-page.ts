// The floating window's frame (web/app/ui/FloatingWindow.svelte) with a height that follows its width, in two shapes,
// and as a tool's: what tests/floating-window.test.ts drives. `?tool=1` makes it a tool window.
import { mount } from 'svelte';
import Demo from './FloatingWindowDemo.svelte';

mount(Demo, { target: document.body });
