<!--
  A machine's keyboard layout (its Settings tab; web/app/keyboard.ts): none (the guest's own), a layout, or "Match this
  browser" (the one it reports, looked up at every start). Match this browser's button picks the browser's for the
  user to save.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import { msg, t, text, type Msg } from '../i18n.ts';
  import { browserLayout, FOLLOW_BROWSER, KEYBOARD_LAYOUTS } from './keyboard.ts';
  import type { Editing } from './machine-edit.svelte.ts';

  type Props = { edit: Editing };
  let { edit }: Props = $props();

  /** What Match this browser found. */
  let matched = $state<Msg | undefined>();
  /** What this browser reports now, for the note of a machine that follows it. */
  let browserNow = $state<Msg | undefined>();
  browserLayout().then(
    (l) => (browserNow = l?.label),
    () => {
      // No layout to name: the note says it without one.
    },
  );
  async function match() {
    const l = await browserLayout();
    if (l) {
      edit.draft.keyboard = l.id;
      edit.touch();
    }
    matched = l
      ? msg('machines:KeyboardField.keyboard.matched', { layout: l.label })
      : msg('machines:KeyboardField.keyboard.unknown');
  }

  const choices: { id: string | undefined; label: string }[] = [
    { id: undefined, label: t('machines:KeyboardField.keyboard.none') },
    { id: FOLLOW_BROWSER, label: t('machines:KeyboardField.keyboard.follow') },
    ...KEYBOARD_LAYOUTS.map((l) => ({ id: l.id, label: text(l.label) })),
  ];
  const followNote = $derived(
    browserNow
      ? t('machines:KeyboardField.keyboard.followNote.now', { layout: browserNow })
      : t('machines:KeyboardField.keyboard.followNote'),
  );
</script>

<Field label={t('machines:KeyboardField.keyboard')}>
  {#snippet after()}
    <Button
      icon="keyboard"
      onclick={match}
      data-action="match-keyboard"
      title={t('machines:KeyboardField.keyboard.match.title')}
    >
      {t('machines:KeyboardField.keyboard.match')}
    </Button>
  {/snippet}
  <select
    bind:value={edit.draft.keyboard}
    onchange={() => (matched = undefined)}
    data-field="keyboard"
    title={t('machines:KeyboardField.keyboard.title')}
  >
    {#each choices as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
  </select>
</Field>
{#if matched}<Note data-keyboard-match>{text(matched)}</Note>{/if}
{#if edit.draft.keyboard === FOLLOW_BROWSER}
  <Note data-keyboard-note>{followNote}</Note>
{:else if edit.draft.keyboard}
  <Note data-keyboard-note>{t('machines:KeyboardField.keyboard.setNote')}</Note>
{/if}
