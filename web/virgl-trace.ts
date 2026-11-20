// A virgl trace: what a guest's 3D session sent the device, replayable without the guest (the renderer's fixtures,
// tests/virgl/; docs/testing.md). The device writes it when asked (`Gpu.onCapture`): every 3D control command as the
// guest sent it, and before a command that reads guest memory (a SUBMIT_3D's uploads from staging buffers, a
// TRANSFER_TO_HOST_3D) the bytes it reads, as data records against the resource's backing. A replay keeps its own
// backing per resource (`ATTACH_BACKING`'s total length), writes the data records into it, and hands the commands
// to a renderer. Read-backs aren't in the trace: the guest's view of them is the renderer's to produce.
//
// Layout: "VGLT", u32 version, then records: u32 kind, u32 payload bytes, the payload padded to 4 bytes.
//   kind 1 (command): the control command's bytes (an ATTACH_BACKING's entries are kept, their addresses meaningless)
//   kind 2 (data): u32 resource, u32 offset in its backing, the bytes
//   kind 3 (note): UTF-8, for the reader (the guest's frame marks)
export const TRACE_VERSION = 1;
const MAGIC = 0x544c4756; // "VGLT"
export const REC_COMMAND = 1,
  REC_DATA = 2,
  REC_NOTE = 3;

export type TraceRecord =
  | { kind: 'command'; bytes: Uint8Array }
  | { kind: 'data'; res: number; offset: number; bytes: Uint8Array }
  | { kind: 'note'; text: string };

/** Encodes one record (the device posts them one at a time; a trace is the header and the records concatenated). */
export function encodeRecord(r: TraceRecord): Uint8Array {
  const body = r.kind === 'command' ? r.bytes : r.kind === 'note' ? new TextEncoder().encode(r.text) : r.bytes;
  const head = r.kind === 'data' ? 16 : 8;
  const out = new Uint8Array(head + ((body.length + 3) & ~3));
  const v = new DataView(out.buffer);
  v.setUint32(0, r.kind === 'command' ? REC_COMMAND : r.kind === 'data' ? REC_DATA : REC_NOTE, true);
  v.setUint32(4, body.length + head - 8, true);
  if (r.kind === 'data') {
    v.setUint32(8, r.res, true);
    v.setUint32(12, r.offset, true);
  }
  out.set(body, head);
  return out;
}

export function traceHeader() {
  const h = new Uint8Array(8);
  new DataView(h.buffer).setUint32(0, MAGIC, true);
  new DataView(h.buffer).setUint32(4, TRACE_VERSION, true);
  return h;
}

/** A whole trace from its records. */
export function encodeTrace(records: (TraceRecord | Uint8Array)[]) {
  const parts = [traceHeader(), ...records.map((r) => (r instanceof Uint8Array ? r : encodeRecord(r)))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function* readTrace(bytes: Uint8Array): Generator<TraceRecord> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (bytes.length < 8 || v.getUint32(0, true) !== MAGIC) throw new Error('not a virgl trace');
  if (v.getUint32(4, true) !== TRACE_VERSION)
    throw new Error(`virgl trace version ${v.getUint32(4, true)}, expected ${TRACE_VERSION}`);
  for (let at = 8; at + 8 <= bytes.length;) {
    const kind = v.getUint32(at, true),
      len = v.getUint32(at + 4, true);
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (body.length < len) throw new Error('virgl trace: a record runs past the end');
    if (kind === REC_COMMAND) yield { kind: 'command', bytes: body };
    else if (kind === REC_DATA)
      yield {
        kind: 'data',
        res: new DataView(body.buffer, body.byteOffset).getUint32(0, true),
        offset: new DataView(body.buffer, body.byteOffset).getUint32(4, true),
        bytes: body.subarray(8),
      };
    else if (kind === REC_NOTE) yield { kind: 'note', text: new TextDecoder().decode(body) };
    at += 8 + ((len + 3) & ~3);
  }
}
