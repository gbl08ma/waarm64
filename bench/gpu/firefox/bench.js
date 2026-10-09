// Firefox's frame rate on the page (bench/gpu/firefox-load.ts): each second, the animation frames Firefox ran and the
// longest gap between two, written to Firefox's stdout (`dump`, with browser.dom.window.dump.enabled) as
// `FFBENCH <name> t=<s> frames=<n> maxms=<ms>`; `tick` is called once a frame by the page's animation.
function ffbench(name, tick) {
  let frames = 0, last = 0, max = 0, second = 0;
  const t0 = performance.now();
  const frame = (t) => {
    if (last) max = Math.max(max, t - last);
    last = t;
    frames++;
    tick(t);
    const s = Math.floor((t - t0) / 1000);
    if (s > second) {
      dump(`FFBENCH ${name} t=${s} frames=${frames} maxms=${max.toFixed(1)}\n`);
      second = s; frames = 0; max = 0;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  dump(`FFBENCH ${name} ready\n`);
}
