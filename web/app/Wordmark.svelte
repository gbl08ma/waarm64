<!--
  The wordmark at the toolbar's left end (docs/frontend.md "The toolbar"; the look: docs/frontend-code.md §1 item 2),
  the page's heading: the name's two halves by weight, a drawing beside the catalog's name (the heading's
  `aria-label`). It's a button that looks as the wordmark does until the pointer or the focus is on it: from Home or the
  demo store's page it goes back to the machine (a demo's download running there is asked about first:
  demo-leave.ts), from the machine it opens Home. A shortcut: the toolbar's Home button does all of it too.
-->
<script lang="ts">
  import WordmarkLetters from './WordmarkLetters.svelte';
  import { demos } from './areas/demos.svelte.ts';
  import { machinesNav } from './areas/machines-nav.svelte.ts';
  import { leaveDemo } from './demo-leave.ts';
  import { page } from './page.ts';
  import { t } from '../i18n.ts';

  /** Home or the demo store's page shows in the machine's place. */
  const inPage = $derived(machinesNav.open || demos.open);
  /** Back to the machine from either page. */
  const toMachine = () => (machinesNav.open ? page.closeMachines() : void leaveDemo(() => page.closeDemos(false)));
  /** What a click does, said. */
  const title = $derived(inPage ? t('toolbar:Wordmark.back') : t('toolbar:Wordmark.home'));
</script>

<h1 aria-label={t('toolbar:Wordmark.name')}>
  <button
    id="wordmark"
    data-action={inPage ? 'back' : 'home'}
    {title}
    aria-label={title}
    onclick={() => (inPage ? toMachine() : page.openMachines())}><WordmarkLetters /></button
  >
</h1>

<style>
  h1 {
    margin: 0 var(--space-3) 0 var(--space-2);
    font-size: var(--bar-text-lg);
    font-weight: var(--weight-bold);
    color: var(--text);
  }
  /* The wordmark's own look: no key, no frame. The room around the letters shows only under the pointer. */
  button {
    margin: 0 calc(-1 * var(--space-2));
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius);
    font-weight: inherit;
  }
  button:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }
</style>
