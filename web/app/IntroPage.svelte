<!--
  The introduction (docs/frontend.md "The introduction"; docs/decisions.md "Demos"): what a visitor without machines
  sees first, and what About's button shows again. It takes the whole window, one page scrolled from top to bottom:
  a bar of its own (the wordmark, the ways to its sections, Skip), what waarm64 is, and at its end the way into the
  demo store. Leaving it (Skip, a button to the demos) brings the toolbar and the status bar in
  (web/app/view-transition.ts). Its words are the catalog's `intro` area, in a voice of their own (docs/copy.md "The
  introduction").
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import IntroEnd from './intro/IntroEnd.svelte';
  import IntroHero from './intro/IntroHero.svelte';
  import WordmarkLetters from './WordmarkLetters.svelte';
  import { afterIntro } from './intro-route.ts';
  import { records } from './areas/records.svelte.ts';
  import { page } from './page.ts';
  import { t } from '../i18n.ts';

  /** Where Skip leads, said on the button: the demos, or the machines of a visitor who has some. */
  const skipTo = $derived(afterIntro(records.machines.length));
  const toDemos = () => void page.closeIntro('demos');
</script>

<div class="intro" data-intro>
  <header>
    <div class="wordmark" aria-label={t('toolbar:Wordmark.name')}><WordmarkLetters /></div>
    <Button variant="plain" onclick={() => void page.closeIntro()} data-action="skip-intro" data-to={skipTo}>
      {skipTo === 'home' ? t('intro:IntroPage.skip.home') : t('intro:IntroPage.skip')}
    </Button>
  </header>
  <IntroHero ondemos={toDemos} />
  <IntroEnd ondemos={toDemos} machines={records.machines.length} onhome={() => void page.closeIntro()} />
</div>

<style>
  /* The window's whole height, scrolled: the bar stays at its top. */
  .intro {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--surface);
  }
  /* The toolbar's ground and height, so the toolbar takes its place without a jump when the introduction is left. */
  header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    min-height: calc(var(--tool-h) + 2 * var(--space-2) + 1px);
    padding: var(--space-2) var(--space-3);
    background: var(--toolbar-bg);
    border-bottom: 1px solid var(--border);
    box-shadow: var(--toolbar-edge);
  }
  :global(html[data-vt='intro']) header {
    view-transition-name: page-bar;
  }
  .wordmark {
    margin: 0 var(--space-3) 0 var(--space-2);
    font-size: var(--bar-text-lg);
    font-weight: var(--weight-bold);
    color: var(--text);
  }
</style>
