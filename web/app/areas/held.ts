// A resource another tab's machine holds (a connection: web/app/net-claims.ts `HeldError`; a USB device:
// web/app/usb-live.ts `UsbHeldError`): what was asked fails with the holder's error, the user is asked, and it is taken
// from that tab (docs/frontend-code.md §5.5). A shared folder held elsewhere is a folder's state, not an error
// (web/app/folders-live.ts `FolderProblem` `held`): its Use it here asks first (web/app/areas/folder-actions.ts).

/**
 * Runs `f`; when it fails with a `Held` error, asks (`confirm`) and, on a yes, runs `take` (which takes the resource
 * from the other tab and does `f` again). Other errors go on.
 */
export async function takeHeld<E extends Error>(
  f: () => Promise<unknown>,
  Held: abstract new (...args: never[]) => E,
  confirm: (e: E) => Promise<boolean>,
  take: (e: E) => Promise<unknown>,
) {
  try {
    await f();
  } catch (e) {
    if (!(e instanceof Held)) throw e;
    if (await confirm(e)) await take(e);
  }
}
