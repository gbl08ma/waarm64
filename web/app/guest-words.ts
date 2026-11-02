// The words the page has a guest show (docs/frontend.md "What the page sets in the guest"): the descriptions of the
// systemd units it gives as credentials (`systemctl status`, the boot's log). The page renders them here and sends them
// with the start (web/app/protocol.ts `guest`); the worker builds the units around them (web/app/guest-unit.ts).
import { t } from '../i18n.ts';
import type { GuestWords } from './guest-unit.ts';

export const guestWords = (): GuestWords => ({
  keyboard: t('guest:guest-words.keyboard'),
  network: t('guest:guest-words.network'),
  shares: t('guest:guest-words.shares'),
});
