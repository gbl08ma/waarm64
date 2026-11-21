# DOTCOM: waarm64.com as the primary origin

The user's brief, confirmed 2026-11-21.

## Goal

`https://waarm64.com` becomes the page's origin, and its services move to `disks.waarm64.com` and
`demonet.waarm64.com`. Once the new site is deployed, `vm.tny.im` answers with a 301 to it.

## Decisions taken (the user, 2026-11-21)

- **Nobody uses vm.tny.im**, so visitors start empty on the new origin. There's no migration, no notice period and no
  compatibility with records that hold the old names (stored demo machines, demo connections): they may break.
- **The names:** `waarm64.com` (the page; `www.` sends a 301 to the apex), `disks.waarm64.com` (Worker
  `waarm64-disks`) and `demonet.waarm64.com` (the user's server). The Workers keep their names.
- **vm.tny.im** sends a 301 to `https://waarm64.com` as soon as the new site is deployed, keeping the path and query
  (the browser carries the fragment).
- **vmdisks.tny.im and demonet.tny.im** are dropped once nothing points at them. Nothing on our side needs them after
  the deploy.
- **The local helper** gets a v0.4.0 release whose default origin is `https://waarm64.com` (only that one). The release
  is OK'd.
- The token has DNS and Workers Routes on the new zone.

## Done

- 2026-11-21: `demonet.waarm64.com` A `89.144.30.89`, DNS only, as `demonet.tny.im` has it. It resolves through
  1.1.1.1. The server's `server.origins` already lists the new origin. The user adds the Caddy site.

## Loops

1. **The repo.** The constants: `OUR_STORE` (web/app/demo-store.ts), `DEMO_URL` (web/demo-net.ts) and `lna.ts`'s
   default. `wrangler.jsonc` routes: `waarm64.com` and `www.waarm64.com`. `deploy/disks/wrangler.jsonc`:
   `disks.waarm64.com`. Every doc, the README, the tests, `scripts/cloud-setup.sh`, and the UI message in network.json
   (copy.md checked). Dated history stays as written. CI: ci-fast, then ci.sh and the topic scripts for the areas
   touched (net, machines, debian), run when PERF's CI isn't running (the lock queues them).
2. **waarm64-net v0.4.0:** `DefaultOrigin`, the README, the pairing link. Its CI, then the release.
   **waarm64-demonet:** the README, the sample config and main.go's comment (the hosted config is already done).
3. **The cutover**, when the user says go, at the pushed head (remote-disks.md "Deploying the demos"):
   - deploy the disks onto `disks.waarm64.com`, then the page onto `waarm64.com` and `www`;
   - check from headless Chromium: cross-origin isolated, `/demos` lists every demo, each starts, and `apk add` goes
     through `demonet.waarm64.com`;
   - then `vm.tny.im` → 301. The page Worker loses that route, and a redirect-only Worker takes it (assets-only with a
     `_redirects` file if Workers' assets support redirects to another domain, so it stays unbilled; otherwise a
     Redirect Rule in the `tny.im` zone);
   - after that, drop `vmdisks.tny.im`'s custom domain and `demonet.tny.im`'s A record (the user's zone: only those
     two records).
   - Mail records for `waarm64.com`: `v=spf1 -all`, DMARC `p=reject`, a null MX.
4. **The end:** docs say what each name is and that the tny.im names are gone. PLAN.md's row is set to done, and this
   kickoff is removed.
