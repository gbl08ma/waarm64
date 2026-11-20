// The introduction (docs/frontend.md "The introduction"; web/app/IntroPage.svelte): whether it shows. It takes the
// whole window, over the machine, Home and the demo store's page alike, without the toolbar or the status bar; those
// come in when it's left. web/app/areas/page-window.ts opens and closes it (`page.openIntro`).
class Intro {
  /** The introduction shows instead of everything else on the page. */
  open = $state(false);
}
export const intro = new Intro();
