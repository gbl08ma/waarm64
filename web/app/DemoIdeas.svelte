<!--
  "Things to try" on the demo store's page (DemosPage.svelte; docs/frontend.md "The demo store"): the last row of our
  store's list, which is no demo: its pane lists what a visitor can do with a machine once they have one (programs
  that are known to run, by the user's own trials; ways to reach a machine over the network). Nothing starts from it.
  Its words name programs and projects, as the introduction's do (docs/copy.md "The introduction").
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Note from './ui/Note.svelte';
  import Pane from './ui/Pane.svelte';
  import { t } from '../i18n.ts';

  type Props = {
    /** Its row in the list (after the demos' rows), not its pane; `chosen`: its pane shows; `onopen`: the row pressed. */
    row?: boolean;
    chosen?: boolean;
    onopen?: () => void;
    /** The pane alone in one column: its way back to the list. */
    back?: boolean;
    onback?: () => void;
  };
  let { row = false, chosen = false, onopen, back = false, onback }: Props = $props();

  /** A group's title and its ideas, each a name and what to expect (the catalog's keys, written out for i18n-check). */
  const GROUPS = [
    [
      'machines:DemoIdeas.desktop',
      [
        ['machines:DemoIdeas.plasma', 'machines:DemoIdeas.plasma.words'],
        ['machines:DemoIdeas.luanti', 'machines:DemoIdeas.luanti.words'],
        ['machines:DemoIdeas.ppsspp', 'machines:DemoIdeas.ppsspp.words'],
        ['machines:DemoIdeas.godot', 'machines:DemoIdeas.godot.words'],
        ['machines:DemoIdeas.webgl', 'machines:DemoIdeas.webgl.words'],
        ['machines:DemoIdeas.steam', 'machines:DemoIdeas.steam.words'],
      ],
    ],
    [
      'machines:DemoIdeas.network',
      [
        ['machines:DemoIdeas.ssh', 'machines:DemoIdeas.ssh.words'],
        ['machines:DemoIdeas.room', 'machines:DemoIdeas.room.words'],
      ],
    ],
  ] as const;
</script>

{#if row}
  <button
    class="idea"
    class:chosen
    aria-current={chosen}
    onclick={() => (chosen ? undefined : onopen?.())}
    data-action="things-to-try"
  >
    <span class="name">{t('machines:DemoIdeas.title')}</span>
    <span class="summary">{t('machines:DemoIdeas.row')}</span>
  </button>
{:else}
  <article class="ideas" data-ideas>
    {#if back}
      <div class="back">
        <Button variant="link" icon="arrow-left" onclick={() => onback?.()} data-action="all-demos">
          {t('machines:DemoStart.back')}
        </Button>
      </div>
    {/if}
    <Pane id="ideas" title={t('machines:DemoIdeas.title')}>
      <div class="body">
        <Note size="md">{t('machines:DemoIdeas.lede')}</Note>
        {#each GROUPS as [group, ideas] (group)}
          <section>
            <h4>{t(group)}</h4>
            <dl>
              {#each ideas as [name, words] (name)}
                <div>
                  <dt>{t(name)}</dt>
                  <dd>{t(words)}</dd>
                </div>
              {/each}
            </dl>
          </section>
        {/each}
        <div class="fine"><Note size="md">{t('machines:DemoIdeas.fine')}</Note></div>
      </div>
    </Pane>
  </article>
{/if}

<style>
  /* The row that is no demo, after the demos' rows: their look, without a picture. */
  .idea {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 100%;
    padding: var(--space-3);
    border-top: 1px solid var(--border);
    border-radius: var(--radius-sm);
    text-align: start;
  }
  .idea:hover {
    background: var(--hover-bg);
  }
  .idea.chosen {
    background: var(--pressed-bg);
    box-shadow: var(--chosen-edge);
  }
  .idea:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }
  .name {
    font-weight: var(--weight-bold);
  }
  .summary {
    color: var(--text-dim);
    font-size: var(--text-md);
  }
  /* The pane's place beside the list, with the demos' column (DemoStart.svelte). */
  .ideas {
    --pane-width: 800px;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .back {
    padding: var(--space-3) var(--space-5) 0;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    max-width: var(--pane-width);
  }
  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  /* A group's heading, as a panel's label: small capitals, spaced, apart from the names under it. */
  h4 {
    margin: 0;
    color: var(--text-dim);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    letter-spacing: var(--label-tracking);
    text-transform: uppercase;
  }
  dl {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    margin: 0;
  }
  dt {
    font-weight: var(--weight-bold);
  }
  dd {
    margin: var(--space-1) 0 0;
    color: var(--text-dim);
  }
  .fine {
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }
</style>
