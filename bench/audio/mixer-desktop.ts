// The sound device's controls on the desktop guest (docs/audio.md "Decisions", the page's volume is the guest's
// Master; dev-only, not in tests): images/arch/desktop.sh's image on the page, the card's mixer before PipeWire runs
// (`amixer`: the page's level), sway started (so PipeWire and WirePlumber run in arch's session), then: the level
// WirePlumber gives the new output and the page's slider that follows it, the guest's volume and mute
// (`wpctl set-volume`, `set-mute`) moving the slider and Sound on, and the menu's changes reaching PipeWire
// (`wpctl get-volume`) and ALSA.
//   node bench/audio/mixer-desktop.ts <image.qcow2> [outdir]       (default bench/results/local/mixer-desktop/)
// Results: <outdir>/results.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { openSession } from '../gpu/guest-session.ts';

const image = process.argv[2];
if (!image) throw new Error('usage: node bench/audio/mixer-desktop.ts <image.qcow2> [outdir]');
const out = process.argv[3] ?? new URL('../results/local/mixer-desktop/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const s = await openSession({ gpu: '2d', image, out, screen: process.env.SCREEN, query: 'snd=' });
const { page, log, rootShell, run, asUser } = s;
const results: Record<string, unknown> = { chromium: s.browser.version() };
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));
const menu = () => page.evaluate(() => ({ volume: (document.getElementById('sound-volume') as HTMLInputElement).value, on: (document.getElementById('sound-on') as HTMLInputElement).checked }));
/** The menu's state once it shows `want` (or what it shows after 10 s). */
const menuAt = async (want: { volume: string; on: boolean }) => {
  await page.waitForFunction((w) => {
    const [v, on] = [document.getElementById('sound-volume') as HTMLInputElement, document.getElementById('sound-on') as HTMLInputElement];
    return v.value === w.volume && on.checked === w.on;
  }, want, { timeout: 10_000, polling: 200 }).catch(() => {});
  return menu();
};
const amixer = () => run("amixer -c0 get 'Master' | tail -n +2 | tr -s ' ' | tr '\\n' ' '");
// (root's session bus in the environment: wpctl's RTKit complaints go to /dev/null.)
const wpctl = () => run(asUser('wpctl get-volume @DEFAULT_AUDIO_SINK@ 2>/dev/null'));
const step = async (name: string, r: Record<string, unknown>) => { results[name] = r; log(name, JSON.stringify(r)); save(); };
try {
  await rootShell();
  results.info = await run('uname -r; pacman -Q linux pipewire wireplumber | tr "\\n" " "; echo; head -2 /proc/asound/cards | tr -s " "');
  log('info', results.info);
  await step('before', { menu: await menu(), amixer: await amixer(), controls: await run("amixer -c0 controls | tr '\\n' ' '"),
    // What set the level at boot: alsa-utils' alsa-restore (`alsactl restore`, `init` without a saved state).
    restore: await run("systemctl is-active alsa-restore; ls /var/lib/alsa/ 2>&1; journalctl -b -u alsa-restore -o cat | tail -3 | tr '\\n' ' '") });
  results.sway = await s.startSway('pixman');
  // WirePlumber's default for a new output (0.4 on its cubic scale): the menu follows.
  for (let i = 0; i < 15 && !/Volume/.test(await wpctl()); i++) await page.waitForTimeout(2000);
  await step('wireplumber', { wpctl: await wpctl(), amixer: await amixer(), menu: await menuAt({ volume: '40', on: true }), sinks: await run(`${asUser('wpctl status 2>/dev/null')} | grep -A2 Sinks: | tr -s ' ' | tr '\\n' ' '`) });
  // The guest's changes move the menu.
  await run(asUser('wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.7'));
  await step('guest-volume', { wpctl: await wpctl(), amixer: await amixer(), menu: await menuAt({ volume: '70', on: true }) });
  await run(asUser('wpctl set-mute @DEFAULT_AUDIO_SINK@ 1'));
  await step('guest-mute', { wpctl: await wpctl(), amixer: await amixer(), menu: await menuAt({ volume: '70', on: false }) });
  // The menu's changes reach the guest.
  await page.evaluate(() => {
    const [v, on] = [document.getElementById('sound-volume') as HTMLInputElement, document.getElementById('sound-on') as HTMLInputElement];
    v.value = '25';
    v.dispatchEvent(new Event('input', { bubbles: true }));
    on.checked = true;
    on.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(2000);
  await step('page-change', { menu: await menu(), wpctl: await wpctl(), amixer: await amixer() });
  // And the guest's mute again from the menu (Sound on unchecked).
  await page.evaluate(() => { const on = document.getElementById('sound-on') as HTMLInputElement; on.checked = false; on.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(2000);
  await step('page-mute', { menu: await menu(), wpctl: await wpctl(), amixer: await amixer() });
} finally {
  save();
  await s.close();
}
