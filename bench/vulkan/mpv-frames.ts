// VK2 L6: mpv's frames on Vulkan right (bench/vulkan/REPORT.md "VK2 L6"; vk/README.md "Imports"). The desktop guest
// (images/arch/desktop.sh) on a machine with Vulkan, sway on GLES, the media disk (bench/video/media-disk.sh) as its
// second disk: mpv pauses Sintel's H.264 trailer at 20 s fullscreen and takes a screenshot of its window (`screenshot-to-
// file … window`: what its VO draws), once per arm: on Vulkan with VA-API's surfaces imported (vkva) and decoded in the
// guest's CPU and uploaded (vkno), and on virgl's GL the same two ways (glva, glno). H.264 decodes exactly, so the
// arms of one renderer should match: each pair's bytes compared in the guest (how many are off by more than 24, how
// many differ at all, the largest difference, the mean). Each arm also records libplacebo's complaints (VK3 L4: "Failed
// creating FBO texture" while its advanced path is off) and Venus's submits. Writes <out>/results.json.
//   node bench/vulkan/mpv-frames.ts [image] [outdir]   (default target/arch/desktop.qcow2; SHIM=1 installs the media
//   disk's VA driver; GPU_KNOBS adds to the page's `?gpu=` (e.g. `vkformats=all`: the advanced path on); MPV_ARMS and
//   PAIRS replace the arms and comparisons; SHOT2=1 takes a second screenshot after turning debanding on (the frame
//   rendered anew); bench/gpu/sway-mac.sh runs it with SCRIPT=../vulkan/mpv-frames.ts, mode `-`)
import { mkdirSync, writeFileSync } from 'node:fs';
import { openSession } from '../gpu/guest-session.ts';

const args = process.argv.slice(2);
const out = args.at(-1) ?? new URL('../results/local/vk2/mpv-frames/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const image = (args.length > 1 ? args[0] : process.env.IMAGE) ?? new URL('../../target/arch/desktop.qcow2', import.meta.url).pathname;
const s = await openSession({ gpu: `virgl,vulkan${process.env.GPU_KNOBS ? `,${process.env.GPU_KNOBS}` : ''}`, image, out, ncpus: 4, ramMiB: 4096, disk2: '/target/video/media.ext4' });
const results: Record<string, unknown> = { chromium: s.browser.version(), gl: s.gl };
// MPV_ARMS='tag=args|tag=args' replaces the arms (PAIRS='a~b c~d' the comparisons), e.g. one arm's mpv options varied.
const ARMS: Record<string, string> = process.env.MPV_ARMS
  ? Object.fromEntries(process.env.MPV_ARMS.split('|').map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]))
  : {
    vkva: '--hwdec=vaapi --vo=gpu-next --gpu-api=vulkan', vkno: '--hwdec=no --vo=gpu-next --gpu-api=vulkan',
    glva: '--hwdec=vaapi --vo=gpu --gpu-api=opengl', glno: '--hwdec=no --vo=gpu --gpu-api=opengl',
  };
const PAIRS = process.env.PAIRS ? process.env.PAIRS.split(' ').map((p) => p.split('~'))
  : [['vkva', 'vkno'], ['glva', 'glno'], ['vkno', 'glno'], ['vkva', 'glva']].filter(([x, y]) => ARMS[x] && ARMS[y]);
try {
  await s.rootShell();
  await s.run('mkdir -p /mnt/media && mount -o ro /dev/vdb /mnt/media');
  if (process.env.SHIM) await s.run('cp /mnt/media/webpc_drv_video.so /usr/lib/dri/');
  results.info = await s.run('pacman -Q mpv libplacebo mesa vulkan-virtio webpc-va | tr "\\n" " "');
  results.sway = await s.startSway('gles2');
  // The screenshot 10 s after the start (the seek done, the frame shown), then quit; mpv on Vulkan may not exit (its
  // swapchain's last image waits for the compositor): killed.
  await s.pasteSerial(`cat > /home/arch/shot.lua <<'EOF'
mp.add_timeout(10, function() mp.commandv("screenshot-to-file", os.getenv("SHOT"), "window"); if os.getenv("SHOT2") ~= "" then mp.add_timeout(0.5, function() mp.set_property("deband", "yes") end); mp.add_timeout(1.5, function() mp.commandv("screenshot-to-file", os.getenv("SHOT2"), "window") end) end; mp.add_timeout(3, function() mp.commandv("quit") end) end)
EOF
cat > /root/shot.sh <<'EOF'
#!/bin/sh
tag=$1; shift
rm -f /tmp/$tag.png
su arch -c "export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1 SHOT=/tmp/$tag.png SHOT2=${'$'}{SHOT2:+/tmp/$tag-b.png}; timeout -k 5 40 mpv --start=20 --pause --fs --osc=no --osd-level=0 --ao=null --script=/home/arch/shot.lua $* /mnt/media/sintel_trailer-480p.mp4 >/tmp/$tag.log 2>&1"
pkill -9 -x mpv; ffmpeg -loglevel error -y -i /tmp/$tag.png -f rawvideo -pix_fmt rgb24 /tmp/$tag.rgb
[ -f /tmp/$tag-b.png ] && ffmpeg -loglevel error -y -i /tmp/$tag-b.png -f rawvideo -pix_fmt rgb24 /tmp/$tag-b.rgb
echo "$(ffprobe -v error -show_entries stream=width,height -of csv=p=0 /tmp/$tag.png) $(grep -c 'Using hardware' /tmp/$tag.log)"
EOF
cat > /root/cmp.py <<'EOF'
import sys
a = open(sys.argv[1], 'rb').read(); b = open(sys.argv[2], 'rb').read()
n = min(len(a), len(b)); d = [abs(a[i] - b[i]) for i in range(n)]
print(len(a), len(b), sum(1 for x in d if x > 24), sum(1 for x in d if x), max(d), round(sum(d) / n, 3))
EOF
chmod 755 /root/shot.sh /home/arch/shot.lua`);
  for (const [tag, a] of Object.entries(ARMS)) {
    await s.display();
    const [size, hw] = (await s.run(`${process.env.SHOT2 ? 'SHOT2=1 ' : ''}/root/shot.sh ${tag} ${a}`, 120_000)).trim().split(' ');
    // libplacebo's own complaints (its advanced path: "Failed creating FBO texture", "Failed dispatching scaler").
    const placebo = (await s.run(`grep -iE 'disabling|failed|error' /tmp/${tag}.log | sort | uniq -c | head -20 | tr '\\n' ';'`)).trim();
    const venus = (await s.display()).renderer?.venus as { submits?: number; perSubmit?: Record<string, number> } | undefined;
    results[tag] = { args: a, size, hardwareDecoding: hw === '1', placebo, venus };
    if (venus) s.log(tag, 'venus', JSON.stringify({ submits: venus.submits, ...venus.perSubmit }).slice(0, 300));
    s.log(tag, size, hw === '1' ? 'VA-API' : 'software', placebo);
  }
  // SHOT2=1: a second screenshot of each arm after debanding is turned on (the frame rendered anew, not from
  // libplacebo's frame cache), compared with the first.
  if (process.env.SHOT2) for (const tag of Object.keys(ARMS)) PAIRS.push([`${tag}-b`, tag]);
  for (const [x, y] of PAIRS) {
    const [bytes, , off24, differ, max, mean] = (await s.run(`python3 /root/cmp.py /tmp/${x}.rgb /tmp/${y}.rgb`, 300_000)).trim().split(' ').map(Number);
    results[`${x} ~ ${y}`] = { bytes, off24, differ, max, mean };
    s.log(`${x} ~ ${y}`, `off by >24: ${off24}, differ: ${differ}, max ${max}, mean ${mean}`);
  }
} finally {
  writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings) }, null, 1));
  await s.close();
}
