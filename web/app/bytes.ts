// Sizes as the page writes them: binary units always (KiB, MiB, GiB), as the sizes users enter are (a disk in MiB, RAM).

const KiB = 1024, MiB = KiB * 1024, GiB = MiB * 1024;

/** `n` bytes in KiB, MiB or GiB: a decimal while the number is small, none past it. */
export const bytesText = (n: number) => (n < MiB ? `${Math.ceil(n / KiB)} KiB` : n < GiB ? `${(n / MiB).toFixed(n < 10 * MiB ? 1 : 0)} MiB` : `${(n / GiB).toFixed(n < 10 * GiB ? 2 : 1)} GiB`);
