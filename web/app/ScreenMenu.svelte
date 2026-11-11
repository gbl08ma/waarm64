<!--
  The toolbar's screen menu (virtio-gpu machines; docs/frontend.md "The screen"): the screen's size (fit the window,
  or a fixed one) and whether it's drawn at the display's pixels (HiDPI).
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Field from './ui/Field.svelte';
  import Menu from './ui/Menu.svelte';
  import Note from './ui/Note.svelte';
  import { t } from '../i18n.ts';
  import { remember, settings } from './settings.ts';
  import { page } from './ui.svelte.ts';

  const SIZES = ['1024x768', '1280x800', '1920x1080'];
  const saved = settings().screen;
  let screenSize = $state(saved && SIZES.includes(saved) ? saved : 'fit');
  let hidpi = $state(settings().hidpi ?? false);
  // i18n-ignore-next: a size, not words
  const sizeText = (s: string) => s.replace('x', '×');
</script>

<Menu id="screen-menu" icon="aspect-ratio" title={t('toolbar:ScreenMenu.screen.title')} panel>
  <Field label={t('toolbar:ScreenMenu.screen.size')}>
    <select
      id="screen-size"
      bind:value={screenSize}
      onchange={() => {
        remember({ screen: screenSize });
        page.screenSize();
      }}
    >
      <option value="fit">{t('toolbar:ScreenMenu.screen.fit')}</option>
      {#each SIZES as s (s)}<option value={s}>{sizeText(s)}</option>{/each}
    </select>
  </Field>
  <Check
    id="screen-hidpi"
    bind:checked={hidpi}
    onchange={() => {
      remember({ hidpi });
      page.screenSize();
    }}
    title={t('toolbar:ScreenMenu.screen.hidpi.title')}
  >
    {t('toolbar:ScreenMenu.screen.hidpi')}
  </Check>
  <Note>{t('toolbar:ScreenMenu.screen.hint')}</Note>
</Menu>
