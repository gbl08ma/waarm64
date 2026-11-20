<!--
  The introduction's code viewer (the CPU's deep dive: IntroCpuDive.svelte): one captured guest block in its four forms
  side by side (captures.ts; ui/CodePane.svelte): the AArch64 instructions, the block interpreter's micro-ops, the
  WebAssembly our JIT emitted, and the machine code V8 made of that. One instruction is active at a time and lit in
  every pane: the stepper walks them (by itself while the viewer is in view, unless the visitor asked for less
  motion), and the pointer over a line picks its instruction. Chips choose the block; its C source and what to look
  for are under them.
-->
<script lang="ts">
  import CodePane from '../ui/CodePane.svelte';
  import Stepper from '../ui/Stepper.svelte';
  import T from '../T.svelte';
  import type { CodeItem } from '../ui/code-pane.ts';
  import { guestRows, hostBytes, hostRows, uopRows, wasmItems, wasmLinesOf } from './captures.ts';
  import type { Capture, FoldKind, HostArch } from './captures.ts';
  import type { Why, WhyKind } from './notes.ts';
  import { isNote } from '../ui/code-pane.ts';
  import { Autoplay } from './autoplay.svelte.ts';
  import { t } from '../../i18n.ts';
  import { thisTarget } from '../../local-release.ts';

  type Props = { captures: Capture[] };
  let { captures }: Props = $props();

  /** A block's name on its chip and what to look for in it (the catalog's keys, written out for i18n-check). */
  const WORDS = new Map<string, [name: string, look: string]>([
    ['sum-loop', ['intro:IntroTranslate.sum', 'intro:IntroTranslate.sum.look']],
    ['move-point', ['intro:IntroTranslate.move', 'intro:IntroTranslate.move.look']],
    ['collatz-loop', ['intro:IntroTranslate.collatz', 'intro:IntroTranslate.collatz.look']],
    ['total-loop', ['intro:IntroTranslate.total', 'intro:IntroTranslate.total.look']],
    ['cap-loop', ['intro:IntroTranslate.cap', 'intro:IntroTranslate.cap.look']],
  ]);
  const shown = $derived(captures.filter((c) => WORDS.has(c.id)));
  let id = $state<string>();
  const capture = $derived(shown.find((c) => c.id === id) ?? shown.at(0));
  /** The host whose code shows: the visitor's own kind of processor when it was captured, else the first there is. */
  const ARCHES: HostArch[] = ['x64', 'arm64'];
  const ARCH_NAME: Record<HostArch, string> = { x64: 'x86-64', arm64: 'AArch64' }; // i18n-ignore
  const arches = $derived(ARCHES.filter((a) => capture?.host[a]));
  let archPicked = $state<HostArch>();
  /** The visitor's own (Chromium's client hints, else the user agent's guess; local-release.ts). */
  let archOwn = $state<HostArch>();
  void thisTarget().then((target) => {
    if (target) archOwn = target.arch === 'arm64' ? 'arm64' : 'x64';
  });
  const arch = $derived([archPicked, archOwn].find((a) => a && arches.includes(a)) ?? arches.at(0));

  /** The active instruction; the steps run by themselves while the viewer is on screen. */
  let at = $state(0);
  const auto = new Autoplay();
  $effect(() => {
    const n = capture?.guest.length ?? 0;
    return auto.run(n, 2200, () => (at = (at + 1) % n));
  });
  /** Another block chosen: from its first instruction. */
  const choose = (block: string) => {
    id = block;
    at = 0;
  };
  /** The pointer on a line: its instruction, and the steps stop running by themselves. */
  const pick = (g: number) => {
    auto.playing = false;
    at = g;
  };

  const FOLD: Record<FoldKind, (count: number) => string> = {
    prologue: (count) => t('intro:IntroTranslate.fold.prologue', { count }),
    slow: (count) => t('intro:IntroTranslate.fold.slow', { count }),
    exit: (count) => t('intro:IntroTranslate.fold.exit', { count }),
  };
  /**
   * A note's words by its kind (notes.ts places them; the catalog's keys, written out for i18n-check). Two of the
   * host's differ by processor: what V8 does about an access outside the memory isn't the same on both.
   */
  const WHY: Record<Exclude<WhyKind, 'hostEntry' | 'hostRegs' | 'regs' | 'back'>, string> = {
    sig: 'intro:IntroTranslate.why.sig',
    pc: 'intro:IntroTranslate.why.pc',
    loop: 'intro:IntroTranslate.why.loop',
    tlb: 'intro:IntroTranslate.why.tlb',
    hit: 'intro:IntroTranslate.why.hit',
    miss: 'intro:IntroTranslate.why.miss',
    flags: 'intro:IntroTranslate.why.flags',
    again: 'intro:IntroTranslate.why.again',
    pcBack: 'intro:IntroTranslate.why.pcBack',
    chain: 'intro:IntroTranslate.why.chain',
    ret: 'intro:IntroTranslate.why.ret',
    hostLoop: 'intro:IntroTranslate.why.hostLoop',
    hostTlb: 'intro:IntroTranslate.why.hostTlb',
    hostGray: 'intro:IntroTranslate.why.hostGray',
    hostBounds: 'intro:IntroTranslate.why.hostBounds',
    hostExit: 'intro:IntroTranslate.why.hostExit',
    hostChain: 'intro:IntroTranslate.why.hostChain',
    hostRare: 'intro:IntroTranslate.why.hostRare',
    hostSlow: 'intro:IntroTranslate.why.hostSlow',
  };
  const say = (why: Why) => {
    if (why.kind === 'hostEntry')
      return arch === 'arm64'
        ? t('intro:IntroTranslate.why.hostEntry.arm64')
        : t('intro:IntroTranslate.why.hostEntry.x64');
    if (why.kind === 'hostRegs')
      return arch === 'arm64'
        ? t('intro:IntroTranslate.why.hostRegs.arm64')
        : t('intro:IntroTranslate.why.hostRegs.x64');
    const regs = (why.regs ?? []).join(', ');
    if (why.kind === 'regs') return t('intro:IntroTranslate.why.regs', { regs });
    if (why.kind === 'back') return t('intro:IntroTranslate.why.back', { regs });
    return t(WHY[why.kind]);
  };
  const guest = $derived(capture ? guestRows(capture) : []);
  const uops = $derived(capture ? uopRows(capture) : []);
  const wasm = $derived<CodeItem[]>(
    capture
      ? wasmItems(capture, say).map((i) =>
          'fold' in i
            ? { label: FOLD[i.fold](i.rows.filter((r) => !isNote(r)).length), rows: i.rows, group: i.group }
            : i,
        )
      : [],
  );
  const host = $derived(capture && arch ? hostRows(capture, arch, say) : []);
</script>

{#if capture}
  <div class="translate" use:auto.watch data-translate={capture.id}>
    <div class="blocks" role="group" aria-label={t('intro:IntroTranslate.blocks')}>
      {#each shown as c (c.id)}
        <button class="chip" aria-pressed={c.id === capture.id} onclick={() => choose(c.id)} data-block={c.id}>
          {t(WORDS.get(c.id)?.[0] ?? '')}
        </button>
      {/each}
    </div>
    <div class="about">
      <pre class="source">{capture.source.trim()}</pre>
      <div class="look">
        <p>{t(WORDS.get(capture.id)?.[1] ?? '')}</p>
        <p class="fine"><T k="intro:IntroTranslate.compiler" params={{ compiler: capture.compiler }} /></p>
        <Stepper
          bind:at
          bind:playing={auto.playing}
          count={capture.guest.length}
          labels={{
            back: t('intro:IntroTranslate.back'),
            next: t('intro:IntroTranslate.next'),
            play: t('intro:IntroTranslate.play'),
            pause: t('intro:IntroTranslate.pause'),
            place: t('intro:IntroTranslate.place', {
              at: at + 1,
              count: capture.guest.length,
              lines: wasmLinesOf(capture, at),
            }),
          }}
        />
      </div>
    </div>
    <div class="panes">
      <CodePane
        title={t('intro:IntroTranslate.guest')}
        sub={t('intro:IntroTranslate.guest.sub', { count: guest.length })}
        items={guest}
        active={at}
        onpick={pick}
        data-pane="guest"
      />
      <CodePane
        title={t('intro:IntroTranslate.uops')}
        sub={t('intro:IntroTranslate.uops.sub', { count: uops.length })}
        items={uops}
        active={at}
        onpick={pick}
        data-pane="uops"
      />
      <CodePane
        title={t('intro:IntroTranslate.wasm')}
        sub={t('intro:IntroTranslate.wasm.sub', { count: capture.wasm.length })}
        items={wasm}
        active={at}
        onpick={pick}
        data-pane="wasm"
      />
      {#if arch}
        <CodePane
          title={t('intro:IntroTranslate.host')}
          sub={t('intro:IntroTranslate.host.sub', {
            count: capture.host[arch]?.lines.length ?? 0,
            size: hostBytes(capture, arch),
            arch: ARCH_NAME[arch],
          })}
          items={host}
          active={at}
          onpick={pick}
          data-pane="host"
        />
      {/if}
    </div>
    {#if arches.length > 1}
      <div class="blocks" role="group" aria-label={t('intro:IntroTranslate.arches')}>
        {#each arches as a (a)}
          <button class="chip" data-arch={a} aria-pressed={a === arch} onclick={() => (archPicked = a)}
            >{ARCH_NAME[a]}</button
          >
        {/each}
      </div>
    {/if}
    <p class="fine">
      <T k="intro:IntroTranslate.honest" params={{ compiler: (arch && capture.host[arch]?.compiler) ?? '' }} />
    </p>
  </div>
{/if}

<style>
  .translate {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    min-width: 0;
  }
  .blocks {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  /* A block's chip: a key; the chosen one sunk, its legend lit. */
  .chip {
    min-height: var(--control-h);
    padding: 0 var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--key-bg);
    box-shadow: var(--key-edge);
  }
  .chip:hover {
    background: var(--key-hover-bg);
  }
  .chip[aria-pressed='true'] {
    background: var(--pressed-bg);
    box-shadow: var(--pressed-edge);
    color: var(--accent);
    text-shadow: var(--lit-text);
  }
  .about {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-6);
    align-items: start;
  }
  .source {
    margin: 0;
    padding: var(--space-4);
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--well-bg);
    box-shadow: var(--well-edge);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  .look {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-4);
  }
  p {
    margin: 0;
  }
  .fine {
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  /* The four forms side by side, the guest's the narrowest; two by two, then one under the other, as the window
     narrows. Each keeps its height and scrolls inside it. */
  .panes {
    display: grid;
    grid-template-columns: minmax(0, 0.8fr) minmax(0, 1fr) minmax(0, 1.1fr) minmax(0, 1.2fr);
    grid-auto-rows: 440px;
    gap: var(--space-4);
  }
  @media (max-width: 1200px) {
    .panes {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      grid-auto-rows: 300px;
    }
  }
  @media (max-width: 720px) {
    .panes,
    .about {
      grid-template-columns: minmax(0, 1fr);
    }
    .panes {
      grid-auto-rows: 240px;
    }
  }
</style>
