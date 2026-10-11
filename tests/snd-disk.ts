// A second disk for playing sound on a guest without alsa-utils (audio S3, docs/plans/audio.md §10.10): a tar
// archive, read straight off the block device (`tar -xf /dev/vdb`), with images/snd/play.c's static `snd-play`
// (images/build.sh linux-snd) and a WAV of a known tone. tests/page-debian.test.ts hands it to the page's Debian
// as `?disk2=`; the QEMU oracle takes the same file as a raw drive.
//   node tests/snd-disk.ts out.tar [seconds] [rate]   (the oracle's: a 440/660 Hz tone)
import { readFileSync, writeFileSync } from 'node:fs';

/** A WAV (PCM S16_LE, stereo) of a 440 Hz sine on the left and 660 Hz on the right. */
export function toneWav(seconds: number, rate: number, hz: [number, number] = [440, 660]) {
  const frames = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + frames * 4);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + frames * 4, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(frames * 4, 40);
  for (let f = 0; f < frames; f++) {
    b.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * hz[0] * f) / rate)), 44 + f * 4);
    b.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * hz[1] * f) / rate)), 46 + f * 4);
  }
  return b;
}

/** A ustar archive of regular files (name → contents, mode), padded to whole 10 KiB records. */
export function tar(files: { name: string; data: Buffer; mode?: number }[]) {
  const parts: Buffer[] = [];
  const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, '0') + '\0';
  for (const f of files) {
    const h = Buffer.alloc(512);
    h.write(f.name, 0, 100);
    h.write(octal(f.mode ?? 0o644, 8), 100);
    h.write(octal(0, 8), 108);
    h.write(octal(0, 8), 116);
    h.write(octal(f.data.length, 12), 124);
    h.write(octal(0, 12), 136);
    h.write('        ', 148); // the checksum's own field counts as spaces
    h.write('0', 156);
    h.write('ustar\0' + '00', 257);
    let sum = 0;
    for (const x of h) sum += x;
    h.write(octal(sum, 7) + ' ', 148);
    parts.push(h, f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.alloc((10240 - (body.length % 10240)) % 10240)]);
}

/** The disk: snd-play and tone.wav. */
export function sndDisk(seconds: number, rate: number) {
  const player = readFileSync(new URL('../target/images/linux-snd/snd-play', import.meta.url));
  return tar([{ name: 'snd-play', data: player, mode: 0o755 }, { name: 'tone.wav', data: toneWav(seconds, rate) }]);
}

if (import.meta.main) {
  const [out, seconds = '3', rate = '44100'] = process.argv.slice(2);
  writeFileSync(out, sndDisk(Number(seconds), Number(rate)));
}
