// Does a nested worker's uncaught error reach the page's Worker.onerror when the parent worker doesn't cancel it?
import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/chromium' });
const p = await b.newPage();
await p.goto('about:blank');
for (const cancel of [false, true]) {
  const r = await p.evaluate(async (cancel) => {
    const inner = `onmessage = () => { throw new Error('inner boom'); };`;
    const outer = `const b = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(inner)}], {type:'text/javascript'})));
      b.onerror = (e) => { ${cancel ? 'e.preventDefault();' : ''} postMessage('outer heard: ' + e.message); };
      b.postMessage(1);`;
    const a = new Worker(URL.createObjectURL(new Blob([outer], { type: 'text/javascript' })));
    const seen: string[] = [];
    a.onmessage = (e) => seen.push(String(e.data));
    a.onerror = (e) => { seen.push('PAGE onerror: ' + e.message); e.preventDefault(); };
    await new Promise((r) => setTimeout(r, 1000));
    a.terminate();
    return seen;
  }, cancel);
  console.log(cancel ? 'cancelled:' : 'not cancelled:', JSON.stringify(r));
}
await b.close();
