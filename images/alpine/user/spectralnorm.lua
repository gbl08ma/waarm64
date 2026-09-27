-- Spectral norm (floating point, nested loops): webpc's own, after the
-- Benchmarks Game's description.
local n = 140
local function a(i, j)
  local ij = i + j - 1
  return 1.0 / (ij * (ij - 1) * 0.5 + i)
end
local function av(x, y)
  for i = 1, n do
    local s = 0
    for j = 1, n do s = s + a(i, j) * x[j] end
    y[i] = s
  end
end
local function atv(x, y)
  for i = 1, n do
    local s = 0
    for j = 1, n do s = s + a(j, i) * x[j] end
    y[i] = s
  end
end
local function atav(x, y, t) av(x, t); atv(t, y) end
local u, v, t = {}, {}, {}
for i = 1, n do u[i] = 1 end
for _ = 1, 10 do atav(u, v, t); atav(v, u, t) end
local vbv, vv = 0, 0
for i = 1, n do vbv = vbv + u[i] * v[i]; vv = vv + v[i] * v[i] end
print(string.format("spectralnorm: %.9f", math.sqrt(vbv / vv)))
