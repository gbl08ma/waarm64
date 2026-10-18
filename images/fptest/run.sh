#!/bin/sh
# The FP suite on real hardware (the oracle VM, docs/testing.md "The FP suite"):
# tar xf fptest.tar && fptest/run.sh [fptest options]
cd "$(dirname "$0")" && exec ./fptest -gen ./testfloat_gen "$@"
