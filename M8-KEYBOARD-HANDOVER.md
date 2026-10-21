# The guest's keyboard layout: handover for the dev VM (2026-10-21)

The setting is built and checked on Debian in a cloud session (docs/frontend.md "The keyboard layout"): a machine's
Keyboard layout in Machines → Settings, or `?keyboard=<id>` on the page, gives the guest SMBIOS credentials
(`web/app/keyboard.ts`; the core's type 11, ABI 47) that add `webpc-keyboard.service`, which sets the layout before
the logins. On Debian 13 `tests/page-debian.test.ts` (`?keyboard=gb`) checks the unit's result, localed's X11 layout
read back from `/etc/default/keyboard` and `XKB_DEFAULT_*` in a login's environment.

What the cloud couldn't do, on the desktop guest (`images/arch/desktop.sh`, Arch's systemd, sway, foot, Firefox):

1. `scripts/ci.sh`, `scripts/ci-debian.sh` and `scripts/ci-machines.sh` here. The cloud ran ci.sh without the
   image-based native tests (ABI 47 is a core change) and ci-debian's files except page-debian's and start's, which
   need linux-snd's and a fresh EDK2; page-debian's keyboard command was run by hand there and printed
   `==kbd success gb gb pc105.`
2. The desktop guest with `?keyboard=de` (German: `KeyY` types `z`, `Semicolon` `ö`):
   - `systemctl show -P Result webpc-keyboard.service` is `success`; `localectl status` shows `X11 Layout: de` and a
     `VC Keymap` converted from it (`de` or `de-latin1`), and `/etc/vconsole.conf` has it.
   - tty1: `KeyY` on the screen types `z` (read back from `/dev/vcs1` over the serial console). If the console is
     still US on this first boot (localed converts, but whether it reloads systemd-vconsole-setup then is what this
     checks), it should be right on the second; then the script should restart `systemd-vconsole-setup.service`
     itself when `/etc/vconsole.conf` changed.
   - sway from tty1 (`WLR_RENDERER=gles2 sway`), foot in it: `KeyY` types `z` there, and Firefox's address bar too.
     That is the Wayland path (`XKB_DEFAULT_*` from `/etc/environment` through pam_env): if sway shows US, check
     `cat /proc/$(pidof sway)/environ | tr '\0' '\n' | grep XKB` and whether Arch's `system-login` PAM stack reads
     `/etc/environment`.
3. A second boot with `?keyboard=pt` changes everything to Portuguese, and one without `?keyboard=` leaves `pt` (the
   setting's note says turning it off keeps the last layout).

Record what was found in docs/frontend.md "The keyboard layout" and docs/backlog.md "Keyboard layouts' loose ends",
and delete this file in that commit.
