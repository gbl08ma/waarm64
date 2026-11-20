# HOST: the host code outside the page (web/*.ts): review, performance, linters — kickoff

The user's brief (2026-11-20), in their words:

> We've recently set up rules for how frontend code should be organized, and set up stricter linting and formatting
> rules for it, as detailed in docs/frontend-code.md. At the time, I decided to exclude the JS/TS side of device
> drivers and VM logic from these rules (which could be considered backend code, as it doesn't directly drive the UI),
> firstly to reduce the scope of the work, and secondly because I was worried that the stricter linting rules would
> lead to code that's less well optimized, or something along those lines; I believe that frontend and backend code
> don't necessarily have to play by the same rules (no notion of svelte in our backend, for instance). Your job is to
> work, through the night, on that code, which I believe lives in web/ but outside of web/app/, with multiple concerns
> in mind:
> - Code quality / general code review: are there problems we can identify just from reading the code alone? When it
>   comes to bugs, consider only issues that are actually reproducible in plausible scenarios; don't add logic to fix
>   problems that can't actually be triggered, especially if they would require changing logic in some hot path. Style
>   and code architecture issues are worth fixing too, if the fixes aren't likely to harm performance.
> - Performance: are there any performance optimization oppportunities? I believe that much of what this logic does is
>   not performance critical, but even then, there may be aspects worth optimizing, such as reusing buffers to reduce
>   memory/GC pressure. Even if we imagine that these devices represent just 2% of the page's CPU load, if we can
>   reduce that, then that's fewer things competing for memory bandwidth, CPU caches, etc. on the host, or just leading
>   to smoother behavior (particularly if there's anything that causes rare GC pauses).
> - Organization and linting: does it make sense to set up style guides and linters like what was done for web/app, to
>   ensure the code remains in good shape? The linter rules may or may not be the same as for the frontend code in
>   web/app - that's up to you to decide. I am OK with introducing new linting tools/dependencies if there's a strong
>   case for it.
>
> It's up to you to group these concerns into work lanes that make sense.

The user's answers to the session's questions (2026-11-20):

- **Prettier** covers `web/*.ts` too, with web/app's config: one reformat commit, in `.git-blame-ignore-revs`
  (`// prettier-ignore` where it would wreck a dense table).
- **ESLint**: typescript-eslint's type-checked correctness sets, the casts and `!` hot paths need allowed, **no size
  rules** (file length, function length, complexity: left to review); what fails today grandfathered in suppressions
  that only shrink.
- **Splits**: the biggest modules may be split where the seams are clear (pure moves, no logic change in the same
  commit).
- **Process**: a track (this file and HOST-HANDOVER.md, so a fresh session can continue it), worked without waiting for
  a go-ahead. **A/Bs only for hot paths**; several hot-path changes may share one A/B that confirms no regression.
  Cold-path allocation fixes ship with a test and an argument.

## Lanes

1. **Review**: out-of-context static reviews of the three slices (graphics and video; the VM, storage and snapshots;
   the network, USB, input, sound and the agent), findings triaged into fixes or the backlog.
2. **Linters**: Prettier's reformat; ESLint over `web/*.ts` with its own config block; a rules page for the host code
   (docs/host-code.md) beside docs/frontend-code.md.
3. **Fixes**: the confirmed defects, each with its confirming test (failing first).
4. **Performance**: allocation and copy fixes in the per-frame, per-packet, per-request paths; hot paths A/B'd.
5. **Splits**: the large modules along their seams, as pure moves.

## The end

Every test layer green (the whole CI set), docs updated (docs/host-code.md, the topics' pages), loose ends in the
backlog, the row in PLAN.md done, this file and the handover deleted.
