<!--
  A path on the introduction: the stages something passes through, left to right (top to bottom in a narrow window),
  as modules of a panel joined by a rail. One stage is active: its lamp is lit, the rail is lit up to it, and its
  paragraph shows under the path. The active stage moves along by itself while the path is on screen (autoplay.svelte.ts),
  and a click on a stage picks it. Its owner gives the words (`stages`: a label, a line, the paragraph).
-->
<script lang="ts">
  import { Autoplay } from './autoplay.svelte.ts';

  type Stage = { label: string; line: string; words: string };
  type Props = { name: string; stages: Stage[]; [attr: string]: unknown };
  let { name, stages, ...rest }: Props = $props();

  let at = $state(0);
  const auto = new Autoplay();
  $effect(() => auto.run(stages.length, 3200, () => (at = (at + 1) % stages.length)));
  const pick = (i: number) => {
    auto.playing = false;
    at = i;
  };
</script>

<div class="path" use:auto.watch {...rest}>
  <ol aria-label={name}>
    {#each stages as s, i (i)}
      <li class={{ active: i === at, passed: i < at }}>
        <button aria-pressed={i === at} onclick={() => pick(i)} data-stage={i}>
          <span class="lamp"></span>
          <span class="label">{s.label}</span>
          <span class="line">{s.line}</span>
        </button>
      </li>
    {/each}
  </ol>
  <p data-field="stage-words">{stages[at]?.words}</p>
</div>

<style>
  .path {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    min-width: 0;
  }
  ol {
    display: flex;
    gap: var(--space-6);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    position: relative;
    flex: 1 1 0;
    min-width: 0;
    display: flex;
  }
  /* The rail from a stage to the next: a groove, lit once the active stage is past it. */
  li + li::before {
    content: '';
    position: absolute;
    top: 50%;
    right: 100%;
    width: var(--space-6);
    height: 4px;
    margin-top: calc(-1 * var(--space-1));
    background: var(--well-bg);
    box-shadow: var(--groove-edge);
    transition: background var(--motion) var(--ease);
  }
  li.active::before,
  li.passed::before {
    background: var(--accent);
    box-shadow: var(--lit-lamp);
  }
  /* A stage: a module of the panel, a key that stays sunk while it's the active one. */
  button {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5) var(--space-4) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--key-bg);
    box-shadow: var(--key-edge);
    text-align: left;
  }
  button:hover {
    background: var(--key-hover-bg);
  }
  .active button {
    background: var(--pressed-bg);
    box-shadow: var(--pressed-edge);
  }
  .lamp {
    position: absolute;
    top: var(--space-4);
    right: var(--space-4);
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--status-off);
    transition: background var(--motion) var(--ease);
  }
  .active .lamp {
    background: var(--accent);
    box-shadow: var(--lit-lamp);
  }
  .label {
    padding-right: var(--space-5);
    color: var(--text-dim);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    letter-spacing: var(--label-tracking);
    text-transform: uppercase;
  }
  .active .label {
    color: var(--accent);
  }
  .line {
    font-size: var(--text-md);
  }
  p {
    margin: 0;
    max-width: 760px;
    min-height: calc(3 * var(--line-height) * var(--text-lg));
    font-size: var(--text-lg);
  }
  @media (max-width: 900px) {
    ol {
      flex-direction: column;
      gap: var(--space-4);
    }
    li + li::before {
      top: auto;
      right: auto;
      bottom: 100%;
      left: var(--space-6);
      width: 4px;
      height: var(--space-4);
      margin-top: 0;
    }
    /* Six lines' room: the longest stage's words in one narrow column, so what is under a path doesn't move as it steps. */
    p {
      min-height: calc(6 * var(--line-height) * var(--text-lg));
    }
  }
</style>
