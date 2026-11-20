<!--
  The introduction's comparison (web/app/IntroPage.svelte): waarm64 beside the other projects that run Linux in a
  browser, a row a property (compare.ts, from docs/comparison.md), our column lit; over it the speed figure once
  there's a measured one (IntroSpeed.svelte); under it what the others do better, and their sources. In a narrow window
  the table scrolls sideways under its first column.
-->
<script lang="ts">
  import IntroSection from './IntroSection.svelte';
  import IntroSpeed from './IntroSpeed.svelte';
  import T from '../T.svelte';
  import { CHECKED, day, PEERS } from './compare.ts';
  import { SPEED_LEAD } from './speed.ts';
  import { t } from '../../i18n.ts';

  type Props = { ref?: HTMLElement };
  let { ref = $bindable() }: Props = $props();

  /** Every link to another site opens apart from the page and tells that site nothing of it. */
  const EXTERNAL = { target: '_blank', rel: 'external nofollow noopener noreferrer' };
  const SOURCES = PEERS.filter((p) => p.source);

  /** A row: its heading's key, and each project's cell's, in `PEERS`' order (the catalog's keys, written out). */
  const ROWS: readonly (readonly [string, readonly string[]])[] = [
    [
      'intro:IntroCompare.guest',
      [
        'intro:IntroCompare.guest.ours',
        'intro:IntroCompare.guest.unkernel',
        'intro:IntroCompare.guest.webvm',
        'intro:IntroCompare.guest.v86',
        'intro:IntroCompare.guest.jslinux',
      ],
    ],
    [
      'intro:IntroCompare.kernel',
      [
        'intro:IntroCompare.kernel.ours',
        'intro:IntroCompare.kernel.unkernel',
        'intro:IntroCompare.kernel.webvm',
        'intro:IntroCompare.kernel.v86',
        'intro:IntroCompare.kernel.jslinux',
      ],
    ],
    [
      'intro:IntroCompare.cores',
      [
        'intro:IntroCompare.cores.ours',
        'intro:IntroCompare.cores.unkernel',
        'intro:IntroCompare.unconfirmed',
        'intro:IntroCompare.cores.v86',
        'intro:IntroCompare.unconfirmed',
      ],
    ],
    [
      'intro:IntroCompare.gpu',
      [
        'intro:IntroCompare.gpu.ours',
        'intro:IntroCompare.no',
        'intro:IntroCompare.no',
        'intro:IntroCompare.no',
        'intro:IntroCompare.no',
      ],
    ],
    [
      'intro:IntroCompare.video',
      [
        'intro:IntroCompare.video.ours',
        'intro:IntroCompare.no',
        'intro:IntroCompare.no',
        'intro:IntroCompare.no',
        'intro:IntroCompare.no',
      ],
    ],
    [
      'intro:IntroCompare.usb',
      [
        'intro:IntroCompare.usb.ours',
        'intro:IntroCompare.no',
        'intro:IntroCompare.no',
        'intro:IntroCompare.no',
        'intro:IntroCompare.no',
      ],
    ],
    [
      'intro:IntroCompare.network',
      [
        'intro:IntroCompare.network.ours',
        'intro:IntroCompare.network.unkernel',
        'intro:IntroCompare.network.webvm',
        'intro:IntroCompare.network.v86',
        'intro:IntroCompare.network.jslinux',
      ],
    ],
    [
      'intro:IntroCompare.images',
      [
        'intro:IntroCompare.images.ours',
        'intro:IntroCompare.images.unkernel',
        'intro:IntroCompare.images.webvm',
        'intro:IntroCompare.images.v86',
        'intro:IntroCompare.images.jslinux',
      ],
    ],
    [
      'intro:IntroCompare.browsers',
      [
        'intro:IntroCompare.browsers.ours',
        'intro:IntroCompare.browsers.unkernel',
        'intro:IntroCompare.browsers.webvm',
        'intro:IntroCompare.browsers.v86',
        'intro:IntroCompare.browsers.jslinux',
      ],
    ],
    [
      'intro:IntroCompare.license',
      [
        'intro:IntroCompare.license.ours',
        'intro:IntroCompare.license.unkernel',
        'intro:IntroCompare.license.webvm',
        'intro:IntroCompare.license.v86',
        'intro:IntroCompare.unconfirmed',
      ],
    ],
  ];

  /** What the others do better: an entry's title and its paragraph. */
  const LEADS = [
    ['intro:IntroCompare.leads.first', 'intro:IntroCompare.leads.first.words'],
    ['intro:IntroCompare.leads.browsers', 'intro:IntroCompare.leads.browsers.words'],
    ['intro:IntroCompare.leads.memory', 'intro:IntroCompare.leads.memory.words'],
    ['intro:IntroCompare.leads.syscalls', 'intro:IntroCompare.leads.syscalls.words'],
  ] as const;
</script>

<IntroSection id="intro-compare" title={t('intro:IntroCompare.title')} bind:ref>
  {#snippet lede()}<T k="intro:IntroCompare.lede" params={{ when: day(CHECKED) }} />{/snippet}
  <IntroSpeed lead={SPEED_LEAD} />
  <div class="scroll">
    <table>
      <caption class="sr">{t('intro:IntroCompare.caption')}</caption>
      <thead>
        <tr>
          <td></td>
          {#each PEERS as p (p.id)}<th scope="col" data-peer={p.id}>{p.name}</th>{/each}
        </tr>
      </thead>
      <tbody>
        {#each ROWS as [row, cells] (row)}
          <tr>
            <th scope="row">{t(row)}</th>
            {#each PEERS as p, i (p.id)}
              <td
                data-peer={p.id}
                class={{ none: cells[i] === 'intro:IntroCompare.no' || cells[i] === 'intro:IntroCompare.unconfirmed' }}
                >{t(cells[i] ?? 'intro:IntroCompare.unconfirmed')}</td
              >
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <h3>{t('intro:IntroCompare.leads')}</h3>
  <dl>
    {#each LEADS as [lead, words] (lead)}
      <div>
        <dt>{t(lead)}</dt>
        <dd>{t(words)}</dd>
      </div>
    {/each}
  </dl>
  <p class="sources">
    {t('intro:IntroCompare.sources')}
    {#each SOURCES as p (p.id)}<a href={p.source} {...EXTERNAL}>{p.name}</a>{/each}
  </p>
</IntroSection>

<style>
  .scroll {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-raised);
    box-shadow: var(--card-edge);
  }
  table {
    width: 100%;
    min-width: 900px;
    border-collapse: collapse;
    table-layout: fixed;
  }
  th,
  td {
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
    font-weight: var(--weight-normal);
  }
  thead th,
  thead td {
    border-top: 0;
    background: var(--surface-bar);
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
  }
  /* A row's heading, as a panel's label: it stays at the table's start when the table scrolls sideways. */
  tbody th,
  thead td {
    position: sticky;
    left: 0;
    width: 150px;
    background: var(--surface-bar);
    color: var(--text-dim);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    letter-spacing: var(--label-tracking);
    text-transform: uppercase;
  }
  /* Ours: the lit column, a rail down its start. */
  [data-peer='ours'] {
    background: var(--pressed-bg);
    box-shadow: var(--chosen-edge);
  }
  thead [data-peer='ours'] {
    color: var(--accent);
    text-shadow: var(--lit-text);
  }
  td {
    color: var(--text);
  }
  td:not([data-peer='ours']) {
    color: var(--text-dim);
  }
  /* A feature the project doesn't have, or one we couldn't confirm: stepped back. */
  td.none {
    opacity: 0.6;
  }
  h3 {
    margin: var(--space-5) 0 0;
    font-size: var(--text-lede);
  }
  dl {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 0 var(--space-7);
    margin: 0;
  }
  dl div {
    padding: var(--space-5) 0;
    border-top: 1px solid var(--border);
    box-shadow: var(--card-edge);
  }
  dt {
    margin-bottom: var(--space-2);
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
  }
  dd {
    margin: 0;
    color: var(--text-dim);
  }
  .sources {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    margin: 0;
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  a {
    color: var(--accent);
  }
</style>
