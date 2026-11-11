<!--
  A radio button and its words, on one line (Check's sibling): one of a group's choices (`name`, `value`; `checked`,
  `onchange` when it's picked). `title`, `disabled` and other attributes (`data-*`) go on the input.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = {
    name: string;
    value: string;
    checked?: boolean;
    disabled?: boolean;
    title?: string;
    onchange?: () => void;
    children: Snippet;
    [attr: string]: unknown;
  };
  let { name, value, checked = false, disabled = false, title, onchange, children, ...rest }: Props = $props();
</script>

<label class="radio" {title}
  ><input type="radio" {name} {value} {checked} {disabled} {onchange} {...rest} />
  {@render children()}</label
>

<style>
  .radio {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
</style>
