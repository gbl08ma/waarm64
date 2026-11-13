//! Runs the LTP subset and the arm64 kernel selftests in the guest
//! (target/images/ltp, images/build.sh ltp: its /ltp.sh on the arm64 defconfig
//! kernel, linux/Image-defconfig) and checks every result against `EXPECTED`:
//! what passes, what's skipped and why. Ignored by default (it needs the
//! images and a release build); scripts/ci.sh runs it when the image is current.

mod common;

/// (suite: test, result). A skip or failure says why.
/// LTP: 93 syscall tests, all passing (images/ltp/tests; two that need a
/// loop device with every filesystem were left out). kselftests: arm64 abi,
/// signal and tags (the SVE, SME and GCS ones skip), and breakpoints' arm64
/// test; waarm64: images/ltp/debug.c (self-hosted debug).
const EXPECTED: &[(&str, &str)] = &[
    ("ltp: abort01", "pass"),
    ("ltp: access01", "pass"),
    ("ltp: alarm02", "pass"),
    ("ltp: alarm03", "pass"),
    ("ltp: brk01", "pass"),
    ("ltp: brk02", "pass"),
    ("ltp: chdir04", "pass"),
    ("ltp: chmod01", "pass"),
    ("ltp: clock_getres01", "pass"),
    ("ltp: clock_gettime01", "pass"),
    ("ltp: clock_nanosleep01", "pass"),
    ("ltp: clone01", "pass"),
    ("ltp: clone02", "pass"),
    ("ltp: close01", "pass"),
    ("ltp: close02", "pass"),
    ("ltp: creat01", "pass"),
    ("ltp: dup01", "pass"),
    ("ltp: dup02", "pass"),
    ("ltp: dup201", "pass"),
    ("ltp: dup202", "pass"),
    ("ltp: dup3_01", "pass"),
    ("ltp: epoll_create01", "pass"),
    ("ltp: epoll_ctl01", "pass"),
    ("ltp: epoll_wait01", "pass"),
    ("ltp: execve01", "pass"),
    ("ltp: exit01", "pass"),
    ("ltp: exit02", "pass"),
    ("ltp: fchdir01", "pass"),
    ("ltp: fchmod01", "pass"),
    ("ltp: fcntl02", "pass"),
    ("ltp: fork01", "pass"),
    ("ltp: fork03", "pass"),
    ("ltp: fstat02", "pass"),
    ("ltp: ftruncate01", "pass"),
    ("ltp: futex_wait01", "pass"),
    ("ltp: futex_wake01", "pass"),
    ("ltp: getcwd01", "pass"),
    ("ltp: getpgid01", "pass"),
    ("ltp: getpid01", "pass"),
    ("ltp: getppid01", "pass"),
    ("ltp: getrandom01", "pass"),
    ("ltp: getrusage01", "pass"),
    ("ltp: gettid01", "pass"),
    ("ltp: gettimeofday01", "pass"),
    ("ltp: kill03", "pass"),
    ("ltp: link02", "pass"),
    ("ltp: lseek01", "pass"),
    ("ltp: madvise01", "pass"),
    ("ltp: mkdir02", "pass"),
    ("ltp: mmap01", "pass"),
    ("ltp: mmap02", "pass"),
    ("ltp: mprotect01", "pass"),
    ("ltp: mremap01", "pass"),
    ("ltp: munmap01", "pass"),
    ("ltp: nanosleep01", "pass"),
    ("ltp: open01", "pass"),
    ("ltp: open02", "pass"),
    ("ltp: pipe01", "pass"),
    ("ltp: pipe02", "pass"),
    ("ltp: pipe2_01", "pass"),
    ("ltp: poll01", "pass"),
    ("ltp: prctl01", "pass"),
    ("ltp: pread01", "pass"),
    ("ltp: pwrite01", "pass"),
    ("ltp: read01", "pass"),
    ("ltp: readlink01", "pass"),
    ("ltp: readv01", "pass"),
    ("ltp: rmdir01", "pass"),
    ("ltp: sbrk01", "pass"),
    ("ltp: sched_getparam01", "pass"),
    ("ltp: sched_yield01", "pass"),
    ("ltp: select01", "pass"),
    ("ltp: setitimer01", "pass"),
    ("ltp: setpgid01", "pass"),
    ("ltp: sigaction01", "pass"),
    ("ltp: sigaltstack01", "pass"),
    ("ltp: signal01", "pass"),
    ("ltp: socket01", "pass"),
    ("ltp: socketpair01", "pass"),
    ("ltp: stat01", "pass"),
    ("ltp: statx01", "pass"),
    ("ltp: symlink02", "pass"),
    ("ltp: sysinfo01", "pass"),
    ("ltp: time01", "pass"),
    ("ltp: times01", "pass"),
    ("ltp: truncate02", "pass"),
    ("ltp: umask01", "pass"),
    ("ltp: uname01", "pass"),
    ("ltp: unlink05", "pass"),
    ("ltp: wait401", "pass"),
    ("ltp: waitpid01", "pass"),
    ("ltp: write01", "pass"),
    ("ltp: writev01", "pass"),
    ("kselftest: fake_sigreturn_bad_magic", "pass"),
    ("kselftest: fake_sigreturn_bad_size", "pass"),
    ("kselftest: fake_sigreturn_bad_size_for_magic0", "pass"),
    ("kselftest: fake_sigreturn_duplicated_fpsimd", "pass"),
    ("kselftest: fake_sigreturn_misaligned_sp", "pass"),
    ("kselftest: fake_sigreturn_missing_fpsimd", "pass"),
    (
        "kselftest: fake_sigreturn_sme_change_vl",
        "skip: needs SME, which we leave out (docs/cpu.md)",
    ),
    (
        "kselftest: fake_sigreturn_sve_change_vl",
        "skip: needs SVE, which we leave out (docs/cpu.md)",
    ),
    ("kselftest: fpmr_siginfo", "pass"),
    (
        "kselftest: gcs_exception_fault",
        "skip: needs GCS, which we leave out (docs/cpu.md)",
    ),
    (
        "kselftest: gcs_frame",
        "skip: needs GCS, which we leave out (docs/cpu.md)",
    ),
    (
        "kselftest: gcs_write_fault",
        "skip: needs GCS, which we leave out (docs/cpu.md)",
    ),
    ("kselftest: hwcap", "pass"),
    ("kselftest: mangle_pstate_invalid_compat_toggle", "pass"),
    ("kselftest: mangle_pstate_invalid_daif_bits", "pass"),
    ("kselftest: mangle_pstate_invalid_mode_el1h", "pass"),
    ("kselftest: mangle_pstate_invalid_mode_el1t", "pass"),
    ("kselftest: mangle_pstate_invalid_mode_el2h", "pass"),
    ("kselftest: mangle_pstate_invalid_mode_el2t", "pass"),
    ("kselftest: mangle_pstate_invalid_mode_el3h", "pass"),
    ("kselftest: mangle_pstate_invalid_mode_el3t", "pass"),
    ("kselftest: poe_siginfo", "pass"),
    ("kselftest: ptrace", "pass"),
    (
        "kselftest: sme_trap_no_sm",
        "skip: needs SME, which we leave out (docs/cpu.md)",
    ),
    (
        "kselftest: sme_trap_non_streaming",
        "skip: needs SME, which we leave out (docs/cpu.md)",
    ),
    ("kselftest: sme_trap_za", "pass"),
    (
        "kselftest: sme_vl",
        "skip: needs SME, which we leave out (docs/cpu.md)",
    ),
    (
        "kselftest: ssve_regs",
        "skip: needs SME, which we leave out (docs/cpu.md)",
    ),
    (
        "kselftest: ssve_za_regs",
        "skip: needs SME, which we leave out (docs/cpu.md)",
    ),
    (
        "kselftest: sve_regs",
        "skip: needs SVE, which we leave out (docs/cpu.md)",
    ),
    (
        "kselftest: sve_vl",
        "skip: needs SVE, which we leave out (docs/cpu.md)",
    ),
    ("kselftest: syscall-abi", "pass"),
    ("kselftest: tags_test", "pass"),
    ("kselftest: tpidr2", "pass"),
    (
        "kselftest: tpidr2_restore",
        "skip: needs SME, which we leave out (docs/cpu.md)",
    ),
    ("kselftest: tpidr2_siginfo", "pass"),
    (
        "kselftest: za_no_regs",
        "skip: needs SME, which we leave out (docs/cpu.md)",
    ),
    (
        "kselftest: za_regs",
        "skip: needs SME, which we leave out (docs/cpu.md)",
    ),
    (
        "kselftest: zt_no_regs",
        "skip: needs SME, which we leave out (docs/cpu.md)",
    ),
    (
        "kselftest: zt_regs",
        "skip: needs SME, which we leave out (docs/cpu.md)",
    ),
    ("kselftest: breakpoint_test_arm64", "pass"),
    ("waarm64: debug", "pass"),
];

#[test]
#[ignore = "needs target/images/ltp and linux (images/build.sh ltp linux) and --release"]
fn ltp_and_kselftests() {
    let kernel = common::image("linux/Image-defconfig");
    let devices = common::guest_devices("ltp/rootfs.ext4", None);
    let cmdline = format!("{} -- /ltp.sh", common::GUEST_CMDLINE);
    let r = common::boot(&common::Boot {
        devices: &devices,
        ram_size: 512 << 20,
        max_steps: 200_000_000_000,
        echo: true,
        ..common::Boot::new(&kernel, &cmdline)
    });
    eprintln!("\n[{}]", r.summary);
    assert!(
        r.powered_off() && r.console.contains("waarm64: test ok\n"),
        "the run didn't finish"
    );
    assert_eq!(r.steps, common::steps("ltp"));
    let got: Vec<(String, String)> = r
        .console
        .lines()
        .filter_map(|l| {
            let (suite, rest) = l.split_once(": ")?;
            let (test, code) = rest.split_once(' ')?;
            if suite == "waarm64" && test != "debug" {
                return None; // the harness's own "waarm64: test ok"
            }
            let result = match (suite, code) {
                ("ltp" | "kselftest" | "waarm64", "0") => "pass",
                ("ltp", "32") | ("kselftest", "4") => "skip",
                ("ltp" | "kselftest" | "waarm64", _) => "fail",
                _ => return None,
            };
            Some((format!("{suite}: {test}"), result.to_owned()))
        })
        .collect();
    let summary: Vec<String> = got
        .iter()
        .map(|(t, r)| format!("(\"{t}\", \"{r}\"),"))
        .collect();
    eprintln!("{}", summary.join("\n"));
    let want: Vec<(String, String)> = EXPECTED
        .iter()
        .map(|(t, r)| ((*t).to_owned(), r.split(':').next().unwrap().to_owned()))
        .collect();
    assert_eq!(got, want);
}
