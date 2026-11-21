# DOTCOM: where it stands

The brief is DOTCOM-KICKOFF.md. This file holds the state only.

## Done (2026-11-21)

- **DNS in the `waarm64.com` zone:** `demonet` A `89.144.30.89`, DNS only, as `demonet.tny.im` has it; a null MX; SPF
  `-all`; DMARC `p=reject`; `*._domainkey` with an empty key, so every DKIM key is revoked. No CAA: it would bind the
  demo network's Caddy certificate. The page's records and `disks`' are made by wrangler at the cutover. The user adds
  demonet's Caddy site; its `server.origins` already lists the new origin.
- **Loop 1** (4b0d6251): the new names are wherever a current name is. Dated history keeps the old ones. The demos'
  summaries give their logins and the Arch port. `cloud-setup.sh` falls back to vm.tny.im until the cutover.
- **The helper v0.4.0** is released (its default origin is `https://waarm64.com` only), and it's pinned in
  `web/local-release.ts` and `tests/waarm64-net.ts`. **waarm64-demonet:** its docs, sample config and tests are
  updated (306906d).
- **CI at 54678b8f:** ci.sh, ci-net, ci-machines, ci-debian and ci-graphics passed. Pushed.

## Next: the cutover (only on the user's go)

1. In a clean checkout at the pushed head: `npm run dist`, rebuild and republish the demos (remote-disks.md "Deploying
   the demos"; the store's summaries changed). Deploy the disks (`disks.waarm64.com`), then the page (`waarm64.com`).
2. Check from headless Chromium: cross-origin isolation, `/demos`, each demo starts, `apk add` through
   `demonet.waarm64.com` (after the user's Caddy site is up).
3. `vm.tny.im` → 301 to `https://waarm64.com`, keeping the path and the query: a redirect-only Worker (an assets-only
   `_redirects`, if it can redirect to another host) or a Redirect Rule in `tny.im`. `www.waarm64.com` → 301 to the
   apex.
4. Drop `vmdisks.tny.im`'s custom domain and `demonet.tny.im`'s A record, only those two in the user's `tny.im` zone.
   Remove `cloud-setup.sh`'s fallback, and frontend.md's "until DOTCOM's cutover" note.
5. The end: docs, the PLAN.md row set to done, and the kickoff and this file removed.
