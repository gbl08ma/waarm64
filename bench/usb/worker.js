// WebUSB in a dedicated worker against the Gadget Zero of tests/usb/gadget.sh (bench/usb/REPORT.md): one transfer's
// round trip (control, bulk IN, bulk OUT, loopback echo) and bulk throughput with several transfers in flight.
// Messages: {type:'run', opts} -> {type:'result', ...} or {type:'error', message}.

const now = () => performance.now();
let stage = '';

async function open(serial) {
  const devices = await navigator.usb.getDevices();
  const dev = devices.find((d) => d.vendorId === 0x0525 && d.productId === 0xa4a0 && d.serialNumber === serial);
  if (!dev) throw new Error(`no Gadget Zero with serial ${serial} among ${devices.length} granted devices`);
  await dev.open();
  return dev;
}

/** The bulk endpoints of interface 0's alternate 0 in the active configuration. */
function bulkEndpoints(dev) {
  const alt = dev.configuration.interfaces[0].alternates[0];
  const inEp = alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'in');
  const outEp = alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'out');
  return { inEp: inEp.endpointNumber, outEp: outEp.endpointNumber, packet: inEp.packetSize };
}

async function configure(dev, n) {
  if (dev.configuration?.configurationValue !== n) await dev.selectConfiguration(n);
  await dev.claimInterface(0);
  return bulkEndpoints(dev);
}

/** Per-call latencies (ms) of `n` sequential calls of `f`, after `warm` unmeasured ones. */
async function latencies(f, n, warm = 20) {
  stage = f.name;
  for (let i = 0; i < warm; i++) await f();
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = now();
    await f();
    out.push(now() - t);
  }
  return out;
}

function check(r, what) {
  if (r.status !== 'ok') throw new Error(`${what}: ${r.status}`);
  return r;
}

/** Bytes per second moved by `depth` loops of `f(size)` for `ms`. */
async function throughput(f, size, depth, ms) {
  stage = `throughput ${size}x${depth}`;
  let bytes = 0;
  let stop = false;
  const t0 = now();
  const loop = async () => {
    while (!stop) bytes += await f(size);
  };
  const loops = Array.from({ length: depth }, loop);
  await new Promise((r) => setTimeout(r, ms));
  stop = true;
  await Promise.all(loops);
  return (bytes / (now() - t0)) * 1000;
}

async function run(opts) {
  const dev = await open(opts.serial);
  const res = { lat: {}, tput: [] };
  const n = opts.n;
  try {
    // Configuration 1: source/sink. The gadget sources zeros on bulk IN and sinks bulk OUT.
    let ep = await configure(dev, 1);
    res.packet = ep.packet;
    res.lat.control_get_descriptor = await latencies(async () => {
      check(await dev.controlTransferIn({ requestType: 'standard', recipient: 'device', request: 6, value: 0x0100, index: 0 }, 18), 'GET_DESCRIPTOR');
    }, n);
    // f_sourcesink's vendor requests: 0x5c reads (IN), 0x5b writes (OUT), as usbtest's control tests use them.
    res.lat.control_vendor_in_8 = await latencies(async () => {
      check(await dev.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0x5c, value: 0, index: 0 }, 8), 'vendor IN');
    }, n);
    const ctl = new Uint8Array(8);
    res.lat.control_vendor_out_8 = await latencies(async () => {
      check(await dev.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x5b, value: 0, index: 0 }, ctl), 'vendor OUT');
    }, n);
    res.lat.bulk_in_512 = await latencies(async () => {
      check(await dev.transferIn(ep.inEp, 512), 'bulk IN');
    }, n);
    const out512 = new Uint8Array(512);
    res.lat.bulk_out_512 = await latencies(async () => {
      check(await dev.transferOut(ep.outEp, out512), 'bulk OUT');
    }, n);
    for (const size of opts.sizes) {
      for (const depth of opts.depths) {
        const buf = new Uint8Array(size);
        const inBps = await throughput(async (s) => check(await dev.transferIn(ep.inEp, s), 'bulk IN').data.byteLength, size, depth, opts.ms);
        const outBps = await throughput(async () => check(await dev.transferOut(ep.outEp, buf), 'bulk OUT').bytesWritten, size, depth, opts.ms);
        res.tput.push({ size, depth, in: inBps, out: outBps });
      }
    }
    await dev.releaseInterface(0);
    // Configuration 2: loopback. What goes OUT comes back IN: the round trip of an echo (a serial console's).
    ep = await configure(dev, 2);
    const msg = new Uint8Array(64).fill(0x5a);
    res.lat.loopback_echo_64 = await latencies(async () => {
      check(await dev.transferOut(ep.outEp, msg), 'loopback OUT');
      const r = check(await dev.transferIn(ep.inEp, 512), 'loopback IN');
      if (r.data.byteLength !== 64) throw new Error(`loopback returned ${r.data.byteLength} bytes`);
    }, n);
    await dev.releaseInterface(0);
  } finally {
    await dev.close();
  }
  return res;
}

/** What the worker sees: the granted devices in getDevices() order, with the fields that tell them apart. */
async function list() {
  return (await navigator.usb.getDevices()).map((d) => ({
    vendorId: d.vendorId,
    productId: d.productId,
    serialNumber: d.serialNumber ?? null,
    productName: d.productName ?? null,
    version: `${d.deviceVersionMajor}.${d.deviceVersionMinor}${d.deviceVersionSubminor}`,
  }));
}

onmessage = async (e) => {
  try {
    if (e.data.type === 'run') postMessage({ type: 'result', ...(await run(e.data.opts)) });
    else if (e.data.type === 'list') postMessage({ type: 'result', devices: await list(), hid: 'hid' in navigator, usb: 'usb' in navigator });
  } catch (err) {
    postMessage({ type: 'error', message: `${stage}: ${err?.stack ?? err}` });
  }
};
