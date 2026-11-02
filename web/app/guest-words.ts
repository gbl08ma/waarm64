// The words the page has a guest show (docs/frontend.md "What the page sets in the guest"): the descriptions of the
// systemd units it gives as credentials (`systemctl status`, the boot's log). The page renders them here and sends them
// with the start (web/app/protocol.ts `guest`); the worker builds the units around them (web/app/guest-unit.ts).
import { t, text } from '../i18n.ts';
import type { GuestWords } from './guest-unit.ts';
import type { KeyboardLayout } from './keyboard.ts';

/** The words, with the keyboard layout `layout` the machine starts with (if any). */
export const guestWords = (layout?: KeyboardLayout): GuestWords => ({
  keyboard: t('guest:guest-words.keyboard'),
  network: t('guest:guest-words.network'),
  shares: t('guest:guest-words.shares'),
  ...(layout ? { layout: text(layout.label) } : {}),
});
