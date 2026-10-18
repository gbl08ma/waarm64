// WebHID in a dedicated worker, for tests/usb-hid.test.ts and tests/usb/hid-record.ts: lists the granted HID devices
// with their parsed collections, and moves reports for one device. Messages in: {type:'list'},
// {type:'io', productId, vendorId, send: [{kind:'output'|'feature', id, data:number[]}], readFeature: [id...], wait}
// Out: {type:'result', ...} or {type:'error', message}.

/** A WebIDL object as plain JSON: its attributes (enumerable getters on the prototype), recursively. */
function plain(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(plain);
  if (ArrayBuffer.isView(v)) return Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  const o = {};
  for (const k in v) {
    const x = v[k];
    if (typeof x !== 'function') o[k] = plain(x);
  }
  return o;
}

async function list() {
  return (await navigator.hid.getDevices()).map((d) => ({
    vendorId: d.vendorId,
    productId: d.productId,
    productName: d.productName,
    collections: plain(d.collections),
  }));
}

async function io(m) {
  const all = await navigator.hid.getDevices();
  const d = all.find((x) => x.vendorId === m.vendorId && x.productId === m.productId);
  if (!d) throw new Error(`no HID device ${m.vendorId.toString(16)}:${m.productId.toString(16)} among ${all.length}`);
  await d.open();
  const inputs = [];
  d.oninputreport = (e) => inputs.push({ id: e.reportId, data: Array.from(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength)) });
  postMessage({ type: 'opened' });
  const features = [];
  try {
    for (const s of m.send ?? []) {
      if (s.kind === 'output') await d.sendReport(s.id, new Uint8Array(s.data));
      else await d.sendFeatureReport(s.id, new Uint8Array(s.data));
    }
    for (const id of m.readFeature ?? []) {
      const v = await d.receiveFeatureReport(id);
      features.push({ id, data: Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) });
    }
    const until = performance.now() + (m.wait ?? 1000);
    while (inputs.length < (m.inputs ?? 0) && performance.now() < until) await new Promise((r) => setTimeout(r, 10));
  } finally {
    await d.close();
  }
  return { inputs, features };
}

onmessage = async (e) => {
  try {
    if (e.data.type === 'list') postMessage({ type: 'result', hid: 'hid' in navigator, devices: await list() });
    else if (e.data.type === 'io') postMessage({ type: 'result', ...(await io(e.data)) });
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.stack ?? err) });
  }
};
