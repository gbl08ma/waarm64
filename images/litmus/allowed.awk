# herd7's output -> allowed.txt: "<test><TAB><state>" for every final state the
# model allows, and "<test><TAB>model <Never|Sometimes|Always>" for the test's
# condition (Never: the condition is forbidden).
/^Test / { t = $2 }
/^States / { s = 1; next }
/^(Ok|No)$/ { s = 0 }
s { print t "\t" $0 }
/^Observation / { print t "\tmodel " $3 }
