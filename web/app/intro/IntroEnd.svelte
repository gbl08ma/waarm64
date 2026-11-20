<!--
  The introduction's end (web/app/IntroPage.svelte): the way into the demo store, where it finishes, and for a
  visitor who has machines in this browser the way to them.
-->
<script lang="ts">
  import Button from '../ui/Button.svelte';
  import T from '../T.svelte';
  import { t } from '../../i18n.ts';

  type Props = { ondemos: () => void; onhome: () => void; machines: number };
  let { ondemos, onhome, machines }: Props = $props();
</script>

<section aria-labelledby="intro-end">
  <h2 id="intro-end">{t('intro:IntroEnd.title')}</h2>
  <p><T k="intro:IntroEnd.words" /></p>
  <div class="actions">
    <Button variant="primary" onclick={ondemos} data-action="intro-end-demos">{t('intro:IntroEnd.demos')}</Button>
    {#if machines > 0}
      <Button onclick={onhome} data-action="intro-end-home">{t('intro:IntroEnd.home')}</Button>
    {/if}
  </div>
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-5);
    padding: var(--space-8) var(--space-6);
    border-top: 1px solid var(--border);
    background: var(--surface-raised);
    box-shadow: var(--card-edge);
    text-align: center;
  }
  h2 {
    margin: 0;
    font-size: var(--text-title);
    line-height: var(--line-height-tight);
  }
  p {
    margin: 0;
    max-width: 620px;
    color: var(--text-dim);
    font-size: var(--text-lg);
  }
  .actions {
    --control-h: 40px;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-4);
    font-size: var(--text-lg);
  }
</style>
