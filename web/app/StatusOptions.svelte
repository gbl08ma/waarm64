<!--
  The status bar editor's chosen chip's settings (StatusEditor.svelte): its name and what it shows, its look (words,
  an icon or both), a vCPU element's bars or numbers, a `one` element's device; move it left or right, remove it.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Note from './ui/Note.svelte';
  import Radio from './ui/Radio.svelte';
  import { t } from '../i18n.ts';
  import { aboutOf, deviceOf, firstIndex, hasLooks, iconOf, lookOf, nameOf, type Item } from './statusbar.ts';
  import type { Look } from './statusbar-kinds.ts';

  type Props = {
    item: Item;
    /** Its place on the bar, and how many chips there are. */
    at: number;
    count: number;
    onchange: (patch: Partial<Item>) => void;
    /** Moves it before chip `to`. */
    onmove: (to: number) => void;
    onremove: () => void;
  };
  let { item, at, count, onchange, onmove, onremove }: Props = $props();

  const device = $derived(deviceOf(item.kind));
  const LOOKS: Look[] = ['text', 'icon', 'both'];
  const LOOK_WORDS: Record<Look, string> = {
    text: t('statusbar:StatusOptions.look.text'),
    icon: t('statusbar:StatusOptions.look.icon'),
    both: t('statusbar:StatusOptions.look.both'),
  };
  const DEVICE_WORDS = {
    cpu: t('statusbar:StatusOptions.device.cpu'),
    net: t('statusbar:StatusOptions.device.net'),
    disk: t('statusbar:StatusOptions.device.disk'),
  } as const;
  const INDEX_NOTE = {
    cpu: t('statusbar:StatusOptions.index.cpu'),
    net: t('statusbar:StatusOptions.index.net'),
    disk: t('statusbar:StatusOptions.index.disk'),
  } as const;

  function setIndex(e: Event & { currentTarget: HTMLInputElement }, first: number) {
    const n = Math.round(Number(e.currentTarget.value));
    if (Number.isFinite(n) && n >= first) onchange({ index: n });
  }
</script>

<div class="options" data-field="status-options">
  <strong>{nameOf(item)}</strong><Note inline>{aboutOf(item.kind)}</Note>
  {#if hasLooks(item.kind) && iconOf(item.kind)}
    <fieldset class="set">
      <legend class="sr">{t('statusbar:StatusOptions.look')}</legend>
      {#each LOOKS as l (l)}
        <Radio name="status-look" value={l} checked={lookOf(item) === l} onchange={() => onchange({ look: l })}>
          {LOOK_WORDS[l]}
        </Radio>
      {/each}
    </fieldset>
  {/if}
  {#if device === 'cpu' && item.scope === 'each'}
    <fieldset class="set">
      <legend class="sr">{t('statusbar:StatusOptions.cpus')}</legend>
      <Radio name="status-bars" value="bars" checked={!item.numbers} onchange={() => onchange({ numbers: false })}>
        {t('statusbar:StatusOptions.cpus.bars')}
      </Radio>
      <Radio name="status-bars" value="numbers" checked={!!item.numbers} onchange={() => onchange({ numbers: true })}>
        {t('statusbar:StatusOptions.cpus.numbers')}
      </Radio>
    </fieldset>
  {/if}
  {#if device && item.scope === 'one'}
    {@const first = firstIndex(device)}
    <fieldset class="set">
      <legend class="sr">{DEVICE_WORDS[device]}</legend>
      <label class="index">
        {DEVICE_WORDS[device]}
        <input
          type="number"
          min={first}
          max="64"
          value={item.index ?? first}
          onchange={(e) => setIndex(e, first)}
          data-field="status-index"
        />
      </label>
      <Note inline>{INDEX_NOTE[device]}</Note>
    </fieldset>
  {/if}
  <span class="grow"></span>
  <Button
    icon="arrow-left"
    iconSize={14}
    onclick={() => onmove(at - 1)}
    disabled={at === 0}
    title={t('statusbar:StatusOptions.left')}
  />
  <Button
    icon="arrow-right"
    iconSize={14}
    onclick={() => onmove(at + 2)}
    disabled={at === count - 1}
    title={t('statusbar:StatusOptions.right')}
  />
  <Button icon="trash" iconSize={14} onclick={onremove}>{t('statusbar:StatusOptions.remove')}</Button>
</div>

<style>
  .options {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  /* Each set of options apart from the next by a line (its legend is for screen readers). */
  .set {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
    margin: 0;
    padding: 0 0 0 var(--space-5);
    border: 0;
    border-left: 1px solid var(--border);
  }
  .index {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .index input {
    width: 4em;
  }
  .grow {
    flex: 1;
  }
</style>
