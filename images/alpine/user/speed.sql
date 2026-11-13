-- waarm64's SQLite phase: inserts, an index, joins, aggregates, updates and
-- deletes on an in-memory database (in the spirit of speedtest1, our own).
CREATE TABLE t1(a INTEGER PRIMARY KEY, b INTEGER, c TEXT);
CREATE TABLE t2(a INTEGER PRIMARY KEY, b INTEGER, c TEXT);
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 100000)
INSERT INTO t1 SELECT i, (i * 2654435761) % 100003, printf('row %d of t1, %x', i, i * 40503) FROM s;
INSERT INTO t2 SELECT a, b % 1000, upper(c) FROM t1 WHERE a % 3 = 0;
CREATE INDEX t1b ON t1(b);
CREATE INDEX t2b ON t2(b);
SELECT 'sqlite: ' || count(*) || ' ' || sum(t1.b) FROM t1 JOIN t2 ON t1.b % 1000 = t2.b WHERE t2.a < 6000;
SELECT 'sqlite: ' || count(*) || ' ' || max(n) FROM (SELECT b % 997 AS k, count(*) AS n FROM t1 GROUP BY k);
UPDATE t1 SET c = c || ' updated' WHERE b < 50000;
DELETE FROM t1 WHERE a % 7 = 0;
SELECT 'sqlite: ' || count(*) || ' ' || sum(length(c)) FROM t1;
