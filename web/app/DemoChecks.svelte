<!--
  What a demo needs of the browser, checked before its download (DemoStart.svelte; web/app/demo-check.ts): a line
  per check with its light, met, a warning (it may still run) or a stop (it can't).
-->
<script lang="ts">
  import StatusDot from './ui/StatusDot.svelte';
  import T from './T.svelte';
  import type { Check, CheckLevel } from './demo-check.ts';
  import { msg } from '../i18n.ts';

  type Props = { checks: readonly Check[] };
  let { checks }: Props = $props();
  const TONE: Record<CheckLevel, 'ok' | 'busy' | 'bad'> = { ok: 'ok', warn: 'busy', fail: 'bad' };
  /** Each check's words by what it checks and how it went. */
  const WORDS: Record<string, string> = {
    'browser.ok': 'machines:DemoChecks.browser.ok',
    'browser.warn': 'machines:DemoChecks.browser.warn',
    'isolation.ok': 'machines:DemoChecks.isolation.ok',
    'isolation.fail': 'machines:DemoChecks.isolation.fail',
    'opfs.ok': 'machines:DemoChecks.opfs.ok',
    'opfs.fail': 'machines:DemoChecks.opfs.fail',
    'webgl2.ok': 'machines:DemoChecks.webgl2.ok',
    'webgl2.fail': 'machines:DemoChecks.webgl2.fail',
    'webgpu.ok': 'machines:DemoChecks.webgpu.ok',
    'webgpu.fail': 'machines:DemoChecks.webgpu.fail',
    'memory.ok': 'machines:DemoChecks.memory.ok',
    'memory.warn': 'machines:DemoChecks.memory.warn',
    'storage.ok': 'machines:DemoChecks.storage.ok',
    'storage.fail': 'machines:DemoChecks.storage.fail',
    'mobile.warn': 'machines:DemoChecks.mobile.warn',
  };
  const words = (c: Check) => msg(WORDS[`${c.what}.${c.level}`] ?? '', c.params);
</script>

<ul>
  {#each checks as c (c.what)}
    <li data-check={c.what} data-level={c.level}>
      <StatusDot tone={TONE[c.level]} />
      <span><T m={words(c)} /></span>
    </li>
  {/each}
</ul>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  li {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    font-size: var(--text-md);
  }
</style>
