<!--
  A row's name that can be edited where it is (a connection's, a folder's): it reads as the row's title, in line with
  the lines under it, and shows its frame on hover and focus. `onchange` gets the new name; other attributes
  (`aria-label`, `data-field`, `class`) go on the input.
-->
<script lang="ts">
  type Props = { value: string; onchange: (name: string) => void; class?: string; [attr: string]: unknown };
  let { value, onchange, class: cls, ...rest }: Props = $props();
</script>

<input class={['name-input', cls]} {value} onchange={(e) => onchange(e.currentTarget.value)} {...rest} />

<style>
  /* Its frame and padding sit outside the text's start, so the name lines up with the lines under it. */
  .name-input {
    min-height: 0;
    font-weight: var(--weight-bold);
    background: transparent;
    border-color: transparent;
    padding: 0 var(--space-2);
    margin-left: calc(-1 * var(--space-2) - 1px);
  }
  .name-input:hover,
  .name-input:focus {
    border-color: var(--border);
  }
</style>
