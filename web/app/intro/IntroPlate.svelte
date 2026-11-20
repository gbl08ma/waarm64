<!--
  The machine's plate on the introduction (IntroHero.svelte): what the emulated machine is, as a rating plate says it
  of a device, a row a part. The figures are docs/comparison.md §2's (the limits the page itself enforces).
-->
<script lang="ts">
  import { t } from '../../i18n.ts';

  /** A part and what the machine has for it: the catalog's keys, written out (tools/i18n-check.ts reads them here). */
  const ROWS = [
    ['intro:IntroPlate.cpu', 'intro:IntroPlate.cpu.value'],
    ['intro:IntroPlate.ram', 'intro:IntroPlate.ram.value'],
    ['intro:IntroPlate.firmware', 'intro:IntroPlate.firmware.value'],
    ['intro:IntroPlate.graphics', 'intro:IntroPlate.graphics.value'],
    ['intro:IntroPlate.video', 'intro:IntroPlate.video.value'],
    ['intro:IntroPlate.sound', 'intro:IntroPlate.sound.value'],
    ['intro:IntroPlate.usb', 'intro:IntroPlate.usb.value'],
    ['intro:IntroPlate.network', 'intro:IntroPlate.network.value'],
    ['intro:IntroPlate.disks', 'intro:IntroPlate.disks.value'],
  ] as const;
</script>

<dl aria-label={t('intro:IntroPlate.label')}>
  {#each ROWS as [part, value] (part)}
    <div>
      <dt>{t(part)}</dt>
      <dd>{t(value)}</dd>
    </div>
  {/each}
</dl>

<style>
  /* A plate set into the panel: raised, its top edge lit, a seam between its rows. */
  dl {
    margin: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-raised);
    box-shadow: var(--card-edge), var(--shadow-menu);
  }
  div {
    display: grid;
    grid-template-columns: 9em 1fr;
    align-items: baseline;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-5);
  }
  div + div {
    border-top: 1px solid var(--border);
    box-shadow: var(--card-edge);
  }
  /* A part's name, as a panel's label is engraved: small capitals, spaced. */
  dt {
    color: var(--text-dim);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    letter-spacing: var(--label-tracking);
    text-transform: uppercase;
  }
  dd {
    margin: 0;
    font-size: var(--text-base);
  }
</style>
