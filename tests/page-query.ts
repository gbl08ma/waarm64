// What every page test adds to the page's query (docs/testing.md): `WEBPC_PAGE_QUERY=gpu=2d` runs them on 2D
// machines (3D, where WebGL2 is, is the default since G3). The clock catch-up is off (`clocksync=0`; the page's
// default is on): the tests were written for snapshots the guest doesn't sleep through, and a guest without logind
// would wait out the sleep key at each one. tests/page-clock.test.ts turns it on (a later `clocksync` wins).
export const PAGE_QUERY = `clocksync=0&${process.env.WEBPC_PAGE_QUERY ? `${process.env.WEBPC_PAGE_QUERY}&` : ''}`;
