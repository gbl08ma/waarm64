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
  import { current } from './areas/current.svelte.ts';
  import { mouse } from './areas/mouse.svelte.ts';
  import { page } from './page.ts';

  function titleOf() {
    if (mouse.locked) return t('toolbar:MouseMenu.mouse.title.locked');
    return mouse.lock ? t('toolbar:MouseMenu.mouse.title.on') : t('toolbar:MouseMenu.mouse.title');
  }
  const title = $derived(titleOf());
</script>

<Menu id="mouse-lock" icon="mouse" {title} on={mouse.lock} panel>
  <Check
    id="mouse-lock-on"
    checked={mouse.lock}
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
    checked={mouse.mode === 'pointer'}
    onchange={() => page.setMouseLock(mouse.lock, 'pointer')}
  >
    {t('toolbar:MouseMenu.mouse.pointer')}
  </Radio>
  <Radio
    name="mouse-lock-mode"
    value="raw"
    data-mode="raw"
    title={current.hasMouse ? t('toolbar:MouseMenu.mouse.raw.title') : t('toolbar:MouseMenu.mouse.raw.title.noMouse')}
    checked={mouse.mode === 'raw'}
    disabled={!current.hasMouse}
    onchange={() => page.setMouseLock(mouse.lock, 'raw')}
  >
    {t('toolbar:MouseMenu.mouse.raw')}
  </Radio>
  <Note>{current.hasMouse ? t('toolbar:MouseMenu.mouse.hint') : t('toolbar:MouseMenu.mouse.hint.noMouse')}</Note>
</Menu>
