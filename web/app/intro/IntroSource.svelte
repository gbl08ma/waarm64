<!--
  The introduction's way to the source (web/app/intro/IntroHow.svelte, under its last topic): a plate with the
  repository's name as a command that fetches it, a sentence on what is there and under which license, and the link
  to it on GitHub, which asks for a star. The page's last lines have the plain link again (IntroEnd.svelte).
-->
<script lang="ts">
  import about from 'virtual:waarm64-about';
  import Icon from '../ui/Icon.svelte';
  import { t } from '../../i18n.ts';

  const repo = about.repository.replace(/\.git$/, '');
  /** The repository as GitHub names it: its owner and its name. */
  const name = new URL(repo).pathname.slice(1);
  /** A link to another site: opened apart from the page, and told nothing of it. */
  const EXTERNAL = { target: '_blank', rel: 'external noopener noreferrer' };
</script>

<aside aria-labelledby="intro-source" data-intro-source>
  <div class="mark"><Icon name="brand-github" size={44} /></div>
  <div class="words">
    <h3 id="intro-source">{t('intro:IntroSource.title')}</h3>
    <p>{t('intro:IntroSource.words')}</p>
    <code data-field="clone"><span class="prompt" aria-hidden="true">$</span> git clone {repo}</code>
  </div>
  <a class="star" href={repo} {...EXTERNAL} data-action="intro-star">
    <span class="glyph"><Icon name="star" size={18} /></span>
    <span class="label">{t('intro:IntroSource.star')}</span>
    <span class="repo">{name}</span>
  </a>
</aside>

<style>
  aside {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-5) var(--space-6);
    padding: var(--space-6);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--lit-plate);
    box-shadow: var(--card-edge);
  }
  .mark {
    color: var(--text);
  }
  .words {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }
  h3 {
    margin: 0;
    font-size: var(--text-lede);
  }
  p {
    margin: 0;
    max-width: 640px;
    color: var(--text-dim);
    font-size: var(--text-lg);
  }
  code {
    overflow-wrap: anywhere;
    color: var(--text-dim);
  }
  .prompt {
    color: var(--accent);
    user-select: none;
  }
  /* The link, drawn as the page's main button with the repository's name under its words. */
  .star {
    display: grid;
    grid-template-columns: auto auto;
    align-items: center;
    gap: 0 var(--space-3);
    padding: var(--space-3) var(--space-5);
    border: 1px solid var(--primary-border);
    border-radius: var(--radius);
    color: var(--primary-fg);
    background: var(--primary-bg);
    box-shadow: var(--primary-edge), var(--lit-button);
    text-decoration: none;
  }
  .star:hover {
    filter: brightness(1.15);
  }
  .glyph {
    grid-row: span 2;
    transition: transform 0.2s;
  }
  .star:hover .glyph {
    transform: rotate(72deg) scale(1.15);
  }
  .label {
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
  }
  .repo {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    opacity: 0.8;
  }
  @media (prefers-reduced-motion: reduce) {
    .glyph {
      transition: none;
    }
  }
  @media (max-width: 900px) {
    aside {
      grid-template-columns: auto minmax(0, 1fr);
      padding: var(--space-5);
    }
    .star {
      grid-column: 1 / -1;
      justify-content: center;
    }
  }
</style>
