<!--
  The Machines page's Preferences (docs/machines.md §7): this browser's, for every machine. Leaving the page warns, the
  guest's clock catches up after a pause, the on-screen keyboard's modifiers, the shaders' cache budget, and the status
  bar's elements (StatusEditor.svelte).
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Field from './ui/Field.svelte';
  import Fields from './ui/Fields.svelte';
  import Note from './ui/Note.svelte';
  import Pane from './ui/Pane.svelte';
  import StatusEditor from './StatusEditor.svelte';
  import { PREFERENCES } from './machines-panes.ts';
  import { t } from '../i18n.ts';
  import type { PageNetwork } from './net-live.ts';
  import { leaveWarning, remember, settings } from './settings.ts';
  import { ui } from './ui.svelte.ts';
  import { CACHE_BUDGET, CACHE_BUDGET_CHOICES } from '../venus-cache.ts';

  type Props = { net: PageNetwork };
  let { net }: Props = $props();

  let warnOnLeave = $state(leaveWarning());
  let catchUpClock = $state(settings().clockSync !== false);
  let shaderMiB = $state(settings().shaderMiB ?? CACHE_BUDGET / 2 ** 20);
  const DEFAULT_SHADER_MIB = CACHE_BUDGET / 2 ** 20;
  /** The budgets offered, the one set among them. */
  const shaderChoices = $derived([...new Set([...CACHE_BUDGET_CHOICES, shaderMiB])].sort((a, b) => a - b));
  const shaderLabel = (n: number) =>
    n === DEFAULT_SHADER_MIB
      ? t('machines:PreferencesPane.shaderBudget.default', { n })
      : t('machines:SettingsTab.mib', { n });

  function oskToggle(on: boolean) {
    ui.oskModifiers = on ? 'toggle' : 'next';
    remember({ oskModifiers: ui.oskModifiers });
  }
</script>

<Pane
  id={PREFERENCES}
  title={t('machines:MachinesNav.preferences')}
  meta={t('machines:PreferencesPane.preferences.meta')}
>
  <Fields>
    <Check
      bind:checked={warnOnLeave}
      onchange={() => remember({ leaveWarning: warnOnLeave })}
      field="leave-warning"
      note={t('machines:PreferencesPane.leaveWarning.note')}
    >
      {t('machines:PreferencesPane.leaveWarning')}
    </Check>
    <Check
      bind:checked={catchUpClock}
      onchange={() => remember({ clockSync: catchUpClock })}
      field="clock-sync"
      note={t('machines:PreferencesPane.clockSync.note')}
    >
      {t('machines:PreferencesPane.clockSync')}
    </Check>
    <Check
      checked={ui.oskModifiers === 'toggle'}
      onchange={oskToggle}
      field="osk-toggle"
      note={t('machines:PreferencesPane.oskToggle.note')}
    >
      {t('machines:PreferencesPane.oskToggle')}
    </Check>
    <Field label={t('machines:PreferencesPane.shaderBudget')}>
      <select bind:value={shaderMiB} onchange={() => remember({ shaderMiB })} data-field="shader-budget">
        {#each shaderChoices as n (n)}<option value={n}>{shaderLabel(n)}</option>{/each}
      </select>
    </Field>
    <Note>{t('machines:PreferencesPane.shaderBudget.note')}</Note>
  </Fields>
  <div class="part">
    <h4>{t('machines:PreferencesPane.statusBar')}</h4>
    <StatusEditor {net} />
    <div class="status-fullscreen">
      <Fields>
        <Check
          bind:checked={ui.statusFullscreen}
          onchange={() => remember({ statusFullscreen: ui.statusFullscreen })}
          field="status-fullscreen"
          note={t('machines:PreferencesPane.statusFullscreen.note')}
        >
          {t('machines:PreferencesPane.statusFullscreen')}
        </Check>
      </Fields>
    </div>
  </div>
</Pane>

<style>
  .part {
    margin-top: var(--space-6);
  }
  h4 {
    margin: 0 0 var(--space-4);
    font-size: var(--text-base);
    font-weight: var(--weight-bold);
  }
  .status-fullscreen {
    margin-top: var(--space-5);
  }
</style>
