// The guest's graphical session as its agent says it (DESKTOP: `body[data-desktop]`, web/app/areas/agent-actions.ts;
// docs/devices.md "The desktop's state"), for the Debian page tests' waits: its value now, and each value it took since
// `recordDesktop` (a down between two ups is too short to catch by polling).
import type { Page } from 'playwright-core';

type Recorded = { __desktops: (string | undefined)[] };

/** Starts recording `body[data-desktop]`'s values (`desktops`), from the one it has now. */
export const recordDesktop = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as Recorded;
    w.__desktops = [document.body.dataset.desktop];
    new MutationObserver(() => w.__desktops.push(document.body.dataset.desktop)).observe(document.body, { attributes: true, attributeFilter: ['data-desktop'] });
  });

/** `body[data-desktop]` now: `none`, `wayland`, `x11`, or undefined (no agent). */
export const desktopNow = (page: Page) => page.evaluate(() => document.body.dataset.desktop);

/** The values `body[data-desktop]` took since `recordDesktop`. */
export const desktops = (page: Page) => page.evaluate(() => (window as unknown as Recorded).__desktops);
