# One litmus7 run (the second file) against herd7's allowed final states for
# test t (the first file, allowed.txt: "<test><TAB><state>" and
# "<test><TAB>model <observation>" lines). Prints the test's summary line and
# every state herd7 forbids; exits 1 if there's one, or output without a
# histogram. No output at all is a skip (exit 2): litmus7's programs print
# nothing when the machine has fewer CPUs than the test has threads.
function norm(s) { gsub(/[ \t]+/, " ", s); sub(/^ /, "", s); sub(/ $/, "", s); return s }
FNR == NR {
  i = index($0, "\t")
  if (substr($0, 1, i - 1) != t) next
  s = substr($0, i + 1)
  if (s ~ /^model /) model = substr(s, 7); else ok[norm(s)] = 1
  next
}
{ lines++ }
/^[0-9]+ *[*:]>/ {
  n = $0; sub(/ *[*:]>.*/, "", n)
  s = $0; sub(/^[0-9]+ *[*:]>/, "", s); s = norm(s)
  states++
  if (!(s in ok)) { bad++; forbidden = forbidden "\n  forbidden: " n " " s }
}
/^Observation / { seen = $3 " " $4 " " $5 }
END {
  if (!lines) { print "litmus: " t " skipped (too few CPUs)"; exit 2 }
  if (!states) { print "litmus: " t " FAIL no histogram"; exit 1 }
  print "litmus: " t " " (bad ? "FAIL" : "ok") " model=" model " seen=" seen forbidden
  exit bad ? 1 : 0
}
