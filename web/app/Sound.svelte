<!--
  Sound (docs/frontend.md "Sound"): on by default; muted, the volume and the microphone's choices are kept in this
  browser. Any click or key on the page lets the browser play it (its autoplay rule): until one, the menu says sound is
  waiting. A guest that has the sound device's Master volume and switch (web/audio.ts) moves the volume and Sound on
  here, and they move its.
-->
<script lang="ts">
  import Menu from './ui/Menu.svelte';
  import Check from './ui/Check.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import type { PageAudio } from '../audio.ts';
  import { remember, settings } from './settings.ts';
  import { sound } from './areas/sound.svelte.ts';
  import { t } from '../i18n.ts';

  let { audio }: { audio: PageAudio } = $props();

  let on = $state(!(settings().muted ?? false));
  let volume = $state(Math.round(100 * Math.min(1, Math.max(0, settings().volume ?? 1))));
  let mic = $state(settings().mic ?? true);
  let micRaw = $state(settings().micRaw ?? false);
  // The guest's own changes: shown, not kept (the next machine starts at what the user chose).
  $effect(() => {
    audio.onMixer = (level, muted) => {
      [volume, on] = [Math.round(100 * level), !muted];
    };
  });
  // The audio's own state (waiting for a gesture, the microphone's), as web/app/areas/sound.svelte.ts follows it.
  const waiting = $derived(sound.waiting);
  const micState = $derived(sound.mic);
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
  attention={waiting}
  data-waiting={waiting || undefined}
>
  {#snippet badge()}<span id="sound-summary" class="sr">{summary}</span>{#if micState === 'on'}<span class="tag"
        >{t('sound:Sound.micTag')}</span
      >{/if}{/snippet}
  <Check id="sound-on" bind:checked={on} onchange={keepSound}>{t('sound:Sound.on')}</Check>
  <Field label={t('sound:Sound.volume')}
    ><input id="sound-volume" type="range" min="0" max="100" step="1" bind:value={volume} oninput={keepSound} /></Field
  >
  <Check id="mic-on" bind:checked={mic} onchange={keepMic} title={t('sound:Sound.mic.title')}
    >{t('sound:Sound.mic')}</Check
  >
  <Check id="mic-raw" bind:checked={micRaw} onchange={keepMic} title={t('sound:Sound.micRaw.title')}
    >{t('sound:Sound.micRaw')}</Check
  >
  <Note id="sound-hint">{t('sound:Sound.hint')}</Note>
  <Note id="mic-hint" hidden={micState !== 'denied' && micState !== 'asking'}>
    {micState === 'denied' ? t('sound:Sound.mic.denied') : t('sound:Sound.mic.asking')}
  </Note>
</Menu>

<style>
  /* The microphone's tag on the menu's button, while it listens. */
  .tag {
    font-size: var(--text-xs);
    color: var(--accent);
  }
</style>
