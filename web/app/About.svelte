<!--
  The Machines page's About pane (docs/frontend.md "About"): webpc's repository, the commit (and tag) the page was built
  from and its date, webpc's license, and the third-party projects built into it or whose code ours is derived from,
  each with its license and pinned links to its license texts. The data is `virtual:webpc-about` (vite.config.ts,
  tools/third-party.ts `aboutData`): THIRD_PARTY.json's rows marked for this pane, nothing else of that file.
-->
<script lang="ts">
  import about from 'virtual:webpc-about';
  import Note from './ui/Note.svelte';
  import T from './T.svelte';
  import { t } from '../i18n.ts';
  import type { Group } from '../../tools/third-party.ts';

  /** Every link to another site opens apart from the page and tells that site nothing of it. */
  const EXTERNAL = { target: '_blank', rel: 'external nofollow noopener noreferrer' };
  /** A license file beside the page: same origin, opened apart from the page. */
  const BESIDE = { target: '_blank', rel: 'noopener' };

  const GROUP_WORDS: Record<Group, string> = {
    page: 'machines:About.group.page',
    core: 'machines:About.group.core',
    graphics: 'machines:About.group.graphics',
    vulkan: 'machines:About.group.vulkan',
    network: 'machines:About.group.network',
    firmware: 'machines:About.group.firmware',
    agent: 'machines:About.group.agent',
  };

  const b = about.build;
  const repo = about.repository.replace(/\.git$/, '');
  const commit = b?.commit.slice(0, 12) ?? '';
</script>

<div class="about" data-about>
  <dl>
    <dt>{t('machines:About.source')}</dt>
    <dd><a href={repo} {...EXTERNAL} data-about-link="repository">{repo.replace(/^https:\/\//, '')}</a></dd>
    <dt>{t('machines:About.version')}</dt>
    <dd data-about-version>
      {#snippet tag(text: string)}<a href={`${repo}/tree/${b?.tag}`} {...EXTERNAL}>{text}</a>{/snippet}
      {#snippet hash(text: string)}<a href={`${repo}/commit/${b?.commit}`} {...EXTERNAL}><code>{text}</code></a
        >{/snippet}
      {#if b?.tag && b.dirty}<T k="machines:About.version.tagDirty" params={{ tag: b.tag, commit }} {tag} {hash} />
      {:else if b?.tag}<T k="machines:About.version.tag" params={{ tag: b.tag, commit }} {tag} {hash} />
      {:else if b?.dirty}<T k="machines:About.version.commitDirty" params={{ commit }} {hash} />
      {:else if b}<T k="machines:About.version.commit" params={{ commit }} {hash} />
      {:else}{t('machines:About.unknown')}{/if}
    </dd>
    <dt title={t('machines:About.date.title')}>{t('machines:About.date')}</dt>
    <dd data-about-date>
      {b ? t('machines:About.date.value', { when: new Date(b.date) }) : t('machines:About.unknown')}
    </dd>
    <dt>{t('machines:About.license')}</dt>
    <dd><a href={about.licenseHref} {...BESIDE}>{about.license}</a></dd>
  </dl>

  <h4>{t('machines:About.thirdParty')}</h4>
  <Note>{t('machines:About.thirdParty.intro')}</Note>
  {#each about.groups as g (g.group)}
    <section data-about-group={g.group}>
      <h5>{t(GROUP_WORDS[g.group])}</h5>
      <div class="scroll">
        <table>
          <colgroup
            ><col class="c-project" /><col class="c-version" /><col class="c-license" /><col
              class="c-texts"
            /></colgroup
          >
          <thead
            ><tr
              ><th>{t('machines:About.col.project')}</th><th>{t('machines:About.col.version')}</th><th
                >{t('machines:About.col.license')}</th
              ><th>{t('machines:About.col.texts')}</th></tr
            ></thead
          >
          <tbody>
            {#each g.projects as p (p.name + p.version)}
              <tr data-project={p.name}>
                <td
                  ><a href={p.url} {...EXTERNAL}>{p.name}</a>{#if p.derived}<span
                      class="derived"
                      title={t('machines:About.derived.title')}>{t('machines:About.derived')}</span
                    >{/if}</td
                >
                <td><code>{p.version}</code></td>
                <td>{p.license}</td>
                <td
                  ><span class="texts"
                    >{#each p.licenseTexts as text (text.url)}<a href={text.url} {...EXTERNAL}>{text.name}</a
                      >{/each}</span
                  ></td
                >
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#each g.bundled as file (file.name)}
        <div class="bundled">
          <Note>
            <T k="machines:About.bundled" params={{ file: file.name }}
              >{#snippet link(text: string)}<a href={file.href} {...BESIDE}>{text}</a>{/snippet}</T
            >
          </Note>
        </div>
      {/each}
    </section>
  {/each}
</div>

<style>
  .about {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-3) var(--space-5);
    margin: 0 0 var(--space-3);
  }
  dt {
    color: var(--text-dim);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  h4 {
    margin: var(--space-3) 0 0;
    font-size: var(--text-base);
    font-weight: var(--weight-bold);
  }
  h5 {
    margin: var(--space-4) 0 var(--space-3);
    font-size: var(--text-md);
    font-weight: var(--weight-bold);
  }
  .bundled {
    margin-top: var(--space-2);
  }
  .scroll {
    overflow-x: auto;
  }
  /* The same columns in every group's table. */
  table {
    border-collapse: collapse;
    font-size: var(--text-sm);
    width: 100%;
    min-width: 640px;
    table-layout: fixed;
  }
  .c-project {
    width: 30%;
  }
  .c-version {
    width: 20%;
  }
  .c-license {
    width: 25%;
  }
  .c-texts {
    width: 25%;
  }
  td {
    overflow-wrap: anywhere;
  }
  th {
    text-align: start;
    font-weight: var(--weight-bold);
    color: var(--text-dim);
  }
  th,
  td {
    padding: var(--space-2) var(--space-4) var(--space-2) 0;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  td code {
    font-size: var(--text-xs);
  }
  .texts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
  }
  .derived {
    margin-left: var(--space-3);
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-dim);
    font-size: var(--text-xs);
    white-space: nowrap;
  }
  a {
    color: inherit;
  }
</style>
