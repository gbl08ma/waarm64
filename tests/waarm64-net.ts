// The local network helper for the tests (github.com/gbl08ma/waarm64-net, its own repository; docs/plans/networking-local.md):
// its source at the commit pinned below, fetched with git into target/net/waarm64-net-src, or a checkout of yours with
// WAARM64_NET_SRC (e.g. ../waarm64-net, when the page and the helper change together). Move the pin with a change of the
// helper the page needs, after its CI passed. (tests/go-pinned.ts does the fetching and building.)
import { pinnedGo } from './go-pinned.ts';

export const WAARM64_NET_COMMIT = '4e9d5859cf16bb332842b44172047b361aab8d3a'; // v0.4.0

const pinned = pinnedGo({
  name: 'waarm64-net',
  commit: WAARM64_NET_COMMIT,
  // Over HTTPS once the repository is public; while it's private, over SSH with the user's key.
  repos: ['https://github.com/gbl08ma/waarm64-net.git', 'git@github.com:gbl08ma/waarm64-net.git'],
  env: 'WAARM64_NET_SRC',
});

/** The helper's source directory, or why there is none (no git, no access to the repository). Fetched once. */
export const helperSource = pinned.source;
/** Builds the helper from its source into target/net/waarm64-net and returns the binary's path. */
export const buildHelper = pinned.build;
/** Why a test that builds the helper can't run (no Go, no source), or undefined. */
export const helperSkip = pinned.skip;
