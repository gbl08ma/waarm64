<!--
  A topic of the introduction's "How it works" (IntroHow.svelte): its title, what it's about, its picture (a path:
  IntroPath.svelte), and for some a deep dive that a button unfolds under it (`dive`, rendered only once opened: its
  code and data load then).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from '../ui/Button.svelte';
  import { t } from '../../i18n.ts';

  type Props = { id: string; title: string; words: string; picture: Snippet; dive?: Snippet; deeper?: string };
  let { id, title, words, picture, dive, deeper }: Props = $props();
  let open = $state(false);
</script>

<article aria-labelledby={id} data-topic={id}>
  <div class="head">
    <h3 {id}>{title}</h3>
    <p>{words}</p>
  </div>
  {@render picture()}
  {#if dive}
    <div class="deeper">
      <Button onclick={() => (open = !open)} aria-expanded={open} data-action="go-deeper">
        {open ? t('intro:IntroTopic.less') : (deeper ?? t('intro:IntroTopic.deeper'))}
      </Button>
    </div>
    {#if open}<div class="dive" data-field="dive">{@render dive()}</div>{/if}
  {/if}
</article>

<style>
  article {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    min-width: 0;
    padding-top: var(--space-6);
    border-top: 1px solid var(--border);
    box-shadow: var(--card-edge);
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 760px;
  }
  h3 {
    margin: 0;
    font-size: var(--text-lede);
  }
  p {
    margin: 0;
    color: var(--text-dim);
    font-size: var(--text-lg);
  }
  .deeper {
    display: flex;
  }
  .dive {
    min-width: 0;
    padding-top: var(--space-4);
  }
</style>
