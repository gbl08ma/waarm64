<!--
  What of a USB device the guest doesn't get, or why it couldn't be attached, in words (web/app/usb-ports.ts
  `problemText`): each problem's short text, and under it, folded, the host's remedy (numbered steps with the commands
  to copy) and the browser's own message.
-->
<script lang="ts">
  import { t } from '../i18n.ts';
  import { browserSaid, type FixStep, type ProblemWords } from './usb-ports.ts';

  let { words }: { words: ProblemWords[] } = $props();
</script>

{#snippet step(s: FixStep)}{s.text}{#if s.code}<code>{s.code}</code>{/if}{#if s.link}<a
      href={s.link}
      target="_blank"
      rel="noopener">{s.link}</a
    >{/if}{/snippet}

<div class="problems">
  {#each words as w, i (i)}
    <div class="problem">
      <p>{w.text}</p>
      {#if w.fix || w.said}
        <details>
          <summary>{w.fix?.title ?? t('usb:UsbProblems.details')}</summary>
          {#if w.fix}
            <ol>
              {#each w.fix.steps as s, j (j)}<li>{@render step(s)}</li>{/each}
            </ol>
            {#if w.fix.note}<div class="note">{@render step(w.fix.note)}</div>{/if}
          {/if}
          {#if w.said}<div class="said">{browserSaid(w.said)}</div>{/if}
        </details>
      {/if}
    </div>
  {/each}
</div>

<style>
  .problems {
    display: flex;
    flex-direction: column;
    gap: 8px;
    white-space: normal;
  }
  p {
    margin: 0;
  }
  details {
    margin-top: 4px;
    color: var(--text);
    font-size: 12px;
  }
  summary {
    cursor: pointer;
    color: var(--accent);
  }
  ol {
    margin: 6px 0 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  code {
    display: block;
    margin-top: 3px;
    padding: 4px 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--bg);
    font-family: ui-monospace, monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: all;
  }
  a {
    display: block;
    color: var(--accent);
  }
  .note {
    margin-top: 6px;
  }
  .said {
    margin-top: 6px;
    color: var(--dim);
    overflow-wrap: anywhere;
  }
</style>
