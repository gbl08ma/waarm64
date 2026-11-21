<!--
  The introduction's call to the demos (web/app/IntroPage.svelte): the way into the demo store, and for a visitor who
  has machines in this browser the way to them. Twice on the page: whole, after "How it works" and before the long
  account of how it was made, so that it isn't far down; and small (`foot`) at the page's very end, with the way to
  the source code and waarm64's license in a line.
-->
<script lang="ts">
  import about from 'virtual:waarm64-about';
  import Button from '../ui/Button.svelte';
  import T from '../T.svelte';
  import { t } from '../../i18n.ts';

  type Props = { ondemos: () => void; onhome: () => void; machines: number; foot?: boolean };
  let { ondemos, onhome, machines, foot = false }: Props = $props();
  const repo = about.repository.replace(/\.git$/, '');
  /** A link to another site: opened apart from the page, and told nothing of it. */
  const EXTERNAL = { target: '_blank', rel: 'external noopener noreferrer' };
</script>

{#if foot}
  <footer data-intro-foot>
    <div class="again">
      <span class="title">{t('intro:IntroEnd.title')}</span>
      <Button variant="primary" onclick={ondemos} data-action="intro-foot-demos">{t('intro:IntroEnd.demos')}</Button>
      {#if machines > 0}
        <Button onclick={onhome} data-action="intro-foot-home">{t('intro:IntroEnd.home')}</Button>
      {/if}
    </div>
    <p class="fine">
      <a href={repo} {...EXTERNAL} data-action="intro-source">{t('intro:IntroEnd.source')}</a>
      <span data-field="license">{t('intro:IntroEnd.license')}</span>
    </p>
  </footer>
{:else}
  <section aria-labelledby="intro-end" data-intro-end>
    <h2 id="intro-end">{t('intro:IntroEnd.title')}</h2>
    <p><T k="intro:IntroEnd.words" /></p>
    <div class="actions">
      <Button variant="primary" onclick={ondemos} data-action="intro-end-demos">{t('intro:IntroEnd.demos')}</Button>
      {#if machines > 0}
        <Button onclick={onhome} data-action="intro-end-home">{t('intro:IntroEnd.home')}</Button>
      {/if}
    </div>
  </section>
{/if}

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
  /* The page's last lines: the call again, small, and under it the source and the license. */
  footer {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-7) var(--space-6);
    border-top: 1px solid var(--border);
    text-align: center;
  }
  .again {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
  }
  .title {
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
  }
  .fine {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2) var(--space-5);
    font-size: var(--text-sm);
  }
</style>
