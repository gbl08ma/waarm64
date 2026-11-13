// What every page test adds to the page's query (docs/testing.md): `WAARM64_PAGE_QUERY=gpu=2d` runs them on 2D
// machines (3D, where WebGL2 is, is the default since G3). The guest agent doesn't set the guest's clock
// (`clocksync=0`; the page's default is on): the tests were written for snapshots the guest's clock doesn't see.
// tests/page-clock.test.ts turns it on (a later `clocksync` wins).
export const PAGE_QUERY = `clocksync=0&${process.env.WAARM64_PAGE_QUERY ? `${process.env.WAARM64_PAGE_QUERY}&` : ''}`;
