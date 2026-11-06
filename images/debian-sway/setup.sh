# Run in the guest by images/debian-sway/build.sh (as root, after apt has installed sway, wl-clipboard, grim, Xvfb, xauth
# and xclip): the user `user` (uid 1000, no password), logged in on tty1 by getty at boot, whose login shell runs a
# headless sway there, or Xvfb once /tmp/x11 exists (the X11 test's switch: its next login).
set -e
useradd -m -u 1000 -s /bin/bash user
passwd -d user
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=-/sbin/agetty -o '-f -- \\u' --noreset --noclear --autologin user - ${TERM}
UNIT
# sway on tty1, the session's whole life (the shell logs out when it ends: getty logs the user in again, so sway comes
# back in a new session). Headless: no DRM, no input devices, drawn by pixman; its log, and how it ended, appended to
# /tmp/sway.log. /tmp/no-sway keeps it from starting. With /tmp/x11, an X11 session instead, as startx makes one: Xvfb on
# display 1 with a cookie of its own (`-auth ~/.Xauthority`, xauth's), its log and its end in /tmp/x11.log.
cat >> /home/user/.bash_profile <<'PROFILE'
if [ "$(tty)" = /dev/tty1 ] && [ -e /tmp/x11 ]; then
  echo "== Xvfb at $(date +%T) in session $XDG_SESSION_ID" >>/tmp/x11.log
  xauth -q add :1 MIT-MAGIC-COOKIE-1 "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  Xvfb :1 -auth "$HOME/.Xauthority" -nolisten tcp -screen 0 800x600x24 >>/tmp/x11.log 2>&1
  echo "== Xvfb ended: $?" >>/tmp/x11.log
  logout
elif [ "$(tty)" = /dev/tty1 ] && [ ! -e /tmp/no-sway ]; then
  export WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1
  echo "== sway at $(date +%T) in session $XDG_SESSION_ID" >>/tmp/sway.log
  sway >>/tmp/sway.log 2>&1
  echo "== sway ended: $?" >>/tmp/sway.log
  logout
fi
PROFILE
mkdir -p /home/user/.config/sway
# No bar, no background, nothing on a timer: an idle sway.
echo 'output * resolution 800x600' > /home/user/.config/sway/config
chown -R user:user /home/user
echo ==x11 $(command -v Xvfb xauth xclip | tr '\n' ' ')$(dpkg-query -W -f='${Version} ' xvfb xauth xclip 2>/dev/null)
echo ==sway $(sway --version) $(dpkg-query -W -f='${Version} ' wl-clipboard grim libwlroots-0.18 2>/dev/null) $(id user)
