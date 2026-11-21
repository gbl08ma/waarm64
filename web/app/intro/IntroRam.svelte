<!--
  Memory's deep dive on the introduction (IntroHow.svelte): a slider of guest RAM, and under it the WebAssembly
  memories that much RAM takes, a track of 4 GiB each, as the machine really splits it (web/ram.ts `splitRam`, the
  function a machine's start uses): memory 0 with the guest's first RAM and the emulator's own gigabyte, then a memory
  per NUMA node.
-->
<script lang="ts">
  import Slider from '../ui/Slider.svelte';
  import { HEAP_FLOOR, MAX_SPILL_BYTES, splitRam } from '../../ram.ts';
  import { t } from '../../i18n.ts';

  const MIB = 2 ** 20;
  /** RAM in MiB, as a machine's settings offer it. */
  let ram = $state(8192);
  const split = $derived(splitRam(ram * MIB));
  /** A width on a memory's track, which is 4 GiB wide. */
  const share = (bytes: number) => `${(bytes / MAX_SPILL_BYTES) * 100}%`;
  const gib = (mib: number) => t('intro:IntroRam.value', { size: mib * MIB });
</script>

<div class="ram" data-field="ram-split">
  <div class="slider">
    <Slider
      bind:value={ram}
      min={256}
      max={16384}
      step={256}
      notches={[1024, 2048, 3072, 4096, 8192, 16384]}
      snap={128}
      label={gib}
      title={t('intro:IntroRam.slider')}
      field="intro-ram"
    />
  </div>
  <ol>
    <li data-memory="0">
      <div class="name">{t('intro:IntroRam.memory0', { size: split.ramSize })}</div>
      <div class="track">
        <span class="guest" style:width={share(split.ramSize)}></span><span class="own" style:width={share(HEAP_FLOOR)}
        ></span>
      </div>
    </li>
    {#each split.spill as bytes, i (i)}
      <li data-memory={i + 1}>
        <div class="name">{t('intro:IntroRam.spill', { n: i + 1, size: bytes })}</div>
        <div class="track"><span class="guest spill" style:width={share(bytes)}></span></div>
      </li>
    {/each}
  </ol>
  <ul class="legend">
    <li><span class="swatch guest"></span>{t('intro:IntroRam.legend.node0')}</li>
    <li><span class="swatch guest spill"></span>{t('intro:IntroRam.legend.spill')}</li>
    <li><span class="swatch own"></span>{t('intro:IntroRam.legend.own')}</li>
  </ul>
  <p>{t('intro:IntroRam.words')}</p>
  <p>{t('intro:IntroRam.cost')}</p>
</div>

<style>
  .ram {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: 900px;
  }
  .slider {
    --slider-value-w: 5em;
    max-width: 560px;
  }
  ol,
  ul {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .name {
    margin-bottom: var(--space-2);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }
  /* A WebAssembly memory: a groove 4 GiB long, filled as far as it's used. */
  .track {
    display: flex;
    height: var(--space-6);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--well-bg);
    box-shadow: var(--well-edge);
  }
  .track span {
    transition: width var(--motion) var(--ease);
  }
  /* The block map's colors (ui/BlockGrid.svelte): the guest's RAM in its blues, the emulator's own in its amber. */
  .guest {
    background: var(--map-rim-3);
  }
  .spill {
    background: var(--map-rim-1);
  }
  .own {
    background: var(--map-core-2);
  }
  .legend {
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-6);
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  .legend li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .swatch {
    width: var(--space-4);
    height: var(--space-4);
    border-radius: var(--radius-sm);
  }
  p {
    margin: 0;
    color: var(--text-dim);
  }
</style>
