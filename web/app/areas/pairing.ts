// The local helper's pairing link (docs/frontend.md "Network"; waarm64-net prints
// `https://waarm64.com/#net=ws://127.0.0.1:<port>/<token>`): the fragment never reached a server; it leaves the address at
// once (it holds the token) and opens the Network wizard on it, attaching to the page's machine's first adapter when
// there's one. Also when the link is opened in a tab that already shows the page: only the fragment changes, and the
// browser doesn't load the page again. web/app/areas/page-window.ts takes it at load and on a change of fragment.
import { devText } from '../../msg.ts';
import { parseLocalURL } from '../../local-net.ts';
import { network } from './network.ts';

/** Takes the address's pairing link, if it has one; `machine`: the page's stored machine's id. */
export function takePairing(machine: string | undefined) {
  const pairing = new URLSearchParams(location.hash.slice(1)).get('net');
  if (!pairing) return;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  const p = parseLocalURL(pairing);
  if ('url' in p)
    network.openWizard(
      machine ? { mode: 'attach', machine, adapter: 0, localURL: p.url } : { mode: 'new', localURL: p.url },
    );
  else console.warn(`#net: ${devText(p.error)}`);
}
