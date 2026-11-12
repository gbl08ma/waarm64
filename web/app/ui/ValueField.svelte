<!--
  A text field with its actions inside its frame, after the text: Copy (an icon, a check for a moment once copied) and,
  for a secret, Show and Hide (an eye). The page's addresses, keys, links and commands to copy (`readonly`), and the
  secrets a user pastes (`value` binds). A secret starts hidden (`shown` binds). Where the clipboard refuses, the value
  is shown and selected in the field, for the user to copy themselves. `id` is the input's, `copyId` and `showId` the
  buttons' (tests' handles); `mono` for a command or a key; without a `label`, the field alone (a command under the
  words that say what it does). `note` as Field's.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import Button from './Button.svelte';
  import Field from './Field.svelte';
  import { t } from '../../i18n.ts';

  type Props = {
    id: string;
    label?: string;
    value: string;
    readonly?: boolean;
    copy?: boolean;
    secret?: boolean;
    shown?: boolean;
    mono?: boolean;
    placeholder?: string;
    copyId?: string;
    showId?: string;
    note?: string | Snippet;
    ref?: HTMLInputElement;
  };
  let {
    id,
    label,
    value = $bindable(),
    readonly = false,
    copy = false,
    secret = false,
    shown = $bindable(false),
    mono = false,
    placeholder,
    copyId,
    showId,
    note,
    ref = $bindable(),
  }: Props = $props();

  /** How long the check stays after a copy. */
  const COPIED_MS = 1500;
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(timer));

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => (copied = false), COPIED_MS);
    } catch {
      shown = true;
      await tick();
      ref?.select();
    }
  }
</script>

{#snippet box()}
  <span class={['box', { mono }]}>
    <input
      bind:this={ref}
      bind:value
      {id}
      type={secret && !shown ? 'password' : 'text'}
      {readonly}
      {placeholder}
      autocomplete="off"
      spellcheck="false"
    />
    {#if secret}
      <Button
        type="button"
        variant="inline"
        id={showId}
        icon={shown ? 'eye-off' : 'eye'}
        aria-pressed={shown}
        aria-label={shown ? t('common:ValueField.hide') : t('common:ValueField.show')}
        title={shown ? t('common:ValueField.hide') : t('common:ValueField.show')}
        onclick={() => (shown = !shown)}
      />
    {/if}
    {#if copy}
      <Button
        type="button"
        variant="inline"
        id={copyId}
        icon={copied ? 'check' : 'copy'}
        disabled={!value}
        data-copied={copied || undefined}
        aria-label={copied ? t('common:ValueField.copied') : t('common:ValueField.copy')}
        title={copied ? t('common:ValueField.copied') : t('common:ValueField.copy')}
        onclick={copyValue}
      />
    {/if}
  </span>
{/snippet}

{#if label}
  <Field {label} {note}>{@render box()}</Field>
{:else}
  {@render box()}
{/if}

<style>
  /* The frame an input has (theme/base.css), around the input and its buttons; the input inside has none. */
  .box {
    display: flex;
    align-items: stretch;
    min-width: 0;
    min-height: var(--control-h);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .box:has(input:focus-visible) {
    box-shadow: var(--shadow-focus);
  }
  input {
    flex: 1;
    min-width: 0;
    min-height: 0;
    border: none;
    background: transparent;
    outline: none;
  }
  .mono input {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
</style>
