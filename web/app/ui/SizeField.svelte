<!--
  A size typed: a number and its unit beside it (binary units, `units`: MiB and GiB by default), bound to `bytes`,
  rounded up to a multiple of `round` (a MiB by default; web/app/size-input.ts). `bytes` is `undefined` while what's
  typed isn't a size between `min` and `max` (both in bytes, included), and the field says why under it. The size it
  starts with is `bytes`' at mount, in the largest unit it's a whole number of: a caller that learns it later mounts
  the field then. `field` and `unitField` name the number and the unit's list (`data-field`, the tests' handles). Goes
  in a `Field`, which labels it.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Note from './Note.svelte';
  import { t } from '../../i18n.ts';
  import { convert, inUnits, sizeProblem, toBytes, SIZE_UNITS, type SizeUnit } from '../size-input.ts';

  type Props = {
    bytes: number | undefined;
    min?: number;
    max?: number;
    units?: readonly SizeUnit[];
    round?: number;
    field?: string;
    unitField?: string;
  };
  let {
    bytes = $bindable(),
    min = SIZE_UNITS.MiB,
    max,
    units = ['MiB', 'GiB'],
    round = SIZE_UNITS.MiB,
    field,
    unitField,
  }: Props = $props();

  const start = untrack(() => (bytes === undefined ? { amount: NaN, unit: units[0] } : inUnits(bytes, units)));
  let amount = $state(start.amount);
  let unit = $state<SizeUnit>(start.unit);
  const problem = $derived(sizeProblem(toBytes(amount, unit, round), min, max));
  const UNIT_WORDS: Record<SizeUnit, string> = {
    MiB: t('common:SizeField.unit.MiB'),
    GiB: t('common:SizeField.unit.GiB'),
    TiB: t('common:SizeField.unit.TiB'),
  };
  const WORDS = {
    empty: () => t('common:SizeField.empty'),
    small: () => t('common:SizeField.small', { min }),
    large: () => t('common:SizeField.large', { max }),
  };

  /** The size typed, out to the caller: `undefined` while it isn't one. */
  function typed() {
    const b = toBytes(amount, unit, round);
    bytes = sizeProblem(b, min, max) ? undefined : b;
  }
  function setUnit(next: SizeUnit) {
    if (Number.isFinite(amount)) amount = convert(amount, unit, next);
    unit = next;
    typed();
  }
</script>

<span class="size">
  <span class="line"
    ><input
      type="number"
      min="0"
      step="any"
      bind:value={
        () => (Number.isFinite(amount) ? amount : null),
        (v: number | null) => {
          amount = v ?? NaN;
          typed();
        }
      }
      aria-invalid={problem ? 'true' : undefined}
      data-field={field}
    /><select
      value={unit}
      onchange={(e) => setUnit(e.currentTarget.value as SizeUnit)}
      aria-label={t('common:SizeField.unit')}
      data-field={unitField}
    >
      {#each units as u (u)}<option value={u}>{UNIT_WORDS[u]}</option>{/each}
    </select></span
  >
  {#if problem}<Note inline tone="error" size="md" data-size-problem role="alert">{WORDS[problem]()}</Note>{/if}
</span>

<style>
  .size {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .line {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  input {
    flex: 0 1 140px;
    min-width: 0;
  }
</style>
