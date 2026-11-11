<!--
  A value to copy (an address, a key, a room's name or link), read-only in its field; `select()` selects it, for the
  user to copy where the clipboard refused. `id` is a test's handle.
-->
<script lang="ts">
  import Field from './ui/Field.svelte';

  type Props = { id: string; label: string; value: string; type?: 'text' | 'password' };
  let { id, label, value, type = 'text' }: Props = $props();

  let input = $state<HTMLInputElement>();
  export function select() {
    input?.select();
  }
</script>

<Field {label}><input bind:this={input} {id} {type} readonly spellcheck="false" {value} /></Field>
