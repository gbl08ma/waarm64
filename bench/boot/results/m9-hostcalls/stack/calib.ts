function pad(d: number, f: () => unknown): unknown { if (d === 0) return f(); const r = pad(d - 1, f); return r; }
function headroom() { let lo = 0, hi = 1 << 20; while (hi - lo > 1) { const mid = (lo + hi) >> 1; let ok = true; try { pad(mid, () => 0); } catch { ok = false; } if (ok) lo = mid; else hi = mid; } return lo; }
for (let i = 0; i < 3; i++) headroom();
console.log(headroom());
