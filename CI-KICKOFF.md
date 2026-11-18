# CI: tiers and faster lanes — kickoff

The user's brief (2026-11-18), in their words:

> I'll need to have an agent seriously think about CI, to restructure it deeply or at least identify faster lanes that
> can run after every change. We can't be waiting so long every time, and saving CI to run in bulk at last has
> problems of its own (and doesn't speed up the application of small quick individual fixes anyway)

> after CI is restructured, we'll have to reconsider what needs running after each type of change. Making CI more
> agile is also a prerequisite for being able to set something up in GitHub Actions, from my point of view.

> I agree with the tiers and any CLAUDE.md proposals (that file has been maintained primarily by agents). [...] OK to
> depend on the snapshot path for more tests. The repo is presently private, but it will become public at some point.
> For now we can just leave the GHA ideas as a plan, so that runners don't consume from my free allowance for private
> repos while they don't become public [...]. Do not depend on static.gbl08ma.com; I think we may be able to use
> github artifacts to store images that can be pulled by other GHA jobs, at least the smaller images, no? OK to
> additional Rust dependencies are long as they're popular/"industry-standard".

> We could also explore depending on a guest that's faster to boot than Debian for more tests, like specialized
> buildroot images. The challenge then becomes the time it takes to build those images. Alpine could be a good option
> but we've been having trouble dealing with pinning Alpine stuff (it seems they delete packages over time?)

> I think for Alpine, one solution might be to not depend on it for fixed-step tests, and otherwise use it only "as
> its developers intend", i.e. by adopting newer packages as they come. This is worse for regression testing on our
> side, but it gives us the ability to detect when our emulator would become incompatible with newer versions of guest
> software, so there's tradeoffs there. I think that could leave us with buildroot as the only thing we use in
> fixed-step tests, and I fear that might diminish the value of such tests too much; ideally we'd find another type of
> guest to fill the role Alpine served, that boots similarly quickly but while still having some userspace (part of
> the problem with our buildroot tests is that they barely test any SMP/userspace workloads, most of the code in
> buildroot boots runs in kernel mode as the kernel boots).

The plan and the decisions taken: [docs/plans/ci-tiers.md](docs/plans/ci-tiers.md) (§11). The end: the tiers built
and in CLAUDE.md and docs/testing.md, each tier's time measured, the change table authoritative in docs/testing.md,
the plan's outcome moved into docs/testing.md and this file, the handover and the plan deleted.
