// What every page test adds to the page's query (docs/testing.md): `WEBPC_PAGE_QUERY=gpu=2d` runs them on 2D
// machines (3D, where WebGL2 is, is the default since G3).
export const PAGE_QUERY = process.env.WEBPC_PAGE_QUERY ? `${process.env.WEBPC_PAGE_QUERY}&` : '';
