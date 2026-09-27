-- Fannkuch-redux (permutations, array shuffling): webpc's own, after the
-- Benchmarks Game's description.
local n = 8
local perm, perm1, count = {}, {}, {}
for i = 0, n - 1 do perm1[i] = i end
local maxflips, checksum, r, sign = 0, 0, n, 1
while true do
  while r ~= 1 do count[r - 1] = r; r = r - 1 end
  for i = 0, n - 1 do perm[i] = perm1[i] end
  local flips = 0
  local k = perm[0]
  while k ~= 0 do
    local i, j = 0, k
    while i < j do perm[i], perm[j] = perm[j], perm[i]; i = i + 1; j = j - 1 end
    flips = flips + 1
    k = perm[0]
  end
  if flips > maxflips then maxflips = flips end
  checksum = checksum + sign * flips
  sign = -sign
  while true do
    if r == n then print("fannkuch: " .. checksum .. " " .. maxflips); return end
    local p0 = perm1[0]
    for i = 0, r - 1 do perm1[i] = perm1[i + 1] end
    perm1[r] = p0
    count[r] = count[r] - 1
    if count[r] > 0 then break end
    r = r + 1
  end
end
