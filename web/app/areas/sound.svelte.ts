// The sound's state as the Sound menu and the status bar show it (docs/frontend.md "Sound"): web/audio.ts's
// `PageAudio` says when it changes (`onChange`, off its realtime path), and this reads it again.
import type { PageAudio } from '../../audio.ts';

class Sound {
  /** Sound waits for a click or a key on the page (the browser's autoplay rule). */
  waiting = $state(false);
  /** The microphone's state (web/audio.ts `micState`). */
  mic = $state<PageAudio['micState']>('idle');

  /** Follows `audio`'s state. */
  follow(audio: PageAudio) {
    const read = () => {
      this.waiting = audio.waiting();
      this.mic = audio.micState;
    };
    audio.onChange = read;
    read();
  }
}
export const sound = new Sound();
