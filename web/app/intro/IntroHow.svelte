<!--
  The introduction's "How it works" (web/app/IntroPage.svelte): five topics (IntroTopic.svelte), each a paragraph and
  a path of five stages that steps by itself (IntroPath.svelte): the processor, memory, OpenGL, video, Vulkan. Two
  have a deep dive: the processor's shows captured code in its four forms (IntroCpuDive.svelte), memory's how RAM is
  split over WebAssembly memories (IntroRam.svelte). The facts are the docs' (cpu.md, jit.md, architecture.md,
  spill-memories.md, graphics.md); a figure names what it was measured on.
-->
<script lang="ts">
  import IntroCpuDive from './IntroCpuDive.svelte';
  import IntroPath from './IntroPath.svelte';
  import IntroRam from './IntroRam.svelte';
  import IntroSection from './IntroSection.svelte';
  import IntroTopic from './IntroTopic.svelte';
  import { t } from '../../i18n.ts';

  type Props = { ref?: HTMLElement };
  let { ref = $bindable() }: Props = $props();

  // A path's stages: a label, a line, the paragraph shown while it's active (the catalog's keys, written out for
  // i18n-check).
  const CPU = [
    ['intro:IntroHow.cpu.1', 'intro:IntroHow.cpu.1.line', 'intro:IntroHow.cpu.1.words'],
    ['intro:IntroHow.cpu.2', 'intro:IntroHow.cpu.2.line', 'intro:IntroHow.cpu.2.words'],
    ['intro:IntroHow.cpu.3', 'intro:IntroHow.cpu.3.line', 'intro:IntroHow.cpu.3.words'],
    ['intro:IntroHow.cpu.4', 'intro:IntroHow.cpu.4.line', 'intro:IntroHow.cpu.4.words'],
    ['intro:IntroHow.cpu.5', 'intro:IntroHow.cpu.5.line', 'intro:IntroHow.cpu.5.words'],
  ] as const;
  const MEMORY = [
    ['intro:IntroHow.memory.1', 'intro:IntroHow.memory.1.line', 'intro:IntroHow.memory.1.words'],
    ['intro:IntroHow.memory.2', 'intro:IntroHow.memory.2.line', 'intro:IntroHow.memory.2.words'],
    ['intro:IntroHow.memory.3', 'intro:IntroHow.memory.3.line', 'intro:IntroHow.memory.3.words'],
    ['intro:IntroHow.memory.4', 'intro:IntroHow.memory.4.line', 'intro:IntroHow.memory.4.words'],
    ['intro:IntroHow.memory.5', 'intro:IntroHow.memory.5.line', 'intro:IntroHow.memory.5.words'],
  ] as const;
  const GL = [
    ['intro:IntroHow.gl.1', 'intro:IntroHow.gl.1.line', 'intro:IntroHow.gl.1.words'],
    ['intro:IntroHow.gl.2', 'intro:IntroHow.gl.2.line', 'intro:IntroHow.gl.2.words'],
    ['intro:IntroHow.gl.3', 'intro:IntroHow.gl.3.line', 'intro:IntroHow.gl.3.words'],
    ['intro:IntroHow.gl.4', 'intro:IntroHow.gl.4.line', 'intro:IntroHow.gl.4.words'],
    ['intro:IntroHow.gl.5', 'intro:IntroHow.gl.5.line', 'intro:IntroHow.gl.5.words'],
  ] as const;
  const VIDEO = [
    ['intro:IntroHow.video.1', 'intro:IntroHow.video.1.line', 'intro:IntroHow.video.1.words'],
    ['intro:IntroHow.video.2', 'intro:IntroHow.video.2.line', 'intro:IntroHow.video.2.words'],
    ['intro:IntroHow.video.3', 'intro:IntroHow.video.3.line', 'intro:IntroHow.video.3.words'],
    ['intro:IntroHow.video.4', 'intro:IntroHow.video.4.line', 'intro:IntroHow.video.4.words'],
    ['intro:IntroHow.video.5', 'intro:IntroHow.video.5.line', 'intro:IntroHow.video.5.words'],
  ] as const;
  const VULKAN = [
    ['intro:IntroHow.vulkan.1', 'intro:IntroHow.vulkan.1.line', 'intro:IntroHow.vulkan.1.words'],
    ['intro:IntroHow.vulkan.2', 'intro:IntroHow.vulkan.2.line', 'intro:IntroHow.vulkan.2.words'],
    ['intro:IntroHow.vulkan.3', 'intro:IntroHow.vulkan.3.line', 'intro:IntroHow.vulkan.3.words'],
    ['intro:IntroHow.vulkan.4', 'intro:IntroHow.vulkan.4.line', 'intro:IntroHow.vulkan.4.words'],
    ['intro:IntroHow.vulkan.5', 'intro:IntroHow.vulkan.5.line', 'intro:IntroHow.vulkan.5.words'],
  ] as const;
  const stages = (keys: readonly (readonly [string, string, string])[]) =>
    keys.map(([label, line, words]) => ({ label: t(label), line: t(line), words: t(words) }));
</script>

<IntroSection id="intro-how" title={t('intro:IntroHow.title')} ground="raised" bind:ref>
  {#snippet lede()}{t('intro:IntroHow.lede')}{/snippet}
  <IntroTopic
    id="intro-how-cpu"
    title={t('intro:IntroHow.cpu')}
    words={t('intro:IntroHow.cpu.words')}
    deeper={t('intro:IntroHow.cpu.deeper')}
  >
    {#snippet picture()}<IntroPath name={t('intro:IntroHow.cpu.path')} stages={stages(CPU)} />{/snippet}
    {#snippet dive()}<IntroCpuDive />{/snippet}
  </IntroTopic>
  <IntroTopic
    id="intro-how-memory"
    title={t('intro:IntroHow.memory')}
    words={t('intro:IntroHow.memory.words')}
    deeper={t('intro:IntroHow.memory.deeper')}
  >
    {#snippet picture()}<IntroPath name={t('intro:IntroHow.memory.path')} stages={stages(MEMORY)} />{/snippet}
    {#snippet dive()}<IntroRam />{/snippet}
  </IntroTopic>
  <IntroTopic id="intro-how-gl" title={t('intro:IntroHow.gl')} words={t('intro:IntroHow.gl.words')}>
    {#snippet picture()}<IntroPath name={t('intro:IntroHow.gl.path')} stages={stages(GL)} />{/snippet}
  </IntroTopic>
  <IntroTopic id="intro-how-video" title={t('intro:IntroHow.video')} words={t('intro:IntroHow.video.words')}>
    {#snippet picture()}<IntroPath name={t('intro:IntroHow.video.path')} stages={stages(VIDEO)} />{/snippet}
  </IntroTopic>
  <IntroTopic id="intro-how-vulkan" title={t('intro:IntroHow.vulkan')} words={t('intro:IntroHow.vulkan.words')}>
    {#snippet picture()}<IntroPath name={t('intro:IntroHow.vulkan.path')} stages={stages(VULKAN)} />{/snippet}
  </IntroTopic>
</IntroSection>
