// The status bar's TLB element (docs/frontend.md "The status bar"): the address translations the vCPUs looked up in the
// guest's page tables a second (TLB misses) and the guest's TLB flushes a second, all vCPUs (docs/cpu.md "MMU and TLB":
// the counters every vCPU publishes once per chunk). DOM-free, for tests/statusbar.test.ts.
import { t } from '../i18n.ts';
import type { IconName } from './icons.ts';
import type { Metrics } from './statusbar-metrics.ts';
import { count, piece, type Piece } from './statusbar-piece.ts';

/** The TLB element's piece: nothing until two statuses give the rates. */
export function tlbPiece(_i: unknown, icon: IconName | undefined, m: Metrics): Piece[] {
  if (m.tlbMisses === undefined || m.tlbFlushes === undefined) return [];
  const p = { misses: count(m.tlbMisses), flushes: count(m.tlbFlushes), count: Math.round(m.tlbFlushes) };
  return piece(icon, t('statusbar:statusbar-mmu.tlb', p), p.misses, t('statusbar:statusbar-mmu.tlb.title', p));
}
