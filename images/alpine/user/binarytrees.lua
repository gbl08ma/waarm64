-- Binary trees (allocation and GC): waarm64's own, after the Benchmarks Game's
-- description. Prints the check sums; depth fixed for the benchmark's budget.
local function make(d)
  if d == 0 then return {} end
  d = d - 1
  return { make(d), make(d) }
end
local function check(t)
  if t[1] then return 1 + check(t[1]) + check(t[2]) end
  return 1
end
local max = 12
print("binarytrees: stretch " .. check(make(max + 1)))
local long = make(max)
local total = 0
for d = 4, max, 2 do
  local iters = 1 << (max - d + 4)
  local c = 0
  for _ = 1, iters do c = c + check(make(d)) end
  total = total + c
end
print("binarytrees: " .. total .. " " .. check(long))
