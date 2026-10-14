# images/archarm/desktop.sh's setup, run as root in the image's container by images/archarm/build.sh --setup (the
# packages installed, the files in place).
# Sound: our package; DKMS's pacman hook builds virtio_snd for the image's kernel (its headers are installed).
pacman -U --noconfirm --noprogressbar /root/pkg/virtio-snd-dkms-*.pkg.tar.* 2>&1 | grep -i -E "dkms|error" || true
K=$(basename "$(dirname /usr/lib/modules/*/build)") # the kernel whose headers are installed: the image's
dkms status
dkms status | grep -q "virtio-snd/.*, $K, aarch64: installed" || { echo "virtio-snd isn't installed for $K" >&2; exit 1; }
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
echo "desktop: virtio-snd for $K, webpc-va, PipeWire, Firefox's policies"
