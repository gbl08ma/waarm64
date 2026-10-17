<!--
  Sound (docs/frontend.md "Sound"): on by default; muted, the volume and the microphone's choices are kept in this
  browser. Any click or key on the page lets the browser play it (its autoplay rule): until one, the menu says sound is
  waiting. A guest that has the sound device's Master volume and switch (web/audio.ts) moves the volume and Sound on
  here, and they move its.
-->
<script lang="ts">
  import Menu from './Menu.svelte';
  import type { PageAudio } from '../audio.ts';
  import { remember, settings } from './settings.ts';

  let { audio }: { audio: PageAudio } = $props();

  let on = $state(!(settings().muted ?? false));
  let volume = $state(Math.round(100 * Math.min(1, Math.max(0, settings().volume ?? 1))));
  let mic = $state(settings().mic ?? true);
  let micRaw = $state(settings().micRaw ?? false);
  // The audio's own state (waiting for a gesture, the microphone's), redrawn when it says it changed.
  let tick = $state(0);
  $effect(() => { audio.onChange = () => tick++; });
  // The guest's own changes: shown, not kept (the next machine starts at what the user chose).
  $effect(() => { audio.onMixer = (level, muted) => { [volume, on] = [Math.round(100 * level), !muted]; }; });
  const waiting = $derived((tick, audio.waiting()));
  const micState = $derived((tick, audio.micState));
  const summary = $derived(waiting ? 'Sound: click to hear' : `${on ? 'Sound' : 'Sound (muted)'}${micState === 'on' ? ' · mic' : ''}`);

  $effect(() => { audio.setVolume(volume / 100, !on); });
  $effect(() => { audio.setMic(mic, micRaw); });
  const keepSound = () => {
    remember({ muted: !on, volume: volume / 100 });
    audio.setVolume(volume / 100, !on, true);
  };
  const keepMic = () => remember({ mic, micRaw });
</script>

<Menu id="sound-menu" icon={on && !waiting ? 'volume' : 'volume-off'} title={summary} panel data-waiting={waiting || undefined}>
  {#snippet badge()}<span id="sound-summary" class="sr">{summary}</span>{#if micState === 'on'}<span class="tag">mic</span>{/if}{/snippet}
  <label class="row"><input id="sound-on" type="checkbox" bind:checked={on} onchange={keepSound}> Sound on</label>
  <label>Volume<input id="sound-volume" type="range" min="0" max="100" step="1" bind:value={volume} oninput={keepSound}></label>
  <label class="row" title="When the machine records, the page asks for the microphone (the browser asks you the first time); off, the machine records silence"><input id="mic-on" type="checkbox" bind:checked={mic} onchange={keepMic}> Microphone</label>
  <label class="row" title="The microphone as it comes: no echo cancellation, noise suppression or gain control (for music; for a call, leave it off)"><input id="mic-raw" type="checkbox" bind:checked={micRaw} onchange={keepMic}> Raw microphone</label>
  <p class="hint" id="sound-hint">Kept in this browser. The browser plays sound once the page has had a click or a key.</p>
  <p class="hint" id="mic-hint" hidden={micState !== 'denied' && micState !== 'asking'}>{micState === 'denied' ? "The browser refused the microphone: the machine records silence. Allow it in the site's settings, then turn Microphone off and on." : 'The machine is recording: the browser asks for the microphone.'}</p>
</Menu>
