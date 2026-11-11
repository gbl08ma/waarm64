<!--
  The Up and Down buttons of an ordered list (a machine's disks, shared folders and network adapters): what each move
  means there goes in `upTitle` and `downTitle`, and `action` names them for the tests (`<action>-up`, `<action>-down`).
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import { t } from '../i18n.ts';

  let {
    index,
    count,
    onmove,
    upTitle = t('common:MoveButtons.up.title'),
    downTitle = t('common:MoveButtons.down.title'),
    action,
  }: {
    /** This item's place, and how many there are: the ends can't move past themselves. */
    index: number;
    count: number;
    onmove: (by: -1 | 1) => void;
    upTitle?: string;
    downTitle?: string;
    action?: string;
  } = $props();
</script>

<Button
  icon="arrow-up"
  onclick={() => onmove(-1)}
  disabled={index === 0}
  aria-label={t('common:MoveButtons.up')}
  title={upTitle}
  data-action={action && `${action}-up`}
></Button>
<Button
  icon="arrow-down"
  onclick={() => onmove(1)}
  disabled={index >= count - 1}
  aria-label={t('common:MoveButtons.down')}
  title={downTitle}
  data-action={action && `${action}-down`}
></Button>
