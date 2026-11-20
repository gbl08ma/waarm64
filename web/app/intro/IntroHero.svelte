<!--
  The introduction's first screen (web/app/IntroPage.svelte): what waarm64 is in a headline and two paragraphs, the way
  to the demos, and beside them the machine's plate (IntroPlate.svelte). The plate's place is where the live preview
  goes (a small guest booting by itself: INTRO-KICKOFF.md, loops 1 and 2); the plate is what shows where that can't
  run.
-->
<script lang="ts">
  import Button from '../ui/Button.svelte';
  import IntroPlate from './IntroPlate.svelte';
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
  <IntroPlate />
</section>

<style>
  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(280px, 0.85fr);
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
      grid-template-columns: 1fr;
      gap: var(--space-7);
      padding: var(--space-7) var(--space-5);
    }
  }
</style>
