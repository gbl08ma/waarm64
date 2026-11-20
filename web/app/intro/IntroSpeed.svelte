<!--
  The introduction's speed figures (speed.ts `SPEED`), over the comparison's table: a readout a project, "N× as fast
  as" it, the next fastest named so, with what was measured and when under them. Nothing while there is no measured
  figure.
-->
<script lang="ts">
  import T from '../T.svelte';
  import { t } from '../../i18n.ts';
  import { day } from './compare.ts';
  import type { Speed } from './speed.ts';

  type Props = { speed: Speed | undefined };
  let { speed }: Props = $props();
  /** A ratio to one decimal, as the visitor's locale writes it. */
  const times = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
</script>

{#if speed}
  <div class="speed" data-field="speed-lead">
    <div class="leads">
      {#each speed.leads as lead (lead.peer)}
        <div class="lead" data-peer={lead.peer} data-next={lead.next}>
          <div class="window">
            <span class="figure">{t('intro:IntroSpeed.figure', { times: times(lead.times) })}</span>
          </div>
          <div class="claim">
            {#if lead.next}
              <T k="intro:IntroSpeed.claim.next" params={{ peer: lead.peer }} />
            {:else}
              <T k="intro:IntroSpeed.claim" params={{ peer: lead.peer }} />
            {/if}
          </div>
        </div>
      {/each}
    </div>
    <p>{t('intro:IntroSpeed.basis', { when: day(speed.date) })}</p>
  </div>
{/if}

<style>
  .speed {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .leads {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5) var(--space-7);
  }
  .lead {
    display: flex;
    align-items: center;
    gap: var(--space-5);
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
    max-width: 14em;
    font-size: var(--text-lede);
    font-weight: var(--weight-bold);
  }
  p {
    margin: 0;
    max-width: 760px;
    color: var(--text-dim);
  }
</style>
