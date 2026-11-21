<!--
  A number on a slider, with notches under it at the suggested values and the value in words beside it (`label`): a
  machine's vCPUs, RAM and JIT cache, the Sound menu's volume. It moves in `step`s from `min` to `max` (widened to take a `value` outside
  them); dragged or clicked within `snap` of a notch, it lands on the notch (the keyboard's arrows step past them, so
  they never stick). `value` binds; `onchange` gets each new value. `id` and `field` (`data-field`) go on the input,
  the tests' handles (Playwright's `fill` sets it); `title` and `disabled` too. A parent sets the value's width with
  `--slider-value-w`.
-->
<script lang="ts">
  type Props = {
    value: number;
    min: number;
    max: number;
    step: number;
    /** The suggested values, marked under the track. */
    notches: number[];
    /** How near a notch a pointer's value lands on it (0: no snapping). */
    snap?: number;
    label: (n: number) => string;
    id?: string;
    field?: string;
    title?: string;
    disabled?: boolean;
    onchange?: (n: number) => void;
  };
  let {
    value = $bindable(),
    min,
    max,
    step,
    notches,
    snap = 0,
    label,
    id,
    field,
    title,
    disabled = false,
    onchange,
  }: Props = $props();

  const lo = $derived(Math.min(min, value));
  const hi = $derived(Math.max(max, value));
  /** Where each notch sits along the track, 0 to 1. */
  const marks = $derived(
    notches.filter((n) => n >= lo && n <= hi).map((n) => ({ n, at: hi > lo ? (n - lo) / (hi - lo) : 0 })),
  );
  /** A pointer is down on the slider: its values snap to the notches (the keyboard's don't). */
  let pointer = false;

  function snapped(n: number) {
    if (!pointer || !snap) return n;
    const near = notches.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), notches[0] ?? n);
    return Math.abs(near - n) <= snap ? near : n;
  }
  function input(e: Event & { currentTarget: HTMLInputElement }) {
    const n = snapped(Number(e.currentTarget.value));
    e.currentTarget.value = String(n);
    if (n !== value) {
      value = n;
      onchange?.(n);
    }
  }
</script>

<span class="slider">
  <span class="track">
    <input
      type="range"
      {id}
      data-field={field}
      {title}
      {disabled}
      min={lo}
      max={hi}
      {step}
      {value}
      aria-valuetext={label(value)}
      oninput={input}
      onpointerdown={() => (pointer = true)}
      onpointerup={() => (pointer = false)}
      onpointercancel={() => (pointer = false)}
    />
    <span class="notches" aria-hidden="true">
      {#each marks as m (m.n)}<span class={['notch', { on: m.n === value }]} style:--at={m.at}></span>{/each}
    </span>
  </span>
  <output for={id}>{label(value)}</output>
</span>

<style>
  .slider {
    /* The cap: a key standing in the groove, a lit line down its middle (`--thumb` its width, which the notches
       follow). */
    --thumb: 12px;
    --cap-h: 20px;
    display: flex;
    align-items: center;
    gap: var(--space-4);
    min-width: 0;
    min-height: var(--control-h);
  }
  .track {
    position: relative;
    flex: 1;
    min-width: 120px;
    display: flex;
    flex-direction: column;
  }
  input {
    appearance: none;
    width: 100%;
    height: var(--cap-h);
    margin: 0;
    background: transparent;
    cursor: pointer;
  }
  input:disabled {
    opacity: 0.45;
    cursor: default;
  }
  input:focus-visible {
    outline: none;
  }
  input::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: var(--radius-sm);
    background: var(--well-bg);
    box-shadow: var(--groove-edge);
  }
  input::-webkit-slider-thumb {
    appearance: none;
    box-sizing: border-box;
    width: var(--thumb);
    height: var(--cap-h);
    margin-top: calc((4px - var(--cap-h)) / 2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--cap-bg);
    box-shadow: var(--cap-edge);
  }
  input:focus-visible::-webkit-slider-thumb {
    box-shadow: var(--shadow-focus);
  }
  input::-moz-range-track {
    height: 4px;
    border-radius: var(--radius-sm);
    background: var(--well-bg);
    box-shadow: var(--groove-edge);
  }
  input::-moz-range-thumb {
    box-sizing: border-box;
    width: var(--thumb);
    height: var(--cap-h);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--cap-bg);
    box-shadow: var(--cap-edge);
  }
  /* The notches line up with the thumb's centre at their values: the thumb travels the track less its own width. */
  .notches {
    position: relative;
    height: var(--space-3);
  }
  .notch {
    position: absolute;
    top: 0;
    left: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--at));
    width: 1px;
    height: var(--space-2);
    background: var(--text-dim);
  }
  .notch.on {
    background: var(--accent);
  }
  /* The value's width: a parent sets `--slider-value-w` so a column of sliders lines its tracks up. */
  output {
    min-width: var(--slider-value-w, 7ch);
    color: var(--text);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
