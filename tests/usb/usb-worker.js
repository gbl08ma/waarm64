// WebUSB in a dedicated worker for tests/usb-webusb.test.ts, against tests/usb/gadget.sh's gadgets.
// {type:'check'} -> {type:'result', usb, devices, zero: {...}, acm: {...}} or {type:'error', message}.

const hex = (dv) => Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength), (b) => b.toString(16).padStart(2, '0')).join('');

async function zero(dev) {
  await dev.open();
  try {
    if (dev.configuration?.configurationValue !== 1) await dev.selectConfiguration(1);
    await dev.claimInterface(0);
    const desc = await dev.controlTransferIn({ requestType: 'standard', recipient: 'device', request: 6, value: 0x0100, index: 0 }, 18);
    // source/sink: bulk IN sources (i % 63) (pattern 1), bulk OUT sinks.
    const inp = await dev.transferIn(1, 512);
    const out = await dev.transferOut(2, Uint8Array.from({ length: 512 }, (_, i) => i % 63)); // the sink checks pattern 1 too
    const vin = await dev.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0x5c, value: 0, index: 0 }, 8);
    await dev.releaseInterface(0);
    // loopback: what goes out comes back.
    await dev.selectConfiguration(2);
    await dev.claimInterface(0);
    const msg = Uint8Array.from({ length: 64 }, (_, i) => i ^ 0xa5);
    await dev.transferOut(2, msg);
    const back = await dev.transferIn(1, 512);
    await dev.releaseInterface(0);
    await dev.selectConfiguration(1); // as the next test expects to find it
    return {
      configurations: dev.configurations.map((c) => c.configurationValue),
      descriptor: { status: desc.status, hex: hex(desc.data) },
      bulkIn: { status: inp.status, length: inp.data.byteLength, pattern: new Uint8Array(inp.data.buffer).every((b, i) => b === i % 63) },
      bulkOut: { status: out.status, bytesWritten: out.bytesWritten },
      vendorIn: { status: vin.status, length: vin.data.byteLength },
      loopback: { status: back.status, same: hex(back.data) === hex(new DataView(msg.buffer)) },
    };
  } finally {
    await dev.close();
  }
}

async function acm(dev) {
  await dev.open();
  try {
    if (!dev.configuration) await dev.selectConfiguration(1);
    const ifaces = dev.configuration.interfaces.map((i) => ({ number: i.interfaceNumber, class: i.alternate.interfaceClass }));
    const claimed = [];
    for (const i of ifaces) {
      await dev.claimInterface(i.number);
      claimed.push(i.number);
    }
    return { ifaces, claimed };
  } finally {
    await dev.close();
  }
}

onmessage = async () => {
  try {
    const all = await navigator.usb.getDevices();
    const devices = all.map((d) => ({ id: `${d.vendorId.toString(16)}:${d.productId.toString(16)}`, serial: d.serialNumber ?? null }));
    const z = all.find((d) => d.serialNumber === 'waarm64-zero');
    const a = all.find((d) => d.serialNumber === 'waarm64-acm');
    postMessage({ type: 'result', usb: 'usb' in navigator, devices, zero: z && (await zero(z)), acm: a && (await acm(a)) });
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.stack ?? err) });
  }
};
