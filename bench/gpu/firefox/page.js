// Injected into the saved real pages (bench/gpu/firefox-pages.sh): the time to the load event, written to Firefox's
// stdout as `FFBENCH load <ms>`, then the animation frames a second as bench.js counts them.
addEventListener('load', () => {
  setTimeout(() => {
    dump(`FFBENCH load ${performance.now().toFixed(0)}\n`);
    ffbench('page', () => {});
  });
});
