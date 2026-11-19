// The demo network as the user sees it (docs/networking/demo-network.md "On the page"): an adapter's status line from
// its client's report (web/demo-net.ts `DemoStatus`: what the client does, the lane, the day's budget, the destinations
// refused, a restart announced), and the message bar's words for its notices. The server sends codes and numbers
// only; the words are these. DOM-free, for tests/demo-net.test.ts.
import { msg, t, text, type Msg } from '../i18n.ts';
import type { DemoNotice, DemoRefusal, DemoStatus, DemoWhy } from '../demo-net.ts';
import type { ClientReport, NetworkView } from './network-view.ts';

/** An RFC 3339 time as a `Date` for the words (`{{when}}`), or undefined. */
const dateOf = (s: string | undefined) => {
  const t = Date.parse(s ?? '');
  return Number.isFinite(t) ? new Date(t) : undefined;
};

/** Why the client waits, in words, with when it tries again (`when`). */
const WAITING: Record<DemoWhy, (when: Date) => Msg> = {
  unreachable: (when) => msg('network:demo-view.wait.unreachable', { when }),
  lost: (when) => msg('network:demo-view.wait.lost', { when }),
  guests: (when) => msg('network:demo-view.wait.guests', { when }),
  site: (when) => msg('network:demo-view.wait.site', { when }),
  connections: (when) => msg('network:demo-view.wait.connections', { when }),
  full: (when) => msg('network:demo-view.wait.full', { when }),
  bytes: (when) => msg('network:demo-view.wait.bytes', { when }),
  maintenance: (when) => msg('network:demo-view.wait.maintenance', { when }),
  session: (when) => msg('network:demo-view.wait.session', { when }),
};

/** A refused destination as the status names it: the name or the address, and the port when it has one. */
export function refusalText(r: DemoRefusal): string {
  const what = r.name ?? r.address ?? '?';
  return r.port === undefined ? what : `${what}:${r.port}`;
}

/** The status's lines under the headline: the day's budget, the refusals (a count and the last few), a restart. */
function demoDetails(d: DemoStatus): string[] {
  const out: string[] = [];
  const b = d.budget;
  if (b) {
    const when = dateOf(b.resets);
    out.push(
      when
        ? t('network:demo-view.budget.resets', { used: b.used, limit: b.limit, when })
        : t('network:demo-view.budget', { used: b.used, limit: b.limit }),
    );
  }
  if (d.refused?.total)
    out.push(
      t('network:demo-view.refused', {
        count: d.refused.total,
        names: [...new Set(d.refused.last.map(refusalText))].reverse(),
      }),
    );
  const at = dateOf(d.notice?.at);
  const back = dateOf(d.notice?.backAt);
  if (at) out.push(back ? t('network:demo-view.restart.back', { at, back }) : t('network:demo-view.restart', { at }));
  return out;
}

/** The headline of a demo network's status. */
function demoLine(d: DemoStatus, address: string | undefined): Msg {
  if (d.phase === 'waiting' && d.wait) {
    const when = d.wait.why === 'bytes' ? (dateOf(d.wait.resets) ?? new Date(d.wait.at)) : new Date(d.wait.at);
    return WAITING[d.wait.why](when);
  }
  if (d.phase === 'idle') return msg('network:demo-view.idle');
  if (d.phase === 'connecting')
    return d.again ? msg('network:demo-view.reconnecting') : msg('network:demo-view.connecting');
  if (d.lane === 'none') {
    const when = dateOf(d.laneResets);
    return when ? msg('network:demo-view.spent', { when }) : msg('network:demo-view.spent.noTime');
  }
  return address ? msg('network:demo-view.connected.address', { address }) : msg('network:demo-view.connected');
}

/**
 * A demo connection's view: connected (or idle: it reconnects when the guest next sends) once its socket has the
 * server's `hello`; its DHCP is the server's, which always gives the default route, so it is a primary as the local
 * helper's is (`primaryOf`); IPv6 it hasn't (the server's guests are IPv4 only).
 */
export function demoView(c: ClientReport): NetworkView {
  const d: DemoStatus = c.netmap?.demo ?? { phase: 'connecting', again: false };
  const address = c.netmap?.addresses[0]?.replace(/\/\d+$/, '');
  const line = demoLine(d, address);
  const connected = c.state === 'Running' && (d.phase === 'connected' || d.phase === 'idle');
  const details = demoDetails(d);
  return {
    phase: connected ? 'connected' : 'connecting',
    text: text(line),
    line,
    ...(details.length ? { details } : {}),
    ...(connected ? { address } : {}),
    exitNodes: [],
    internet: connected,
    internet6: false,
    demo: { ...(d.status ? { status: d.status } : {}), lane: d.lane ?? 'fast' },
  };
}

/** A notice's words and the message bar's tone: what's said and goes (`info`), or what stays until closed (`warn`). */
export function demoNotice(n: DemoNotice): { message: Msg; kind: 'info' | 'warn' } {
  const spent = (resets: string | undefined) => {
    const when = dateOf(resets);
    return {
      message: when ? msg('network:demo-view.notice.spent', { when }) : msg('network:demo-view.notice.spent.noTime'),
      kind: 'warn' as const,
    };
  };
  switch (n.kind) {
    case 'budget': {
      if (n.threshold >= 100) return spent(n.resets);
      const when = dateOf(n.resets);
      const p = { percent: n.threshold, used: n.used, limit: n.limit };
      return {
        message: when
          ? msg('network:demo-view.notice.budget.resets', { ...p, when })
          : msg('network:demo-view.notice.budget', p),
        kind: 'info',
      };
    }
    case 'lane':
      return n.lane === 'none' ? spent(n.resets) : { message: msg('network:demo-view.notice.back'), kind: 'info' };
    case 'spent':
      return spent(n.resets);
    case 'restart': {
      const at = dateOf(n.at) ?? new Date();
      const back = dateOf(n.backAt);
      return {
        message: back
          ? msg('network:demo-view.notice.restart.back', { at, back })
          : msg('network:demo-view.notice.restart', { at }),
        kind: 'info',
      };
    }
    case 'lost':
      return { message: msg('network:demo-view.notice.lost'), kind: 'warn' };
  }
}
