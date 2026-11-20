<!--
  The CPU's deep dive on the introduction (IntroHow.svelte): the captured code in its four forms (IntroTranslate.svelte),
  once its data is here (captures.ts: fetched when this opens).
-->
<script lang="ts">
  import Note from '../ui/Note.svelte';
  import IntroTranslate from './IntroTranslate.svelte';
  import { loadCaptures } from './captures.ts';
  import { t } from '../../i18n.ts';
</script>

{#await loadCaptures()}
  <Note size="md" role="status">{t('intro:IntroCpuDive.loading')}</Note>
{:then captures}
  <IntroTranslate captures={captures.blocks} />
{:catch}
  <Note size="md" tone="error" role="alert">{t('intro:IntroCpuDive.failed')}</Note>
{/await}
