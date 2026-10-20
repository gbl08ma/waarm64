#!/usr/bin/env python3
# locsum.py <session dir>...: the locals counts of count-locals.patch's core (results.json's jit counters).
import json, sys
M = 10**6
for d in sys.argv[1:]:
    j = json.load(open(f'{d}/results.json'))['jit']
    f = j['flagsStored'] // M; z = j['flagsElided'] // M
    print(f"{d}: {f} functions, {z} zero-filled ({100*z/f:.1f}%), {j['condDirect']//M/f:.2f} locals each, "
          f"{100*(j['condComputed']//M)/f:.1f}% at 13-16, {j['condMemory']//M/f:.2f} fill turns a function, {j['bytes']/1e6:.0f} MB")
