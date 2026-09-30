// gostress: a Go runtime stress for webpc's SMP work (docs/images.md): the character of a
// `go build` on 4 vCPUs without the compiler. Many Ms and Ps, spinning Ms (procyield/osyield),
// heavy mmap/munmap/mprotect (so many TLBI IS broadcasts), the GC and the scavenger returning
// memory (madvise), futexes (channels, mutexes, timers) and fork/exec of /bin/true.
//
// usage: gostress [seconds] [procs]   (defaults 60, 4). One heartbeat line per second with
// cumulative counts, "gostress: done" at the end, exit status 0.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

var (
	allocs, freeOS, maps, prots, execs, chans, locks, spins atomic.Uint64
	sink                                                    atomic.Pointer[[]byte]
)

func rnd(s *uint64) uint64 { // xorshift64*
	*s ^= *s >> 12
	*s ^= *s << 25
	*s ^= *s >> 27
	return *s * 2685821657736338717
}

// allocator: slices from 100 B to 2 MiB, touched and dropped; every so often a slice is
// published so the GC has live data to mark; debug.FreeOSMemory forces a GC and a scavenge.
func allocator(id int, stop *atomic.Bool) {
	s := uint64(id)*0x9e3779b97f4a7c15 + 1
	var keep [64][]byte
	for i := 0; !stop.Load(); i++ {
		n := 100 + int(rnd(&s)%(2<<20))
		if rnd(&s)%8 != 0 {
			n %= 64 << 10
		}
		b := make([]byte, n)
		for k := 0; k < n; k += 4096 {
			b[k] = byte(k)
		}
		keep[rnd(&s)%64] = b
		if i%16 == 0 {
			sink.Store(&b)
		}
		allocs.Add(1)
		if id == 0 && i%2000 == 1999 {
			debug.FreeOSMemory()
			freeOS.Add(1)
		}
	}
}

// mapper: mmap, touch, mprotect (RO, RW, NONE) and munmap: each is a TLB shootdown on the guest.
func mapper(id int, stop *atomic.Bool) {
	s := uint64(id)*0x2545f4914f6cdd1d + 7
	for !stop.Load() {
		n := (1 + int(rnd(&s)%32)) * 4096
		b, err := syscall.Mmap(-1, 0, n, syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_ANON|syscall.MAP_PRIVATE)
		if err != nil {
			fmt.Fprintln(os.Stderr, "mmap:", err)
			time.Sleep(10 * time.Millisecond)
			continue
		}
		for k := 0; k < n; k += 4096 {
			b[k] = 1
		}
		syscall.Mprotect(b, syscall.PROT_READ)
		_ = b[0]
		syscall.Mprotect(b, syscall.PROT_READ|syscall.PROT_WRITE)
		b[0] = 2
		syscall.Mprotect(b, syscall.PROT_NONE)
		prots.Add(3)
		syscall.Munmap(b)
		maps.Add(1)
	}
}

// spinner: the shape of an idle P looking for work: Gosched and a short arithmetic burst.
func spinner(stop *atomic.Bool) {
	x := uint64(1)
	for !stop.Load() {
		for i := 0; i < 200; i++ {
			x = x*6364136223846793005 + 1442695040888963407
		}
		runtime.Gosched()
		spins.Add(1)
	}
	if x == 42 {
		fmt.Println()
	}
}

// pingpong: unbuffered channel pairs (park, ready, futex wake) and a contended mutex.
func pingpong(stop *atomic.Bool, mu *sync.Mutex, shared *int) {
	a, b := make(chan int), make(chan int)
	done := make(chan struct{})
	go func() {
		for v := range a {
			b <- v + 1
		}
		close(done)
	}()
	for i := 0; !stop.Load(); i++ {
		a <- i
		<-b
		chans.Add(1)
		mu.Lock()
		*shared++
		if i%64 == 0 {
			time.Sleep(50 * time.Microsecond) // hold it across a park: waiters sleep on the futex
		}
		mu.Unlock()
		locks.Add(1)
	}
	close(a)
	<-done
}

// execer: fork/exec /bin/true and wait (clone, execve, wait4, and the TLB flushes of the new mm).
func execer(stop *atomic.Bool) {
	for !stop.Load() {
		if err := exec.Command("/bin/true").Run(); err != nil {
			fmt.Fprintln(os.Stderr, "exec:", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		execs.Add(1)
	}
}

func main() {
	secs, procs := 60, 4
	if len(os.Args) > 1 {
		if v, err := strconv.Atoi(os.Args[1]); err == nil {
			secs = v
		}
	}
	if len(os.Args) > 2 {
		if v, err := strconv.Atoi(os.Args[2]); err == nil {
			procs = v
		}
	}
	runtime.GOMAXPROCS(procs)
	debug.SetGCPercent(25)
	var stop atomic.Bool
	var wg sync.WaitGroup
	run := func(f func()) { wg.Add(1); go func() { defer wg.Done(); f() }() }
	for i := 0; i < procs; i++ {
		run(func() { allocator(i, &stop) })
	}
	for i := 0; i < 2; i++ {
		run(func() { mapper(i, &stop) })
	}
	for i := 0; i < 2; i++ {
		run(func() { spinner(&stop) })
	}
	var mu sync.Mutex
	shared := 0
	for i := 0; i < 4; i++ {
		run(func() { pingpong(&stop, &mu, &shared) })
	}
	run(func() { execer(&stop) })

	t0 := time.Now()
	var ms runtime.MemStats
	for t := 1; t <= secs; t++ {
		time.Sleep(time.Until(t0.Add(time.Duration(t) * time.Second)))
		runtime.ReadMemStats(&ms)
		fmt.Printf("gostress: t=%d allocs=%d freeos=%d mmaps=%d mprotects=%d execs=%d chan=%d mutex=%d spins=%d gc=%d heapMB=%d sysMB=%d threads=%d\n",
			t, allocs.Load(), freeOS.Load(), maps.Load(), prots.Load(), execs.Load(), chans.Load(), locks.Load(), spins.Load(),
			ms.NumGC, ms.HeapAlloc>>20, ms.Sys>>20, threadCount())
	}
	stop.Store(true)
	wg.Wait()
	fmt.Println("gostress: done")
}

// threadCount: the Ms the runtime has made (from /proc/self/status).
func threadCount() int {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return -1
	}
	for _, l := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(l, "Threads:"); ok {
			n, _ := strconv.Atoi(strings.TrimSpace(v))
			return n
		}
	}
	return -1
}
