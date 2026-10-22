<!--
  The page (docs/frontend.md): the toolbar, the message bar, the machine (its screen and serial terminal) or the
  Machines page in its place, the status line, and the page's questions. web/app/main.ts runs the machine: it draws on
  the canvas and the terminal here, and writes what the rest shows into `ui` (web/app/ui.svelte.ts).
-->
<script lang="ts">
  import Ask from './Ask.svelte';
  import Icon from './Icon.svelte';
  import MachinesPage from './MachinesPage.svelte';
  import NetWizard from './NetWizard.svelte';
  import Toolbar from './Toolbar.svelte';
  import type { PageAudio } from '../audio.ts';
  import type { PageNetwork } from './net-live.ts';
  import type { Store } from './store.ts';
  import { page, ui } from './ui.svelte.ts';

  let { store, audio, net }: { store: Store; audio: PageAudio; net: PageNetwork } = $props();

  $effect(() => { document.body.dataset.page = ui.machinesOpen ? 'machines' : 'machine'; });

  // The files the page takes (the inputs stay in the page, for the menus that open them and for tests).
  const take = (f: (file: File) => void) => (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) f(file);
  };
</script>

<Toolbar {store} {audio} {net} />
<div id="message" role="alert" hidden={!ui.message} data-kind={ui.messageKind} data-snapshot={ui.snapshotResult || undefined}>
  <pre id="message-text">{ui.message}</pre>
  <div id="message-actions">{#each ui.actions as a (a)}<button onclick={(e) => a.run(e.currentTarget)}>{a.label}</button>{/each}</div>
  <button id="message-close" class="close" aria-label="Close" title="Close" onclick={() => page.dismiss()}><Icon name="x" size={16} /></button>
</div>
<main>
  <div id="screen-view">
    <div id="screen-frame">
      <canvas id="screen" tabindex="0" aria-label="Machine screen"></canvas><div id="screen-hint">{ui.mouseLock ? 'Click to type and take the mouse (Esc lets it go)' : 'Click to type'}</div>
      <div id="screen-cursor-clip"><canvas id="screen-cursor" width="64" height="64" hidden></canvas></div>
      <div id="boot" hidden={!ui.boot.shown}>
        <div id="boot-title">{ui.boot.title}</div>
        {#if ui.boot.progress === undefined}<progress id="boot-progress"></progress>{:else}<progress id="boot-progress" value={ui.boot.progress}></progress>{/if}
        <div id="boot-line">{ui.boot.line}</div>
        <div id="boot-serial" hidden={!ui.boot.serial}><span>The boot menus, and a first boot's questions, are on the serial console.</span><button id="boot-serial-show" onclick={() => page.showLog()}>Show it</button></div>
      </div>
    </div>
  </div>
  <div id="terminal-view"><div id="terminal"></div></div>
</main>
{#if ui.machinesOpen}<MachinesPage {store} {net} />{/if}
<footer>
  <span id="state" data-state={ui.state}>{ui.stateText}</span>
  <span id="status" data-status={ui.status.data || undefined}>{ui.status.text}</span>
</footer>
<NetWizard {net} />
<Ask />
<input type="file" id="load-snapshot-input" hidden onchange={take((f) => page.loadSnapshot(f))}>
<input type="file" id="open-disk-input" hidden onchange={take((f) => page.openDiskFile(f))}>
<input type="file" id="load-changes-input" hidden onchange={take((f) => page.importChanges(f))}>
