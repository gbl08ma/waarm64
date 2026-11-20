<!--
  The introduction's first screen (web/app/IntroPage.svelte): what waarm64 is in a headline and two paragraphs, the way
  to the demos, and beside them a small machine running (IntroGuest.svelte: a guest that boots by itself when the page
  opens), or where that can't run, the machine's plate (IntroPlate.svelte).
-->
<script lang="ts">
  import Button from '../ui/Button.svelte';
  import IntroGuest from './IntroGuest.svelte';
  import T from '../T.svelte';
  import { t } from '../../i18n.ts';

  type Props = { ondemos: () => void; onhow: () => void };
  let { ondemos, onhow }: Props = $props();
</script>

<section class="hero" aria-labelledby="intro-headline">
  <div class="words">
    <h1 id="intro-headline">{t('intro:IntroHero.headline')}</h1>
    <p class="lede"><T k="intro:IntroHero.lede" /></p>
    <p><T k="intro:IntroHero.speed" /></p>
    <div class="actions">
      <Button variant="primary" onclick={ondemos} data-action="intro-demos">{t('intro:IntroHero.demos')}</Button>
      <Button onclick={onhow} data-action="intro-how">{t('intro:IntroHero.how')}</Button>
    </div>
  </div>
  <IntroGuest />
</section>

<style>
  .hero {
    display: grid;
    /* The frame's own width (its screen's 512 pixels and its edges) where the window has it. */
    grid-template-columns: minmax(0, 1fr) minmax(280px, 538px);
    align-items: center;
    gap: var(--space-8);
    max-width: 1240px;
    margin: 0 auto;
    padding: var(--space-8) var(--space-6);
  }
  .words {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: 640px;
  }
  h1 {
    margin: 0;
    font-size: var(--text-display);
    font-weight: var(--weight-bold);
    line-height: var(--line-height-tight);
    text-wrap: balance;
  }
  p {
    margin: 0;
    color: var(--text-dim);
    font-size: var(--text-lg);
  }
  .lede {
    color: var(--text);
    font-size: var(--text-lede);
  }
  /* The one action of the screen, a key of its own height. */
  .actions {
    --control-h: 40px;
    display: flex;
    gap: var(--space-4);
    margin-top: var(--space-4);
    font-size: var(--text-lg);
  }
  @media (max-width: 900px) {
    .hero {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-7);
      padding: var(--space-7) var(--space-5);
    }
  }
</style>
