<!--
  The toolbar's mouse lock menu (docs/frontend.md "Mouse lock"): the lock on or off, and its mode, the pointer (the
  tablet) or Raw (the machine's mouse, when it has one).
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Menu from './ui/Menu.svelte';
  import Note from './ui/Note.svelte';
  import Radio from './ui/Radio.svelte';
  import { t } from '../i18n.ts';
  import { page, ui } from './ui.svelte.ts';

  function titleOf() {
    if (ui.mouseLocked) return t('toolbar:MouseMenu.mouse.title.locked');
    return ui.mouseLock ? t('toolbar:MouseMenu.mouse.title.on') : t('toolbar:MouseMenu.mouse.title');
  }
  const title = $derived(titleOf());
</script>

<Menu id="mouse-lock" icon="mouse" {title} on={ui.mouseLock} panel>
  <Check
    id="mouse-lock-on"
    checked={ui.mouseLock}
    onchange={(on: boolean) => page.setMouseLock(on)}
    title={t('toolbar:MouseMenu.mouse.lock.title')}
  >
    {t('toolbar:MouseMenu.mouse.lock')}
  </Check>
  <Radio
    name="mouse-lock-mode"
    value="pointer"
    data-mode="pointer"
    title={t('toolbar:MouseMenu.mouse.pointer.title')}
    checked={ui.mouseLockMode === 'pointer'}
    onchange={() => page.setMouseLock(ui.mouseLock, 'pointer')}
  >
    {t('toolbar:MouseMenu.mouse.pointer')}
  </Radio>
  <Radio
    name="mouse-lock-mode"
    value="raw"
    data-mode="raw"
    title={ui.hasMouse ? t('toolbar:MouseMenu.mouse.raw.title') : t('toolbar:MouseMenu.mouse.raw.title.noMouse')}
    checked={ui.mouseLockMode === 'raw'}
    disabled={!ui.hasMouse}
    onchange={() => page.setMouseLock(ui.mouseLock, 'raw')}
  >
    {t('toolbar:MouseMenu.mouse.raw')}
  </Radio>
  <Note>{ui.hasMouse ? t('toolbar:MouseMenu.mouse.hint') : t('toolbar:MouseMenu.mouse.hint.noMouse')}</Note>
</Menu>
