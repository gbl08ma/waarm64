<!--
  The introduction's speed figure (speed.ts `SPEED_LEAD`), over the comparison's table: one readout, "up to N% faster
  than" the next best project, named, with the workload and the date under it. Nothing while there is no measured
  figure.
-->
<script lang="ts">
  import T from '../T.svelte';
  import { t } from '../../i18n.ts';
  import { day } from './compare.ts';
  import type { SpeedLead } from './speed.ts';

  type Props = { lead: SpeedLead | undefined };
  let { lead }: Props = $props();
</script>

{#if lead}
  <div class="speed" data-field="speed-lead">
    <div class="window"><span class="figure">{t('intro:IntroSpeed.figure', { percent: lead.percent })}</span></div>
    <div class="words">
      <div class="claim"><T k="intro:IntroSpeed.claim" params={{ peer: lead.peer }} /></div>
      <p>{t('intro:IntroSpeed.basis', { workload: lead.workload, when: day(lead.date) })}</p>
    </div>
  </div>
{/if}

<style>
  .speed {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-5) var(--space-6);
  }
  .window {
    padding: var(--space-4) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--well-bg);
    box-shadow: var(--well-edge);
  }
  .figure {
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: var(--text-display);
    font-variant-numeric: tabular-nums;
    line-height: var(--line-height-tight);
    text-shadow: var(--lit-text);
  }
  .claim {
    font-size: var(--text-lede);
    font-weight: var(--weight-bold);
  }
  p {
    margin: 0;
    color: var(--text-dim);
  }
</style>
