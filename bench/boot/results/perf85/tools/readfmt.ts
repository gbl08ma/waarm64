import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
const p = await b.newPage();
console.log(JSON.stringify(await p.evaluate(() => {
  const gl = new OffscreenCanvas(4, 4).getContext('webgl2')!;
  const out: Record<string, unknown> = {};
  for (const [name, internal] of [['R8', gl.R8], ['RG8', gl.RG8], ['RGBA8', gl.RGBA8], ['RGB565', gl.RGB565], ['RGBA4', gl.RGBA4], ['RGB10_A2', gl.RGB10_A2]] as [string, number][]) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texStorage2D(gl.TEXTURE_2D, 1, internal, 4, 4);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const st = gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    out[name] = [st, '0x' + gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT).toString(16), '0x' + gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE).toString(16)];
  }
  return out;
})));
await b.close();
