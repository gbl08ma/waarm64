// VK2 L6: mpv's frames on Vulkan right (bench/vulkan/REPORT.md "VK2 L6"; vk/README.md "Imports"). The desktop guest
// (images/arch/desktop.sh) on a machine with Vulkan, sway on GLES, the media disk (bench/video/media-disk.sh) as its
// second disk: mpv pauses Sintel's H.264 trailer at 20 s fullscreen and takes a screenshot of its window (`screenshot-to-
// file … window`: what its VO draws), once per arm: on Vulkan with VA-API's surfaces imported (vkva) and decoded in the
// guest's CPU and uploaded (vkno), and on virgl's GL the same two ways (glva, glno). H.264 decodes exactly, so the
// arms of one renderer should match: each pair's bytes compared in the guest (how many are off by more than 24, how
// many differ at all, the largest difference, the mean). Each arm also records libplacebo's complaints (VK3 L4: "Failed
// creating FBO texture" while its advanced path is off) and Venus's submits. Writes <out>/results.json.
//   node bench/vulkan/mpv-frames.ts [image] [outdir]   (default target/arch/desktop.qcow2; SHIM=1 installs the media
//   disk's VA driver; GPU_KNOBS adds to the page's `?gpu=` (e.g. `vkformats=held`: the advanced path off); MPV_ARMS and
//   PAIRS replace the arms and comparisons; SHOT2=1 takes a second screenshot after turning debanding on (the frame
//   rendered anew); GRAB=1 also reads the page's screen (`window.__waarm64Grab`) once mpv's screenshot exists, mpv still
//   showing the frame, and compares the arms' grabs as PAIRS says (VK3 L4b: bench/vulkan/green.sh; each kept as <tag>-page.ppm;
//   REGRAB=<s> grabs again that much later, <tag>-late; DIAG=1 keeps mpv's threads' kernel waits and its log's end then,
//   <tag>-diag.txt, with gdb's stacks if the guest has gdb; DIAG=<n> its last n lines, DIAG_GREP=<re> those matching, DIAG_FROM=<re>
//   the first n from the first line matching; MPV_ENV='VAR=x …' sets mpv's environment, GUEST_ENV='VAR=x …' adds lines to
//   the guest's /etc/environment (shot.sh reads it), PRE='cmd' runs as root first, DISK2 replaces the media disk's URL);
//   LOG_GREP=<re> keeps those lines of mpv's log with the 50 before each, in order (`placebo`, its complaints by default);
//   each arm records mpv's exit (`mpvExit`: 0 by itself, 124/137 ended by the limit), and CHECK=1 fails the run when an
//   arm's mpv didn't exit by itself (VK3 L4e: on SwiftShader the session's first mpv on Vulkan without the desktop
//   image's VN_PERF=no_async_present);
//   HOLD=<s> keeps mpv
//   that long after its screenshot (default 3, 6 with GRAB); bench/gpu/sway-mac.sh runs it with
//   SCRIPT=../vulkan/mpv-frames.ts, mode `-`)
import { mkdirSync, writeFileSync } from 'node:fs';
import { openSession } from '../gpu/guest-session.ts';

const args = process.argv.slice(2);
const out = args.at(-1) ?? new URL('../results/local/vk2/mpv-frames/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const image = (args.length > 1 ? args[0] : process.env.IMAGE) ?? new URL('../../target/arch/desktop.qcow2', import.meta.url).pathname;
const s = await openSession({ gpu: `virgl,vulkan${process.env.GPU_KNOBS ? `,${process.env.GPU_KNOBS}` : ''}`, image, out, ncpus: 4, ramMiB: 4096, disk2: process.env.DISK2 ?? '/target/video/media.ext4' });
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
type Grab = { width: number; height: number; pixels: Uint8Array };
type W = { __waarm64Grab: () => Promise<Grab>; __mpvGrabs?: Record<string, Uint8Array> };
/** GRAB=1: the page's screen now (read back in the GPU worker, after mpv's screenshot: the frame already drawn), kept in
 * the page for comparePages, and its greenness (mean G less the mean of R and B). */
const grabScreen = (tag: string) => s.page.evaluate(async (tag) => {
  const w = window as unknown as W;
  const g = await w.__waarm64Grab();
  if (!g.width) return { width: 0, height: 0 };
  (w.__mpvGrabs ??= {})[tag] = g.pixels;
  let r = 0, gg = 0, b = 0;
  for (let i = 0; i < g.pixels.length; i += 4) { r += g.pixels[i]; gg += g.pixels[i + 1]; b += g.pixels[i + 2]; }
  const n = g.pixels.length / 4;
  return { width: g.width, height: g.height, greenness: +((gg - (r + b) / 2) / n).toFixed(2) };
}, tag);
/** Two arms' page grabs, RGB only: the bytes off by more than 24, the mean difference. */
const comparePages = (x: string, y: string) => s.page.evaluate(([x, y]) => {
  const a = (window as unknown as W).__mpvGrabs?.[x], b = (window as unknown as W).__mpvGrabs?.[y];
  if (!a || !b || a.length !== b.length) return undefined;
  let off24 = 0, sum = 0;
  for (let i = 0; i < a.length; i++) {
    if ((i & 3) === 3) continue;
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > 24) off24++;
  }
  return { bytes: (a.length / 4) * 3, off24, mean: +(sum / ((a.length / 4) * 3)).toFixed(3) };
}, [x, y]);
try {
  await s.rootShell();
  await s.run('mkdir -p /mnt/media && mount -o ro /dev/vdb /mnt/media');
  if (process.env.SHIM) await s.run('cp /mnt/media/waarm64_drv_video.so /usr/lib/dri/');
  // GUEST_ENV='VAR=x …' (VK3 L4e): lines added to the guest's /etc/environment before the arms, as an image would have
  // them (e.g. desktop-setup.sh's VN_PERF=no_async_present on an image built before it, or `VN_PERF=` to clear it on one
  // built after); PRE='cmd' runs as root before the arms (e.g. `pacman -U --noconfirm /mnt/media/gdb/*.zst` with DISK2 a
  // media disk holding them: gdb for DIAG).
  if (process.env.GUEST_ENV) await s.run(`sed -i -e '$a\\' /etc/environment; printf '%s\\n' ${process.env.GUEST_ENV} >> /etc/environment`);
  if (process.env.PRE) s.log('pre', (await s.run(process.env.PRE, 300_000)).trim().slice(-300));
  // shot.sh reads /etc/environment itself: `su` from root runs no pam_env (a login's session does).
  results.environment = (await s.run(`su arch -c 'set -a; . /etc/environment; env' | grep -E '^(VN_|MESA_|VK_)' | tr '\\n' ' '`)).trim();
  results.info = await s.run('pacman -Q mpv libplacebo mesa vulkan-virtio waarm64-va | tr "\\n" " "');
  results.sway = await s.startSway('gles2');
  // The screenshot 10 s after the start (the seek done, the frame shown), then quit; mpv on Vulkan may not exit (its
  // swapchain's last image waits for the compositor): killed.
  await s.pasteSerial(`cat > /home/arch/shot.lua <<'EOF'
mp.add_timeout(10, function() mp.commandv("screenshot-to-file", os.getenv("SHOT"), "window"); if os.getenv("SHOT2") ~= "" then mp.add_timeout(0.5, function() mp.set_property("deband", "yes") end); mp.add_timeout(1.5, function() mp.commandv("screenshot-to-file", os.getenv("SHOT2"), "window") end) end; mp.add_timeout(tonumber(os.getenv("HOLD")) or 3, function() mp.commandv("quit") end) end)
EOF
cat > /root/shot.sh <<'EOF'
#!/bin/sh
tag=$1; shift
rm -f /tmp/$tag.png
su arch -c "set -a; . /etc/environment; set +a; export ${'$'}{MPV_ENV:-} XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1 SHOT=/tmp/$tag.png SHOT2=${'$'}{SHOT2:+/tmp/$tag-b.png} HOLD=${'$'}{HOLD:-3}; timeout -k 5 ${'$'}{MPV_S:-40} mpv --start=20 --pause --fs --osc=no --osd-level=0 --ao=null --script=/home/arch/shot.lua $* /mnt/media/sintel_trailer-480p.mp4 >/tmp/$tag.log 2>&1"
echo $? > /tmp/$tag.rc
pkill -9 -x mpv; ffmpeg -loglevel error -y -i /tmp/$tag.png -f rawvideo -pix_fmt rgb24 /tmp/$tag.rgb
[ -f /tmp/$tag-b.png ] && ffmpeg -loglevel error -y -i /tmp/$tag-b.png -f rawvideo -pix_fmt rgb24 /tmp/$tag-b.rgb
echo "$(ffprobe -v error -show_entries stream=width,height -of csv=p=0 /tmp/$tag.png) $(grep -c 'Using hardware' /tmp/$tag.log)"
EOF
cat > /root/cmp.py <<'EOF'
import sys
a = open(sys.argv[1], 'rb').read(); b = open(sys.argv[2], 'rb').read()
n = min(len(a), len(b)); d = [abs(a[i] - b[i]) for i in range(n)]
# and each picture's greenness: mean G less the mean of R and B (chroma = 0 makes it ~+150).
gr = lambda p: round((sum(p[1::3]) - (sum(p[0::3]) + sum(p[2::3])) / 2) / max(1, len(p) // 3), 2)
print(len(a), len(b), sum(1 for x in d if x > 24), sum(1 for x in d if x), max(d), round(sum(d) / n, 3), gr(a), gr(b))
EOF
chmod 755 /root/shot.sh /home/arch/shot.lua`);
  const GRAB = !!process.env.GRAB, HOLD = Number(process.env.HOLD || (GRAB ? 6 : 3)), REGRAB = Number(process.env.REGRAB || 0);
  /** A grab kept beside the results (<tag>-page.ppm), to look at when it differs. */
  const savePage = async (tag: string, g: unknown) => {
    const { width, height } = g as { width?: number; height?: number };
    const rgb = await s.page.evaluate((tag) => {
      const p = (window as unknown as W).__mpvGrabs?.[tag];
      if (!p) return '';
      const o = new Uint8Array((p.length / 4) * 3);
      for (let i = 0, j = 0; i < p.length; i += 4, j += 3) { o[j] = p[i]; o[j + 1] = p[i + 1]; o[j + 2] = p[i + 2]; }
      let bin = '';
      for (let i = 0; i < o.length; i += 0x8000) bin += String.fromCharCode(...o.subarray(i, i + 0x8000));
      return btoa(bin);
    }, tag);
    if (rgb && width) writeFileSync(`${out}/${tag}-page.ppm`, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), Buffer.from(rgb, 'base64')]));
  };
  /** The arms whose mpv didn't exit by itself (CHECK=1 makes the script fail on any). */
  const stuck: string[] = [];
  for (const [tag, a] of Object.entries(ARMS)) {
    await s.display();
    const t0 = performance.now();
    let shotS: number | undefined, page: unknown;
    let line: string;
    if (GRAB) {
      // mpv in the background, the shell waiting (a check a second, typed once before mpv starts) for its screenshot;
      // then the page's screen while mpv still shows the frame (HOLD), then shot.sh's own line once it's done.
      await s.run(`rm -f /tmp/${tag}.png /tmp/${tag}.out; (${process.env.SHOT2 ? 'SHOT2=1 ' : ''}${process.env.MPV_ENV ? `MPV_ENV='${process.env.MPV_ENV}' ` : ''}HOLD=${HOLD + REGRAB} MPV_S=${40 + REGRAB} /root/shot.sh ${tag} ${a} >/tmp/${tag}.out 2>&1 &); for i in $(seq 90); do [ -s /tmp/${tag}.png ] && break; sleep 1; done; sleep 1`, 150_000);
      shotS = (performance.now() - t0) / 1000;
      page = await grabScreen(tag);
      await savePage(tag, page);
      // DIAG=1 (VK3 L4e): where mpv's threads wait in the kernel now, and its log's end (put `-v` in MPV_ARMS for more).
      if (process.env.DIAG) {
        const diag = await s.runLines(`{ p=$(pgrep -x mpv | head -1); for t in /proc/$p/task/*; do echo "== $(cat $t/comm) $(cat $t/wchan) $(cut -d' ' -f1-3 $t/syscall)"; head -3 $t/stack; done; ls -l /proc/$p/fd | grep -E 'sync|anon|socket|dri' | sed 's/.* \\([0-9]* ->\\)/\\1/'; command -v gdb >/dev/null && gdb -p $p -batch -ex 'thread apply all bt 30' 2>/dev/null | grep -E '^Thread|^#'; echo "== log"; tr '\\r' '\\n' < /tmp/${tag}.log | grep -v statusline | awk '/${process.env.DIAG_FROM ?? '.'}/{f=1} f' | grep -E '${process.env.DIAG_GREP ?? '.'}' | ${process.env.DIAG_FROM ? 'head' : 'tail'} -n ${Number(process.env.DIAG) > 1 ? Number(process.env.DIAG) : 60}; }`, 300_000);
        writeFileSync(`${out}/${tag}-diag.txt`, diag.join('\n'));
      }
      // REGRAB=<s>: the page's screen again that long after the first grab (<tag>-late; VK3 L4d: whether a stale screen
      // ever catches up), mpv kept as long (HOLD and shot.sh's limit raised to match).
      if (REGRAB) {
        await new Promise((r) => setTimeout(r, REGRAB * 1000));
        const late = await grabScreen(`${tag}-late`);
        (page as Record<string, unknown>).late = { ...late, page: await comparePages(`${tag}-late`, tag) };
        await savePage(`${tag}-late`, late);
      }
      line = await s.run(`while pgrep -x shot.sh >/dev/null; do sleep 1; done; cat /tmp/${tag}.out`, 120_000);
    } else line = await s.run(`${process.env.SHOT2 ? 'SHOT2=1 ' : ''}HOLD=${HOLD} /root/shot.sh ${tag} ${a}`, 120_000);
    // shot.sh's own words are the last two: a killed mpv (VK3 L4d: one that doesn't exit) puts the shell's "Killed" before them.
    const [, size, hw] = /(\d{1,4},\d{1,4}) (\d+)\s*$/.exec(line) ?? [, line.trim(), '0'];
    // libplacebo's own complaints (its advanced path: "Failed creating FBO texture", "Failed dispatching scaler").
    const placebo = (await s.run(`grep ${process.env.LOG_GREP ? '-B50 ' : ''}-iE '${process.env.LOG_GREP ?? 'disabling|failed|error'}' /tmp/${tag}.log | ${process.env.LOG_GREP ? 'head -80' : 'sort | uniq -c | head -20'} | tr '\\n' ';'`)).trim();
    const venus = (await s.display()).renderer?.venus as { submits?: number; perSubmit?: Record<string, number> } | undefined;
    // An arm that asked for VA-API and didn't get it (VK3 L4d saw one): mpv's own log's end, to tell why.
    const mpvLog = hw !== '1' && a.includes('vaapi') ? (await s.run(`tail -n 40 /tmp/${tag}.log | cut -c1-200; cat /tmp/${tag}.out 2>/dev/null | head -5`)).trim() : undefined;
    // mpv's exit: 0 when it quit by itself, 124 when shot.sh's timeout ended it (VK3 L4e: a frozen window's mpv can't
    // exit, its swapchain's teardown waiting for a present fence that was never submitted).
    const mpvExit = Number((await s.run(`cat /tmp/${tag}.rc`)).trim().split(/\s+/).at(-1));
    if (mpvExit !== 0) stuck.push(tag);
    results[tag] = { args: a, size, mpvExit, hardwareDecoding: hw === '1', placebo, venus, seconds: +((performance.now() - t0) / 1000).toFixed(1), ...(GRAB ? { shotSeconds: shotS && +shotS.toFixed(1), page } : {}), ...(mpvLog ? { mpvLog } : {}) };
    if (venus) s.log(tag, 'venus', JSON.stringify({ submits: venus.submits, ...venus.perSubmit }).slice(0, 300));
    s.log(tag, size, hw === '1' ? 'VA-API' : 'software', `mpv exit ${mpvExit}`, placebo);
  }
  // SHOT2=1: a second screenshot of each arm after debanding is turned on (the frame rendered anew, not from
  // libplacebo's frame cache), compared with the first.
  if (process.env.SHOT2) for (const tag of Object.keys(ARMS)) PAIRS.push([`${tag}-b`, tag]);
  for (const [x, y] of PAIRS) {
    const [bytes, , off24, differ, max, mean, greenX, greenY] = (await s.run(`python3 /root/cmp.py /tmp/${x}.rgb /tmp/${y}.rgb`, 300_000)).trim().split(' ').map(Number);
    results[`${x} ~ ${y}`] = { bytes, off24, differ, max, mean, greenness: [greenX, greenY], ...(GRAB ? { page: await comparePages(x, y) } : {}) };
    s.log(`${x} ~ ${y}`, `off by >24: ${off24}, differ: ${differ}, max ${max}, mean ${mean}`);
  }
  if (process.env.CHECK && stuck.length) {
    s.log('CHECK', `mpv didn't exit by itself in ${stuck.join(', ')}`);
    process.exitCode = 1;
  }
} finally {
  writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings) }, null, 1));
  await s.close();
}
