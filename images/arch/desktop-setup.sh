# images/arch/desktop.sh's setup, run as root in the image's container by images/arch/build.sh --setup (the packages
# installed, the files in place).
# Sound: the kernel's own module (Arch builds CONFIG_SND_VIRTIO=m; udev loads it when the device is there).
K=$(ls /usr/lib/modules)
find /usr/lib/modules/$K -name 'virtio_snd.ko*' | grep -q . || { echo "no virtio_snd in $K" >&2; exit 1; }
# Video: webpc's VA-API driver (Mesa's virgl with NV12 surfaces only; LIBVA_DRIVER_NAME=webpc for every session).
pacman -U --noconfirm --noprogressbar /root/pkg/webpc-va-*.pkg.tar.* >/dev/null
pacman -Q webpc-va
rm -rf /root/pkg
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
echo "desktop: virtio_snd in $K, webpc-va, PipeWire, Firefox's policies"
