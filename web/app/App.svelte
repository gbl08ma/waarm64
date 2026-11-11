<!--
  The page (docs/frontend.md): the toolbar, the message bar, the machine (its screen and serial terminal) or the
  Machines page in its place, the status line, and the page's questions. web/app/main.ts runs the machine: it draws on
  the canvas and the terminal here, and writes what the rest shows into `ui` (web/app/ui.svelte.ts).
-->
<script lang="ts">
  import Ask from './Ask.svelte';
  import FilePickers from './FilePickers.svelte';
  import FolderWizard from './FolderWizard.svelte';
  import Button from './ui/Button.svelte';
  import ErrorBanner from './ui/ErrorBanner.svelte';
  import MachinesPage from './MachinesPage.svelte';
  import NetWizard from './NetWizard.svelte';
  import Osk from './Osk.svelte';
  import StatusBar from './StatusBar.svelte';
  import Toolbar from './Toolbar.svelte';
  import type { PageAudio } from '../audio.ts';
  import type { PageFolders } from './folders-live.ts';
  import type { PageNetwork } from './net-live.ts';
  import type { Store } from './store.ts';
  import { page, ui } from './ui.svelte.ts';
  import { t } from '../i18n.ts';

  let { store, audio, net, folders }: { store: Store; audio: PageAudio; net: PageNetwork; folders: PageFolders } =
    $props();

  $effect(() => {
    document.body.dataset.page = ui.machinesOpen ? 'machines' : 'machine';
  });
</script>

<Toolbar {store} {audio} {net} {folders} />
<!-- Its own wrapper: the page in full screen hides it. -->
<div class="message">
  <ErrorBanner
    id="message"
    role="alert"
    tone={ui.messageKind === 'warn' ? 'warn' : 'error'}
    hidden={!ui.message}
    data-kind={ui.messageKind}
    data-snapshot={ui.snapshotResult || undefined}
    bodyId="message-body"
    actionsId="message-actions"
    dismissId="message-close"
    dismissLabel={t('common:App.message.close')}
    ondismiss={() => page.dismiss()}
  >
    <pre id="message-text">{ui.message}</pre>
    {#if ui.messageDetails.length}<pre id="message-details">{ui.messageDetails.join('\n')}</pre>{/if}
    {#snippet actions()}
      {#each ui.actions as a (a)}<Button
          onclick={(e: MouseEvent & { currentTarget: HTMLButtonElement }) => a.run(e.currentTarget)}>{a.label}</Button
        >{/each}
    {/snippet}
  </ErrorBanner>
</div>
<main>
  <div id="screen-view">
    <div id="screen-frame">
      <canvas id="screen" tabindex="0" aria-label={t('common:App.screen.label')}></canvas>
      <div id="screen-hint">{ui.mouseLock ? t('common:App.screen.hintLock') : t('common:App.screen.hint')}</div>
      <div id="screen-cursor-clip"><canvas id="screen-cursor" width="64" height="64" hidden></canvas></div>
      <div id="boot" hidden={!ui.boot.shown}>
        <div id="boot-title">{ui.boot.title}</div>
        {#if ui.boot.progress === undefined}<progress id="boot-progress"></progress>{:else}<progress
            id="boot-progress"
            value={ui.boot.progress}
          ></progress>{/if}
        <div id="boot-line">{ui.boot.line}</div>
        <div id="boot-serial" hidden={!ui.boot.serial}>
          <span>{t('common:App.boot.serial')}</span><Button id="boot-serial-show" onclick={() => page.showLog()}
            >{t('common:App.boot.serial.show')}</Button
          >
        </div>
      </div>
    </div>
  </div>
  <div id="terminal-view"><div id="terminal"></div></div>
  {#if ui.osk}<Osk
      send={(code, down, mods, repeat) => page.oskKey(code, down, mods, repeat)}
      keyLayout={ui.keyLayout}
      mode={ui.oskModifiers}
      released={ui.keysReleased}
      typed={ui.keyTyped}
      leds={ui.leds}
      onclose={() => {
        ui.osk = false;
      }}
    />{/if}
</main>
{#if ui.machinesOpen}<MachinesPage {store} {net} {folders} />{/if}
<StatusBar {net} />
<NetWizard {net} />
<FolderWizard {folders} />
<Ask />
<FilePickers />

<style>
  pre {
    margin: 0;
    white-space: pre-wrap;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
  #message-text::first-line {
    font-weight: var(--weight-bold);
  }
  #message-details {
    opacity: 0.8;
  }

  /* The machine: its screen, its serial terminal, or both (`body[data-view]`, which main.ts sets at once with
     `ui.view`: it measures the screen's room right after). */
  main {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: var(--space-4);
    padding: var(--space-4);
  }
  main:fullscreen {
    background: var(--surface);
  }
  #screen-view {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  #screen-frame {
    position: relative;
    display: flex;
  }
  #screen {
    background: var(--screen-bg);
    outline: none;
    box-shadow: var(--shadow-frame);
    touch-action: none;
  }
  #screen:focus {
    box-shadow: var(--shadow-focus);
  }
  #screen-hint {
    position: absolute;
    bottom: var(--space-5);
    left: 50%;
    transform: translateX(-50%);
    padding: var(--space-2) var(--space-4);
    border-radius: 999px;
    background: var(--screen-overlay);
    color: var(--text);
    font-size: var(--text-sm);
    pointer-events: none;
  }
  #screen:focus + #screen-hint,
  :global(body:not([data-state='running'], [data-state='booting'])) #screen-hint {
    display: none;
  }
  /* The guest's cursor under the mouse lock: clipped to the screen, as a cursor is, so it never makes the page overflow. */
  #screen-cursor-clip {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  #screen-cursor {
    position: absolute;
    left: 0;
    top: 0;
  }
  #boot {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    padding: var(--space-6);
    background: var(--screen-bg);
    color: var(--text-dim);
    pointer-events: none;
  }
  #boot-title {
    color: var(--text);
    font-size: var(--text-lg);
  }
  #boot progress {
    width: min(320px, 80%);
    height: 6px;
    accent-color: var(--accent);
  }
  #boot-serial {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-3);
    font-size: var(--text-md);
    pointer-events: auto;
  }
  #boot-line {
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
  #terminal-view {
    min-height: 0;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    overflow: auto;
  }
  #terminal {
    padding: var(--space-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  #terminal:focus-within {
    border-color: var(--accent);
  }
  :global(body[data-view='screen']) #terminal-view,
  :global(body[data-view='terminal']) #screen-view {
    display: none;
  }
  :global(body[data-view='terminal']) #terminal-view {
    flex: 1;
  }
  :global(body[data-view='screen']) main {
    padding: 0;
  }
  :global(body[data-view='screen']) #screen-view {
    background: var(--screen-bg);
  }
  :global(body[data-view='screen']) #screen {
    box-shadow: none;
  }
  /* The Machines page takes the machine's place; the machine runs on behind it. */
  :global(body[data-page='machines']) main {
    display: none;
  }
  /* Full screen with the status bar (Preferences): the page, without its toolbar and message bar. */
  :global(body:fullscreen) .message {
    display: none;
  }
  @media (max-width: 1100px) {
    :global(body[data-view='both']) main {
      flex-direction: column;
    }
  }
</style>
