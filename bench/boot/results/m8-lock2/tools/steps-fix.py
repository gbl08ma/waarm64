# Reads cargo test output on stdin; replaces each "right" (old count) with its "left" (new) in tests/steps.txt.
import re, sys
out = sys.stdin.read()
pairs = re.findall(r'left: (\d+)\n right: (\d+)', out)
p = 'tests/steps.txt'; s = open(p).read()
for new, old in pairs:
    n = len(re.findall(r'\b%s\b' % old, s))
    print(old, '->', new, 'occurrences', n)
    s = re.sub(r'\b%s\b' % old, new, s)
open(p, 'w').write(s)
print(re.findall(r'test result: .*', out))
