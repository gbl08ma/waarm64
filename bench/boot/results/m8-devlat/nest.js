self.onmessage = (e) => { const w = new Worker('dev.js', { type: 'module' }); w.postMessage(e.data); };
