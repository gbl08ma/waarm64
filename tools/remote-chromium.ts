// A Chromium started elsewhere, attached over CDP instead of launched (docs/devenv.md "Chrome on the Windows VM"):
// WAARM64_CDP=<http://host:port> is its DevTools endpoint (a local forward to it), WAARM64_PAGE_BASE the origin it
// reaches this side's server at (its end of a reverse forward to port WAARM64_PORT, 8197 by default: a secure
// context, as cross-origin isolation needs). Only the GPU harnesses and the renderer's browser tests take it.
import { chromium, type Browser } from 'playwright-core';

/** The remote browser's endpoint, or undefined to launch one here. */
export const REMOTE_CDP = process.env.WAARM64_CDP;

/** The fixed port this side's server listens on for a remote browser (its reverse forward's). */
export const remotePort = () => Number(process.env.WAARM64_PORT ?? 8197);

/** The page's origin as the remote browser reaches it. */
export const remoteBase = () => process.env.WAARM64_PAGE_BASE ?? `http://localhost:${remotePort()}`;

/** Attaches to the remote browser. Its `close` only disconnects: the browser stays up (its owner stops it). */
export const connectRemote = (): Promise<Browser> => chromium.connectOverCDP(REMOTE_CDP!, { timeout: 30_000 });
