# The comparison's workload (bench/compare/run.ts; bench/compare/REPORT.md): six small kernels in plain Perl, no
# module, the same file on every guest. Each prints the CPU seconds the guest charged it (`times`); the harness times
# the whole from outside, between the lines B0 and B9. A checksum per kernel shows every guest computed the same.
#   perl work.pl <size> <run's id>
$| = 1; $n = shift || 1; $id = shift || 0; sub t { (times)[0] } print "B0:$id;\n"; $t = t;
sub k { my $u = t; printf "K%s.%s %.2f %s;\n", $id, $_[0], $u - $t, $_[1]; $t = $u }
# Numbers drawn by x = 16807 x mod 2^31 - 1: products under 2^46, exact where Perl's integers are 32 bits too.
sub r { $x = ($x * 16807) % 2147483647 }
# 1: integers and arrays (a sieve)
$c = 0; for (1 .. 12 * $n) { @s = (1) x 30000; for $i (2 .. 173) { next unless $s[$i]; for ($j = $i * $i; $j < 30000; $j += $i) { $s[$j] = 0 } } $c += grep { $_ } @s } k(1, $c);
# 2: strings and hashes (counting words)
%h = (); $x = 1; for (1 .. 200000 * $n) { r; $h{"w" . ($x % 5000)}++ } k(2, scalar(keys %h) . "/" . $h{w42});
# 3: sorting numbers and strings
$x = 7; @a = map { r } 1 .. 60000 * $n; @b = sort { $a <=> $b } @a; @d = sort map { "k$_" } @a; k(3, "$b[100]/$d[100]");
# 4: regular expressions
$s = join " ", map { "item$_=" . ($_ * 37 % 1000) } 1 .. 4000; $c = 0; for (1 .. 12 * $n) { $c++ while $s =~ /item(\d+)=(\d*7)\b/g; ($r = $s) =~ s/(\d+)=/$1:/g; $c += length $r } k(4, $c);
# 5: function calls (recursion)
sub f { $_[0] < 2 ? $_[0] : f($_[0] - 1) + f($_[0] - 2) } $c = 0; $c += f(23) for 1 .. 2 * $n; k(5, $c);
# 6: floating point (an escape-time picture)
$c = 0; for $y (0 .. 59) { for $x (0 .. 119) { ($a, $b, $i) = (0, 0, 0); $u = $x / 40 - 2; $v = $y / 30 - 1; while ($i < 60 * $n && $a * $a + $b * $b < 4) { ($a, $b) = ($a * $a - $b * $b + $u, 2 * $a * $b + $v); $i++ } $c += $i } } k(6, $c);
print "B9:$id;\n";
