<!--
  The introduction's "what runs on it" (web/app/IntroPage.svelte): four figures as readouts (IntroReadout.svelte), then
  what else the machine does, a short paragraph a topic. Every figure and claim is docs/comparison.md §2's.
-->
<script lang="ts">
  import IntroReadout from './IntroReadout.svelte';
  import IntroSection from './IntroSection.svelte';
  import T from '../T.svelte';
  import { t } from '../../i18n.ts';

  type Props = { ref?: HTMLElement };
  let { ref = $bindable() }: Props = $props();

  /** A readout: its figure, what it counts, the sentence behind it (the catalog's keys, written out for i18n-check). */
  const READOUTS = [
    ['intro:IntroFacts.cores', 'intro:IntroFacts.cores.counts', 'intro:IntroFacts.cores.words'],
    ['intro:IntroFacts.ram', 'intro:IntroFacts.ram.counts', 'intro:IntroFacts.ram.words'],
    ['intro:IntroFacts.tests', 'intro:IntroFacts.tests.counts', 'intro:IntroFacts.tests.words'],
    ['intro:IntroFacts.drivers', 'intro:IntroFacts.drivers.counts', 'intro:IntroFacts.drivers.words'],
  ] as const;
  /** A topic: its title and its paragraph. */
  const TOPICS = [
    ['intro:IntroFacts.desktop', 'intro:IntroFacts.desktop.words'],
    ['intro:IntroFacts.vulkan', 'intro:IntroFacts.vulkan.words'],
    ['intro:IntroFacts.devices', 'intro:IntroFacts.devices.words'],
    ['intro:IntroFacts.disks', 'intro:IntroFacts.disks.words'],
    ['intro:IntroFacts.snapshots', 'intro:IntroFacts.snapshots.words'],
    ['intro:IntroFacts.networks', 'intro:IntroFacts.networks.words'],
  ] as const;
</script>

<IntroSection id="intro-facts" title={t('intro:IntroFacts.title')} ground="raised" bind:ref>
  {#snippet lede()}<T k="intro:IntroFacts.lede" />{/snippet}
  <div class="readouts">
    {#each READOUTS as [figure, counts, words] (figure)}
      <IntroReadout figure={t(figure)} counts={t(counts)} words={t(words)} />
    {/each}
  </div>
  <dl>
    {#each TOPICS as [topic, words] (topic)}
      <div>
        <dt>{t(topic)}</dt>
        <dd>{t(words)}</dd>
      </div>
    {/each}
  </dl>
</IntroSection>

<style>
  .readouts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: var(--space-6);
  }
  /* The topics: a sheet's entries, a seam over each. */
  dl {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
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
</style>
