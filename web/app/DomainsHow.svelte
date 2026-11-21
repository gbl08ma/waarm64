<!--
  The Domains pane's second explainer (DomainsPane.svelte; docs/networking/names.md "What the user sees"), once a room
  connection has domains: folded under How domains work, collapsed. Keeping them, what the states mean, how long a change takes to reach the members, who can see
  them, where they are kept.
-->
<script lang="ts">
  import Disclosure from './ui/Disclosure.svelte';
  import T from './T.svelte';
  import { t } from '../i18n.ts';
</script>

<Disclosure summary={t('network:DomainsHow.summary')} plain id="domains-how">
  <div class="explainer">
    <h4><T k="network:DomainsHow.keep.title" /></h4>
    <p><T k="network:DomainsHow.keep" /></p>
    <h4><T k="network:DomainsHow.states.title" /></h4>
    <ul>
      <li><T k="network:DomainsHow.states.preparing" /></li>
      <li><T k="network:DomainsHow.states.reserved" /></li>
      <li><T k="network:DomainsHow.states.active" /></li>
      <li><T k="network:DomainsHow.states.grace" /></li>
      <li><T k="network:DomainsHow.states.ended" /></li>
    </ul>
    <h4><T k="network:DomainsHow.changes.title" /></h4>
    <p><T k="network:DomainsHow.changes" /></p>
    <h4><T k="network:DomainsHow.who.title" /></h4>
    <p><T k="network:DomainsHow.who" /></p>
    <h4><T k="network:DomainsHow.where.title" /></h4>
    <p><T k="network:DomainsHow.where" /></p>
  </div>
</Disclosure>

<style>
  .explainer {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 46em;
    padding-top: var(--space-3);
  }
  h4 {
    margin: var(--space-3) 0 0;
    font-size: var(--text-base);
    font-weight: var(--weight-bold);
  }
  h4:first-child {
    margin-top: 0;
  }
  p {
    margin: 0;
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding-left: var(--space-6);
  }
</style>
