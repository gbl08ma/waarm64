<!--
  A floating window whose height follows its width (floating-window-page.ts): shape `wide` is half as tall as it is
  wide, `tall` as tall, 30 px of bar and padding on each; the button in its bar switches. A field outside it holds the
  focus; one inside it is a form control. Developer's words: a test page, not the page.
-->
<script lang="ts">
  import FloatingWindow from '../../web/app/ui/FloatingWindow.svelte';

  const tool = new URLSearchParams(location.search).get('tool') === '1';
  let shape = $state<'wide' | 'tall'>('wide');
  const ASPECT = { wide: (w: number) => w / 2 + 30, tall: (w: number) => w + 30 };
  let open = $state(true);
</script>

<input id="outside" />
{#if open}
  <FloatingWindow
    id="aspect-window"
    place="aspect-demo"
    title="aspect"
    {tool}
    min={{ w: 200, h: 0 }}
    size={{ w: shape === 'wide' ? 400 : 240, h: 0 }}
    aspect={ASPECT[shape]}
    sizeKey={shape}
    at={(s) => ({ x: 20, y: innerHeight - s.h - 20 })}
    data-shape={shape}
    onclose={() => (open = false)}
  >
    {#snippet head()}
      <button data-action="shape" onclick={() => (shape = shape === 'wide' ? 'tall' : 'wide')}>{shape}</button>
    {/snippet}
    {#snippet children({ w, h }: { w: number; h: number })}
      <div class="inside" data-w={w} data-h={h}><input id="inside" /></div>
    {/snippet}
  </FloatingWindow>
{/if}
