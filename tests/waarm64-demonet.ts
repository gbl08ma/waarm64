// The demo network's server for the tests (github.com/gbl08ma/waarm64-demonet, its own repository, a fork of
// waarm64-net: docs/networking/demo-network.md): its source at the commit pinned below, fetched with git into
// target/net/waarm64-demonet-src, or a checkout of yours with WAARM64_DEMONET_SRC (e.g. ../waarm64-demonet, when the
// page and the server change together), built with Go into target/net/waarm64-demonet. Move the pin with a change of
// the server the page needs, after its tests passed. The repository is private: where it can't be fetched (a cloud
// session), the tests that need it say SKIPPED.
import { pinnedGo } from './go-pinned.ts';

export const WAARM64_DEMONET_COMMIT = '73d9a2d6de76865790d720437895458c36e1c443'; // loop 11's review fixes, PROTOCOL.md v1

const pinned = pinnedGo({
  name: 'waarm64-demonet',
  commit: WAARM64_DEMONET_COMMIT,
  repos: ['https://github.com/gbl08ma/waarm64-demonet.git', 'git@github.com:gbl08ma/waarm64-demonet.git'],
  env: 'WAARM64_DEMONET_SRC',
  privateNote: 'the repository is private (a cloud session has no key for it: docs/cloud.md)',
});

/** The server's source directory, or why there is none. Fetched once. */
export const demonetSource = pinned.source;
/** Builds the server into target/net/waarm64-demonet and returns the binary's path. */
export const buildDemonet = pinned.build;
/** Why a test that builds the server can't run (no Go, no source), or undefined. */
export const demonetSkip = pinned.skip;
