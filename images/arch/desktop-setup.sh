# images/arch/desktop.sh's setup, run as root in the image's container by images/arch/build.sh --setup (the packages
# installed, the files in place).
# Sound: the kernel's own module (Arch builds CONFIG_SND_VIRTIO=m; udev loads it when the device is there).
K=$(ls /usr/lib/modules)
find /usr/lib/modules/$K -name 'virtio_snd.ko*' | grep -q . || { echo "no virtio_snd in $K" >&2; exit 1; }
# Video: webpc's VA-API driver (Mesa's virgl with NV12 surfaces only; LIBVA_DRIVER_NAME=webpc for every session).
pacman -U --noconfirm --noprogressbar /root/pkg/webpc-va-*.pkg.tar.* >/dev/null
pacman -Q webpc-va
rm -rf /root/pkg
# Vulkan: Venus presents on the calling thread (VN_PERF=no_async_present; VK3 L4e, vk/README.md "The guest's Mesa"):
# Mesa's async present (26.2, and main as of 2026-10-27) hands a present's error to the next present, of any swapchain,
# and drops that one unsubmitted, so a present to a swapchain retired meanwhile (a resize while the last frame's GPU work
# is slow) loses the new swapchain's first frame and its fence: the window freezes and the app can't exit. For PAM's
# sessions (logins) and systemd's user services.
# (/etc/environment's last line has no newline of its own.)
sed -i -e '$a\' /etc/environment && echo 'VN_PERF=no_async_present' >> /etc/environment
mkdir -p /etc/environment.d && echo 'VN_PERF=no_async_present' > /etc/environment.d/50-webpc-venus.conf
# PipeWire for every user's session (socket-activated; the packages' presets, made sure of).
systemctl --global enable pipewire.socket pipewire-pulse.socket wireplumber.service
# Firefox: autoplay with sound allowed (the clips start themselves), no first-run pages or default-browser prompt.
mkdir -p /usr/lib/firefox/distribution
cat > /usr/lib/firefox/distribution/policies.json <<'J'
{ "policies": {
  "Permissions": { "Autoplay": { "Default": "allow-audio-video" } },
  "DontCheckDefaultBrowser": true, "DisableTelemetry": true, "OverrideFirstRunPage": "", "OverridePostUpdatePage": "",
  "UserMessaging": { "WhatsNew": false, "ExtensionRecommendations": false, "FeatureRecommendations": false, "SkipOnboarding": true }
} }
J
# KDE (images/arch/desktop.sh --kde): Plasma's login manager on the screen at boot.
if pacman -Q plasma-login-manager >/dev/null 2>&1; then
  systemctl enable plasmalogin.service
  systemctl set-default graphical.target
  echo "desktop: plasma-login-manager enabled"
fi
echo "desktop: virtio_snd in $K, webpc-va, PipeWire, Firefox's policies"
