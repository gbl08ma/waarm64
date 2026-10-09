// What every page test adds to the page's query (docs/testing.md "The page"): `WEBPC_PAGE_QUERY=gpu=virgl` runs
// them on 3D machines (the G3 kickoff's condition for 3D's default).
export const PAGE_QUERY = process.env.WEBPC_PAGE_QUERY ? `${process.env.WEBPC_PAGE_QUERY}&` : '';
