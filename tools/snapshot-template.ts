// Flags a snapshot file as a template (docs/devices.md "A template's identity"): a snapshot every visitor restores the
// same, as a demo image's is, whose restore has the guest's agent make the guest's identity its own (the kernel's
// entropy, /etc/machine-id, systemd's random seed, the SSH host keys). An internal tool for making demo images and
// their snapshots: the page never sets the flag (its own snapshots keep their identity), and doesn't show it.
//   node tools/snapshot-template.ts <snapshot> <out> [--off]    (--off: the flag dropped)
import { openAsBlob } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { asTemplate } from '../web/snapshot-file.ts';

const args = process.argv.slice(2);
const off = args.includes('--off');
const [input, out] = args.filter((a) => a !== '--off');
if (!input || !out || input === out) throw new Error('usage: node tools/snapshot-template.ts <snapshot> <out> [--off] (out is another file)');
const blob = await asTemplate(await openAsBlob(input), !off);
await writeFile(out, blob.stream());
console.log(`${out}: ${off ? 'not a template' : 'a template'} (${blob.size} bytes)`);
