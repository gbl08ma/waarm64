<!--
  A message whose words have markers (docs/i18n.md "Markers"): `<T k="ns:Source.name" params={…}>`, or `m={msg}`. It
  draws the references on its own (web/i18n.ts `REFERENCE`): a name someone gave (`<name>`), an element of the page's
  words (`<ui>`, with its icon before them: `<ui-network>`), code (`<code>`), words stressed or a name set apart
  in a sentence (`<em>`, bold), and words in italics (`<i>`: a writer's own stress in their own prose); a snippet per other marker, named as
  the marker and given the words it wraps (`{#snippet b(text)}<b>{text}</b>{/snippet}`), which can stand in for these
  too; and, second, which of that marker's pieces it is (0, 1…: a list's items in a marker are one piece each, so a
  snippet can tell two equal names apart). A message without markers needs none of this: `{t('ns:Source.name')}`.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './ui/Icon.svelte';
  import { ICONS, type IconName } from './icons.ts';
  import { marked, type Msg, type Params } from '../i18n.ts';

  let {
    k,
    m,
    params,
    ...markers
  }: {
    k?: string;
    m?: Msg;
    params?: Params;
    [marker: string]: Snippet<[string]> | Snippet<[string, number]> | Params | Msg | string | undefined;
  } = $props();
  const pieces = $derived(m ? marked(m.key, m.params) : marked(k ?? '', params));
  /** Each piece's place among its marker's pieces (0 for the first `<name>`, 1 for the second…). */
  const nth = $derived.by(() => {
    const seen: Record<string, number> = {};
    return pieces.map((p) => {
      const n = seen[p.tag ?? ''] ?? 0;
      seen[p.tag ?? ''] = n + 1;
      return n;
    });
  });
  /** The icon of a `<ui-…>` marker, if it names one. */
  const iconOf = (tag: string) =>
    tag.startsWith('ui-') && tag.slice(3) in ICONS ? (tag.slice(3) as IconName) : undefined;
  /** A pill's first word, which its icon stays beside when the line breaks, and the words after it. */
  const firstWord = (text: string) => text.split(' ', 1)[0];
  const restWords = (text: string) => text.slice(firstWord(text).length);
</script>

{#each pieces as p, i (i)}{#if p.tag && typeof markers[p.tag] === 'function'}{@render (
      markers[p.tag] as Snippet<[string, number]>
    )(p.text, nth[i])}{:else if p.tag === 'name'}<span class="name">{p.text}</span>{:else if p.tag === 'ui'}<span
      class="ui">{p.text}</span
    >{:else if p.tag?.startsWith('ui-')}{@const icon = iconOf(p.tag)}<span class="ui"
      >{#if icon}<span class="first"
          ><span class="icon" aria-hidden="true"><Icon name={icon} size="0.9em" /></span>{firstWord(p.text)}</span
        >{restWords(p.text)}{:else}{p.text}{/if}</span
    >{:else if p.tag === 'code'}<code>{p.text}</code>{:else if p.tag === 'em'}<em>{p.text}</em
    >{:else if p.tag === 'i'}<i>{p.text}</i>{:else}{p.text}{/if}{/each}

<style>
  /* Words stressed, or a name set apart in a sentence: the text's own color at its brightest, upright. */
  em {
    color: var(--text);
    font-style: normal;
    font-weight: var(--weight-bold);
  }
  /* A name someone gave (a machine's, a disk's, an overlay's…), in running text: docs/frontend-code.md §1 "Names and
     the page's elements in words". */
  .name {
    color: var(--name-fg);
    font-weight: var(--name-weight);
    background: var(--name-bg);
    border-radius: var(--radius-sm);
    padding: 0 var(--name-pad);
    box-decoration-break: clone;
  }
  /* The words of an element of the page (a button, a tab, a menu): a faint frame, like a small button's. No pill makes
     its line taller or the box around the words bigger, at any size of text: no vertical padding, the frame inside it
     (`--ui-ref-frame`, a shadow), the icon a box of no height (below). */
  .ui {
    color: var(--ui-ref-fg);
    background: var(--ui-ref-bg);
    box-shadow: var(--ui-ref-frame);
    border-radius: var(--radius-sm);
    padding: 0 var(--space-2);
    box-decoration-break: clone;
  }
  /* The icon, sized by the words (0.9 em) and hung from a box of no height raised 0.78 em above the baseline: it spans
     0.78 em above to 0.12 em below it, inside any line of the page's line height, and adds nothing to the line's
     height (an icon of its own height did, in small text). */
  /* The icon and the first word after it: a line never breaks between them. */
  .first {
    white-space: nowrap;
  }
  .icon {
    display: inline-block;
    height: 0;
    vertical-align: 0.78em;
    margin-right: var(--space-1);
  }
</style>
