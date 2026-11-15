import sys,json
for l in sys.stdin:
  try: d=json.loads(l)
  except: print(l.strip()); continue
  if d.get("type") not in ("pool","restore"): print(l.strip()); continue
  print(d.get("round",""), d["type"], d["codec"], "n",d["n"], d.get("sink",""), d.get("crc",""), "wall",d["wallMs"],"ms", d["MBs"],"MB/s ratio", round(d["raw"]/d["stored"],2), flush=True)
