// An interactive guest session for experiments (dev-only; VK2 L6): the desktop guest (or the image given) on the page with
// Vulkan, root on the serial terminal, the media disk mounted at /mnt/media, sway on GLES; then it waits for files in
// /tmp/guest-shell/: `cmd` (root shell lines, each through `runLines`: give each a trailing newline, no heredocs) writes their
// output to `out` and a DONE line; `raw` is typed on the serial terminal as it is (`\x03` for ^C, while a command hangs);
// `shot` saves the page's screenshot as shot.png; `quit` ends the session. Commands run one file at a time.
//   GPU=virgl,vulkan CMD_MS=100000 node bench/gpu/guest-shell.ts [image.qcow2]   (in the background, under `timeout`)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { openSession } from './guest-session.ts';
mkdirSync('/tmp/guest-shell', { recursive: true });
for (const f of ['cmd', 'out', 'quit']) rmSync(`/tmp/guest-shell/${f}`, { force: true });
const s = await openSession({ gpu: process.env.GPU ?? 'virgl,vulkan', image: process.argv[2] ?? 'target/arch/desktop.qcow2', out: '/tmp/guest-shell/session', ncpus: 4, ramMiB: 4096, disk2: '/target/video/media.ext4' });
await s.rootShell();
await s.run('mkdir -p /mnt/media && mount -o ro /dev/vdb /mnt/media; ls /mnt/media | tr "\\n" " "');
const sway = await s.startSway('gles2');
writeFileSync('/tmp/guest-shell/out', `READY ${sway}\n`);
let busy = false;
for (;;) {
  if (existsSync('/tmp/guest-shell/quit')) break;
  if (existsSync('/tmp/guest-shell/raw')) {
    const raw = readFileSync('/tmp/guest-shell/raw', 'utf8');
    rmSync('/tmp/guest-shell/raw');
    await s.onSerial(raw.replace(/\\x03/g, '\x03'));
  }
  if (existsSync('/tmp/guest-shell/shot')) {
    rmSync('/tmp/guest-shell/shot');
    await s.page.screenshot({ path: '/tmp/guest-shell/shot.png' });
  }
  if (existsSync('/tmp/guest-shell/cmd') && !busy) {
    busy = true;
    const cmds = readFileSync('/tmp/guest-shell/cmd', 'utf8').split('\n').filter(Boolean);
    rmSync('/tmp/guest-shell/cmd');
    writeFileSync('/tmp/guest-shell/out', '');
    void (async () => {
      for (const c of cmds) {
        try {
          const lines = await s.runLines(c, Number(process.env.CMD_MS ?? 120_000));
          appendFileSync('/tmp/guest-shell/out', lines.join('\n') + '\n');
        } catch (e) { appendFileSync('/tmp/guest-shell/out', `ERROR ${String(e).slice(0, 300)}\n`); }
      }
      appendFileSync('/tmp/guest-shell/out', 'DONE\n');
      busy = false;
    })();
  }
  await new Promise((r) => setTimeout(r, 300));
}
await s.close();
