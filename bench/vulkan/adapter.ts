// The WebGPU adapter a Chromium gets (bench/vulkan/nvidia.sh page: which browser to run the page in), as one line of
// JSON on stdout ({vendor, architecture, description}, or null without one), from an empty page on a local server (a
// secure context). CHROMIUM (default /usr/bin/chromium), CHROMIUM_ARGS, HEADED=1 as bench/gpu/guest-session.ts takes them.
//   node bench/vulkan/adapter.ts
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

const server = createServer((_, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>adapter</title>'));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: !process.env.HEADED, args: process.env.CHROMIUM_ARGS?.split(' ').filter(Boolean) ?? [] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  const adapter = await page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
    return a ? { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description } : null;
  });
  console.log(JSON.stringify(adapter));
} finally {
  await browser.close();
  server.close();
}
