// The installed app's launches (docs/frontend.md "Installing the page"): a file the OS opens with waarm64 (the
// manifest's `file_handlers`: a disk image, a snapshot) comes in through the File Handling API's `launchQueue`, and is
// taken as a file dropped on the page is, with its handle. The manifest's `launch_handler` (`focus-existing`) brings
// it to the window already open, where the drop's questions ask before a running machine stops.

/** Hands each launch's first file, and its handle, to `open`; nothing where the browser has no `launchQueue`. */
export function takeLaunches(
  open: (file: File, handle: FileSystemFileHandle) => Promise<void>,
  failed: (e: unknown) => void,
) {
  window.launchQueue?.setConsumer((params) => {
    // One machine per page: the first file, as a drop of several takes (web/app/areas/page-window.ts `drop`).
    const handle = params.files.find((h): h is FileSystemFileHandle => h.kind === 'file');
    if (handle)
      void handle
        .getFile()
        .then((file) => open(file, handle))
        .catch(failed);
  });
}
