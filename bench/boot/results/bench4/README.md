# BENCH loop 4's calibration (bench/boot/REPORT.md "BENCH loop 4")

`cal`: one run of `bench/ab-mac.sh` (with its A/A arm, 12 pairs a workload) of the base against `block::REGION` 32
(`r32`) and the compile threshold's floor and maximum at 500/1000 (`t500`) and 250/500 (`t250`), each the current
source with that constant changed, on `node`, `user` and `boot`. Regions of 16 are in `../bench2/r16` and
`../bench3/r16-3`.
