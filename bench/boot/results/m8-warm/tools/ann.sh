#!/bin/bash
# ann.sh <hot file> <n-th function (1-based)>: annotated disassembly
awk -v n=$2 '/^##/{k++; if(k==n) print; next} k==n' $1 > /tmp/claude-501/ann.in
tail -n +2 /tmp/claude-501/ann.in | awk '{w=$3; printf "0x%s 0x%s 0x%s 0x%s\n", substr(w,7,2), substr(w,5,2), substr(w,3,2), substr(w,1,2)}' | llvm-mc --disassemble -triple=aarch64 -mattr=+all 2>/dev/null | grep -v "^\s*\.text" > /tmp/claude-501/ann.dis
head -1 /tmp/claude-501/ann.in
paste <(tail -n +2 /tmp/claude-501/ann.in | awk '{printf "%5d %5s", $1, ($2>0?$2:"")}') /tmp/claude-501/ann.dis
