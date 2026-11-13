-- N-body (floating point): waarm64's own, after the Benchmarks Game's description.
local pi = math.pi
local sm = 4 * pi * pi
local dp = 365.24
local b = {
  { 0, 0, 0, 0, 0, 0, sm },
  { 4.84143144246472090e+00, -1.16032004402742839e+00, -1.03622044471123109e-01, 1.66007664274403694e-03 * dp, 7.69901118419740425e-03 * dp, -6.90460016972063023e-05 * dp, 9.54791938424326609e-04 * sm },
  { 8.34336671824457987e+00, 4.12479856412430479e+00, -4.03523417114321381e-01, -2.76742510726862411e-03 * dp, 4.99852801234917238e-03 * dp, 2.30417297573763929e-05 * dp, 2.85885980666130812e-04 * sm },
  { 1.28943695621391310e+01, -1.51111514016986312e+01, -2.23307578892655734e-01, 2.96460137564761618e-03 * dp, 2.37847173959480950e-03 * dp, -2.96589568540237556e-05 * dp, 4.36624404335156298e-05 * sm },
  { 1.53796971148509165e+01, -2.59193146099879641e+01, 1.79258772950371181e-01, 2.68067772490389322e-03 * dp, 1.62824170038242295e-03 * dp, -9.51592254519715870e-05 * dp, 5.15138902046611451e-05 * sm },
}
local nb = #b
local px, py, pz = 0, 0, 0
for i = 1, nb do px = px + b[i][4] * b[i][7]; py = py + b[i][5] * b[i][7]; pz = pz + b[i][6] * b[i][7] end
b[1][4], b[1][5], b[1][6] = -px / sm, -py / sm, -pz / sm
local function energy()
  local e = 0
  for i = 1, nb do
    local bi = b[i]
    e = e + 0.5 * bi[7] * (bi[4] * bi[4] + bi[5] * bi[5] + bi[6] * bi[6])
    for j = i + 1, nb do
      local bj = b[j]
      local dx, dy, dz = bi[1] - bj[1], bi[2] - bj[2], bi[3] - bj[3]
      e = e - bi[7] * bj[7] / math.sqrt(dx * dx + dy * dy + dz * dz)
    end
  end
  return e
end
local function advance(dt)
  for i = 1, nb do
    local bi = b[i]
    for j = i + 1, nb do
      local bj = b[j]
      local dx, dy, dz = bi[1] - bj[1], bi[2] - bj[2], bi[3] - bj[3]
      local d2 = dx * dx + dy * dy + dz * dz
      local mag = dt / (d2 * math.sqrt(d2))
      bi[4] = bi[4] - dx * bj[7] * mag; bi[5] = bi[5] - dy * bj[7] * mag; bi[6] = bi[6] - dz * bj[7] * mag
      bj[4] = bj[4] + dx * bi[7] * mag; bj[5] = bj[5] + dy * bi[7] * mag; bj[6] = bj[6] + dz * bi[7] * mag
    end
  end
  for i = 1, nb do
    local bi = b[i]
    bi[1] = bi[1] + dt * bi[4]; bi[2] = bi[2] + dt * bi[5]; bi[3] = bi[3] + dt * bi[6]
  end
end
local e0 = energy()
for _ = 1, 50000 do advance(0.01) end
print(string.format("nbody: %.9f %.9f", e0, energy()))
