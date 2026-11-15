import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

export const openReadStream = (path: string) =>
  Readable.toWeb(createReadStream(path, { highWaterMark: 4 << 20 })) as unknown as ReadableStream<Uint8Array>;
