// A disk's bytes in a worker (the export, the changes-in and the disk jobs: web/app/*-worker.ts), from where the
// page says they are (protocol.ts `DiskSource`): synchronous reads, as the device worker's (web/devices.ts).
import { blobSource, httpSource, zeroSource, type Source } from '../devices.ts';
import { openStored } from '../stored.ts';
import { chunkedSource, isManifestUrl } from '../chunked.ts';
import type { DiskSource } from './protocol.ts';

/** Opens `s` for reading; `close` lets go of a stored disk's files. A ramdisk has nothing to read outside its machine. */
export async function openSource(s: DiskSource): Promise<Source & { close?(): void }> {
  if ('url' in s) return isManifestUrl(s.url) ? chunkedSource(new URL(s.url, self.location.href).href) : httpSource(new URL(s.url, self.location.href).href);
  if ('file' in s) return blobSource(s.file);
  if ('blank' in s) return zeroSource(s.blank);
  if ('stored' in s) return openStored(s.stored, s.size);
  throw new Error("a ramdisk's bytes are its machine's only");
}
