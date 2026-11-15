import json, glob, statistics, sys, os
D = os.path.dirname(os.path.abspath(__file__))
rows = {}
for f in sorted(glob.glob(f'{D}/io-*-*.json')):
    arm, rnd = os.path.basename(f)[3:-5].split('-')
    for r in json.load(open(f))['results']:
        if not r['name'].endswith(('_bw', '_lat')) and 'dd' not in r['name']:
            continue
        rows.setdefault(r['name'], {}).setdefault(arm, []).append((int(rnd), r['median'], r['iqr']))
for name, arms in rows.items():
    a = sorted(arms.get('A', [])); b = sorted(arms.get('B', []))
    am = [m for _, m, _ in a]; bm = [m for _, m, _ in b]
    if not am or not bm: continue
    d = (statistics.median(bm) / statistics.median(am) - 1) * 100
    overlap = not (max(am) < min(bm) or max(bm) < min(am))
    print(f"{name:40s} A {am} B {bm}  {d:+.1f}% {'overlap' if overlap else 'apart'}")
print()
for line in open(f'{D}/page.jsonl'):
    o = json.loads(line)
    print(o['label'], o.get('boot_ms'), round(o.get('import_ms', 0)), round(o.get('export_ms', 0)), o.get('state'), {k: v for k, v in o.get('files', {}).items() if k.endswith('map')}, o.get('errors'))
