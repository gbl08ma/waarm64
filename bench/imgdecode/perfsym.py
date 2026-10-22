# The guest's `perf record -a -g` from desktop.ts PERF=1, read on the host: perf script with the guest's kallsyms, then
# libxul's frames named by Mozilla's symbols (desktop-disk.sh's libxul.funcs; its file offsets mapped to addresses
# through the ELF's LOAD segments), other libraries by their exported symbol (perf's) or 4 KiB granule.
#   python3 bench/imgdecode/perfsym.py <case>.perf.data <case>.kallsyms [top]
# Prints the non-idle samples by thread, by leaf function (with the threads it ran on), and inclusive (a function
# anywhere on the stack, once a sample). compare.py uses `profile()`.
import bisect, collections, os, re, subprocess, sys

ROOT = os.path.join(os.path.dirname(__file__), '../..')
FF = os.path.join(ROOT, 'target/imgpipe/dl/firefox')

def loads(path):
    out = subprocess.run(['readelf', '-lW', path], capture_output=True, text=True).stdout
    return [(int(m[1], 16), int(m[2], 16), int(m[3], 16)) for m in re.finditer(r'LOAD\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+0x[0-9a-f]+\s+(0x[0-9a-f]+)', out)]
XUL_LOADS = loads(os.path.join(FF, 'libxul.so'))
funcs = []
for l in open(os.path.join(ROOT, 'target/imgpipe/libxul.funcs')):
    a, sz, name = l.rstrip('\n').split(' ', 2)
    funcs.append((int(a, 16), name))
funcs.sort()
addrs = [a for a, _ in funcs]

def xul(off):
    for po, va, fs in XUL_LOADS:
        if po <= off < po + fs:
            v = off - po + va
            i = bisect.bisect_right(addrs, v) - 1
            return funcs[i][1] if i >= 0 else '?'
    return '?'

def short(name):
    # Drop C++ argument lists and templates' noise for reading.
    n = re.sub(r'\(.*$', '', name)
    return n[:110]

FRAME = re.compile(r'^\s+([0-9a-f]+) (.+?) \((.+?)\)$')

def name_of(sym, dso):
    if dso == '[kernel.kallsyms]': return 'k ' + sym
    m = re.match(r'(.+?)\+0x([0-9a-f]+)$', dso)
    base, off = (m[1], int(m[2], 16)) if m else (dso, 0)
    b = os.path.basename(base)
    if b == 'libxul.so': return 'xul ' + short(xul(off))
    if sym and sym != '[unknown]': return f'{b}:{re.sub(r"\+0x[0-9a-f]+$", "", sym)}'
    return f'{b}+0x{off & ~0xfff:x}'

def profile(data, kall):
    """Counters of the non-idle samples: by thread, by leaf DSO, by leaf function (and its threads), inclusive."""
    proc = subprocess.Popen(['perf', 'script', '-i', data, '--kallsyms', kall, '-F', 'comm,tid,ip,sym,dsoff'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    r = {'by_comm': collections.Counter(), 'leaf': collections.Counter(), 'leaf_comm': collections.defaultdict(collections.Counter),
         'incl': collections.Counter(), 'by_dso': collections.Counter(), 'total': 0, 'idle': 0}
    st = {'comm': None, 'frames': []}

    def flush():
        comm, frames = st['comm'], st['frames']
        if comm is None or not frames: return
        r['total'] += 1
        names = [name_of(s, d) for s, d in frames]
        if comm == 'swapper' or any(n in ('k default_idle_call', 'k cpu_do_idle') for n in names[:2]):
            r['idle'] += 1
            return
        c = re.sub(r'[ #]?\d+$', '', comm)
        r['by_comm'][c] += 1
        r['leaf'][names[0]] += 1
        r['leaf_comm'][names[0]][c] += 1
        r['by_dso'][os.path.basename(re.sub(r'\+0x[0-9a-f]+$', '', frames[0][1]))] += 1
        for n in set(names): r['incl'][n] += 1

    for line in proc.stdout:
        if not line.strip():
            flush(); st['comm'] = None; st['frames'] = []; continue
        m = FRAME.match(line)
        if m: st['frames'].append((m[2], m[3])); continue
        h = re.match(r'^(.*?)\s+(\d+)\s*$', line.rstrip().rstrip(':'))
        st['comm'] = h[1].strip() if h else line.split()[0]
    flush()
    return r

if __name__ == '__main__':
    data, kall = sys.argv[1], sys.argv[2]
    TOP = int(sys.argv[3]) if len(sys.argv) > 3 else 50
    r = profile(data, kall)
    total, idle = r['total'], r['idle']
    busy = total - idle
    print(f'samples {total}, idle {idle}, busy {busy} ({100 * busy / max(1, total):.1f}%)')
    pct = lambda n: f'{100 * n / max(1, busy):5.1f}%'
    print('\n== threads (busy samples)')
    for k, n in r['by_comm'].most_common(25): print(f'  {pct(n)} {n:6d}  {k}')
    print('\n== leaf DSO')
    for k, n in r['by_dso'].most_common(15): print(f'  {pct(n)} {n:6d}  {k}')
    print('\n== leaf functions')
    for k, n in r['leaf'].most_common(TOP):
        th = ', '.join(f'{c} {v}' for c, v in r['leaf_comm'][k].most_common(3))
        print(f'  {pct(n)} {n:6d}  {k}   [{th}]')
    print('\n== inclusive (libxul and libraries)')
    for k, n in r['incl'].most_common(TOP * 3):
        if k.startswith('k '): continue
        print(f'  {pct(n)} {n:6d}  {k}')
