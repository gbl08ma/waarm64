// bench/shares/index.html: hands a directory (picked, dropped, or OPFS's) to worker.ts and shows the result.
// `window.__run` is run.ts's way in; `window.__dropped` the handle of the last drop.
const out = document.querySelector<HTMLElement>('#out')!;
const save = document.querySelector<HTMLButtonElement>('#save')!;
type Win = typeof window & { __run: (root: FileSystemDirectoryHandle | 'opfs', kind: string) => Promise<unknown>; __dropped?: FileSystemDirectoryHandle; showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> };
const win = window as Win;

function run(root: FileSystemDirectoryHandle | 'opfs', kind: string): Promise<unknown> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(e.message));
    worker.onmessage = (e) => {
      if (e.data.progress) { out.textContent += `${e.data.progress}\n`; return; }
      worker.terminate();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.result);
    };
    worker.postMessage({ root, kind });
  });
}
win.__run = run;

async function show(root: FileSystemDirectoryHandle | 'opfs', kind: string) {
  out.textContent = '';
  const result = await run(root, kind).catch((e: Error) => ({ error: String(e) }));
  const json = JSON.stringify({ userAgent: navigator.userAgent, platform: navigator.platform, ...(result as object) }, null, 1);
  out.textContent = json;
  save.hidden = false;
  save.onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'shares.json';
    a.click();
  };
}

document.querySelector('#pick')!.addEventListener('click', async () => {
  const dir = await win.showDirectoryPicker({ mode: 'readwrite' });
  await show(dir, 'host');
});
document.querySelector('#opfs')!.addEventListener('click', () => void show('opfs', 'opfs'));
const drop = document.querySelector('#drop')!;
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (ev) => {
  const e = ev as DragEvent;
  e.preventDefault();
  const item = [...(e.dataTransfer?.items ?? [])].find((i) => i.kind === 'file') as (DataTransferItem & { getAsFileSystemHandle(): Promise<FileSystemHandle | null> }) | undefined;
  const h = await item?.getAsFileSystemHandle();
  drop.textContent = `dropped: ${h?.kind} ${h?.name}`;
  if (h?.kind === 'directory') win.__dropped = h as FileSystemDirectoryHandle;
});
