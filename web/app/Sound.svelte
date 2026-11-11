<!--
  Sound (docs/frontend.md "Sound"): on by default; muted, the volume and the microphone's choices are kept in this
  browser. Any click or key on the page lets the browser play it (its autoplay rule): until one, the menu says sound is
  waiting. A guest that has the sound device's Master volume and switch (web/audio.ts) moves the volume and Sound on
  here, and they move its.
-->
<script lang="ts">
  import Menu from './ui/Menu.svelte';
  import Check from './ui/Check.svelte';
  import type { PageAudio } from '../audio.ts';
  import { remember, settings } from './settings.ts';
  import { ui } from './ui.svelte.ts';
  import { t } from '../i18n.ts';

  let { audio }: { audio: PageAudio } = $props();

  let on = $state(!(settings().muted ?? false));
  let volume = $state(Math.round(100 * Math.min(1, Math.max(0, settings().volume ?? 1))));
  let mic = $state(settings().mic ?? true);
  let micRaw = $state(settings().micRaw ?? false);
  // The audio's own state (waiting for a gesture, the microphone's), redrawn when it says it changed.
  let tick = $state(0);
  $effect(() => {
    audio.onChange = () => tick++;
  });
  // The guest's own changes: shown, not kept (the next machine starts at what the user chose).
  $effect(() => {
    audio.onMixer = (level, muted) => {
      [volume, on] = [Math.round(100 * level), !muted];
    };
  });
  const waiting = $derived((void tick, audio.waiting()));
  const micState = $derived((void tick, audio.micState));
  $effect(() => {
    ui.mic = micState;
  }); // the status bar's Microphone
  const summary = $derived(
    waiting
      ? t('sound:Sound.summary.waiting')
      : micState === 'on'
        ? on
          ? t('sound:Sound.summary.onMic')
          : t('sound:Sound.summary.mutedMic')
        : on
          ? t('sound:Sound.summary.on')
          : t('sound:Sound.summary.muted'),
  );

  $effect(() => {
    audio.setVolume(volume / 100, !on);
  });
  $effect(() => {
    audio.setMic(mic, micRaw);
  });
  const keepSound = () => {
    remember({ muted: !on, volume: volume / 100 });
    audio.setVolume(volume / 100, !on, true);
  };
  const keepMic = () => remember({ mic, micRaw });
</script>

<Menu
  id="sound-menu"
  icon={on && !waiting ? 'volume' : 'volume-off'}
  title={summary}
  panel
  data-waiting={waiting || undefined}
>
  {#snippet badge()}<span id="sound-summary" class="sr">{summary}</span>{#if micState === 'on'}<span class="tag"
        >{t('sound:Sound.micTag')}</span
      >{/if}{/snippet}
  <Check id="sound-on" bind:checked={on} onchange={keepSound}>{t('sound:Sound.on')}</Check>
  <label
    >{t('sound:Sound.volume')}<input
      id="sound-volume"
      type="range"
      min="0"
      max="100"
      step="1"
      bind:value={volume}
      oninput={keepSound}
    /></label
  >
  <Check id="mic-on" bind:checked={mic} onchange={keepMic} title={t('sound:Sound.mic.title')}
    >{t('sound:Sound.mic')}</Check
  >
  <Check id="mic-raw" bind:checked={micRaw} onchange={keepMic} title={t('sound:Sound.micRaw.title')}
    >{t('sound:Sound.micRaw')}</Check
  >
  <p class="hint" id="sound-hint">{t('sound:Sound.hint')}</p>
  <p class="hint" id="mic-hint" hidden={micState !== 'denied' && micState !== 'asking'}>
    {micState === 'denied' ? t('sound:Sound.mic.denied') : t('sound:Sound.mic.asking')}
  </p>
</Menu>
