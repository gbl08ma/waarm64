**The user's brief (2026-11-13)**, for the track **AGENT**: the clipboard agent made a general-purpose guest agent that
sets the guest's clock after a restore, in place of the sleep-key catch-up; on vsock.

> I was reading the backlog entries under "The guest's clock after a restore" and I'm thinking that it'd probably
> offer a better user experience to "just" turn the clipboard agent into a more general-purpose one, as some plans
> probably already called for, and having the agent set the clock on resume. then, syncing the clock after a restore
> would only be available when the agent is enabled, and we remove the "press the sleep key" thing and associated
> workarounds. We should keep the virtio-rtc device (which can remain gated on the "Clock device" machine setting, it
> just won't trigger a clock sync on the guest as part of this setting). We could turn the agent on by default,
> separately from requesting the browser permission for clipboard access. I believe this will avoid the
> song-and-dance of pressing the sleep key and hoping that the guest will sleep, and that nothing will break with that
> sleep (problems around this have already been addressed in b9843ea580aa4dc26ce31d24b19df781e4073c95, but the
> solutions created backlog entries of their own). It may also be a good opportunity to tackle the "The agent over
> virtio-vsock instead of its virtio-console" backlog item at the same time. It's likely that the agent's size will
> increase with all these changes, but it is what it is. If you have doubts, ask questions before starting.

**The user's answers (2026-11-13):**
- **Clipboard and agent:** separate switches per machine: the guest agent (on by default) and, under it, clipboard
  sharing (off by default; ticking it asks Chromium's read permission, as now). The agent does no clipboard work unless
  the clipboard is shared.
- **Existing machines:** the agent's default applies to every stored machine without an explicit choice (with vsock
  it no longer changes a machine's shape).
- **The clock's switch:** Preferences keeps one (the former catch-up's), global and on by default: "set the guest's
  clock after a restore", effective where the agent runs.

**Plan (the session's):**
1. The agent over vsock (the firmware machines' device, a host port of the agent's: connections the guest opens, data
   both ways under vsock's credit); the agent's virtio-console kind and SYNC go (a restore resets the transport, the
   agent reconnects). The agent's setting (on by default) apart from the clipboard's.
2. A TIME frame the agent applies (`clock_settime`): at each agent's HELLO, after a running machine's save pause, and
   when the host's own sleep shows (`Date.now()` moving away from `performance.now()`), under Preferences' switch. The
   sleep key, `slept` and `vm_clock_skip` go; a guest that suspends itself still sleeps and wakes.
3. Docs (clipboard.md, devices.md, frontend.md, plans/agent.md, backlog), an out-of-context review, the CI scripts
   (ci.sh, ci-debian.sh with --platform, ci-machines.sh).
