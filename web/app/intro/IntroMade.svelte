<!--
  The introduction's "How it was made" (web/app/IntroPage.svelte), under "How it works": who made waarm64 and how, in
  the author's own first person (the user's words of 2026-11-20, set down here: one person, two months of spare time
  steering AI agents, which wrote the code), what they knew and learned, whose work it stands on (the open-source projects, with a button
  to the credits in Home's About pane), and why they made it; signed with their handle, a link to their website. Its
  words follow that website's voice (the user asked: long sentences, parentheses, a spaced hyphen, dry humor). A disclosure: nothing
  here is a figure of ours to measure.
-->
<script lang="ts">
  import Button from '../ui/Button.svelte';
  import IntroSection from './IntroSection.svelte';
  import T from '../T.svelte';
  import { t } from '../../i18n.ts';

  type Props = { ref?: HTMLElement; onabout: () => void };
  let { ref = $bindable(), onabout }: Props = $props();

  /** Who signs it: the author's handle and their own website (a name and an address, not words of the catalog). */
  const AUTHOR = { name: 'gbl08ma', url: 'https://gbl08ma.com' }; // i18n-ignore
  /** A link to another site: opened apart from the page, and told nothing of it. */
  const EXTERNAL = { target: '_blank', rel: 'external noopener noreferrer' };

  /** A part of the account: its title and its paragraph (the catalog's keys, written out for i18n-check). */
  const PARTS = [
    ['intro:IntroMade.who', 'intro:IntroMade.who.words'],
    ['intro:IntroMade.code', 'intro:IntroMade.code.words'],
    ['intro:IntroMade.cost', 'intro:IntroMade.cost.words'],
    ['intro:IntroMade.time', 'intro:IntroMade.time.words'],
    ['intro:IntroMade.knew', 'intro:IntroMade.knew.words'],
    ['intro:IntroMade.learned', 'intro:IntroMade.learned.words'],
  ] as const;
  /** Why it was made, a line a reason. */
  const WHY = [
    'intro:IntroMade.why.llm',
    'intro:IntroMade.why.browser',
    'intro:IntroMade.why.upstream',
    'intro:IntroMade.why.web',
  ] as const;
</script>

<IntroSection id="intro-made" title={t('intro:IntroMade.title')} ground="raised" bind:ref>
  {#snippet lede()}<T k="intro:IntroMade.lede" />{/snippet}
  <dl>
    {#each PARTS as [part, words] (part)}
      <div>
        <dt>{t(part)}</dt>
        <dd>{t(words)}</dd>
      </div>
    {/each}
  </dl>
  <!-- Whose work it stands on, and the way to the credits (Home's About pane). -->
  <div class="thanks">
    <h3>{t('intro:IntroMade.thanks')}</h3>
    <p>{t('intro:IntroMade.thanks.words')}</p>
    <div><Button onclick={onabout} data-action="intro-about">{t('intro:IntroMade.thanks.about')}</Button></div>
  </div>
  <div class="why">
    <h3>{t('intro:IntroMade.why')}</h3>
    <ol>
      {#each WHY as reason (reason)}
        <li>{t(reason)}</li>
      {/each}
    </ol>
  </div>
  <p class="signed">- <a href={AUTHOR.url} {...EXTERNAL} data-action="intro-author">{AUTHOR.name}</a></p>
</IntroSection>

<style>
  /* The account's six parts: a sheet's entries, a seam over each, three across and two down where the window has the
     room (then two across, then one). */
  dl {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0 var(--space-7);
    margin: 0;
  }
  dl div {
    padding: var(--space-5) 0;
    border-top: 1px solid var(--border);
    box-shadow: var(--card-edge);
  }
  dt {
    margin-bottom: var(--space-2);
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
  }
  dd {
    margin: 0;
    color: var(--text-dim);
  }
  @media (max-width: 1000px) {
    dl {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 640px) {
    dl {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .thanks,
  .why {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    max-width: 760px;
  }
  h3 {
    margin: 0;
    font-size: var(--text-lg);
  }
  .thanks p {
    margin: 0;
    color: var(--text-dim);
    font-size: var(--text-lg);
  }
  /* The signature, at the account's end. */
  .signed {
    margin: 0;
    font-size: var(--text-lg);
  }
  ol {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding-left: var(--space-6);
    color: var(--text-dim);
    font-size: var(--text-lg);
  }
</style>
