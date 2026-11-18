// The harness pages' side of a booted-Debian fixture (tests/debian-fixture.ts, tests/browser/tailnet-worker.ts):
// `save()` has the worker snapshot its machine and the page download the file; `restored()` says whether the machine
// started from one (tests/serial-console.ts `loginRoot` then sets the guest's clock).
export function fixtureHooks(worker: Worker) {
  let restored = false;
  worker.addEventListener('message', (e: MessageEvent<{ restored?: true; snapshot?: Blob }>) => {
    if (e.data.restored) restored = true;
    if (!e.data.snapshot) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(e.data.snapshot);
    a.download = 'fixture.waarm64snap';
    document.body.append(a);
    a.click();
  });
  return { save: () => worker.postMessage({ save: true }), restored: () => restored };
}
