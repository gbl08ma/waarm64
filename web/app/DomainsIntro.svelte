<!--
  The Domains pane's first explainer (DomainsPane.svelte; docs/networking/names.md "What the user sees"), in the cards'
  place while a room connection has no domains, always open: what a domain is (with the connection's own name in the
  room, `member`, the names agent's), what registering involves (three numbered steps), and what to know before. The
  pane puts a second Register a domain… under it.
-->
<script lang="ts">
  import Steps from './ui/Steps.svelte';
  import T from './T.svelte';

  type Props = { member: string };
  let { member }: Props = $props();
</script>

<div class="explainer" id="domains-intro">
  <h4><T k="network:DomainsIntro.title" /></h4>
  <p class="member"><T k="network:DomainsIntro.what" params={{ member }} /></p>
  <p><T k="network:DomainsIntro.free" /></p>
  <h4><T k="network:DomainsIntro.steps" /></h4>
  <Steps>
    <li><T k="network:DomainsIntro.step.choose" /></li>
    <li><T k="network:DomainsIntro.step.wait" /></li>
    <li><T k="network:DomainsIntro.step.reopen" /></li>
  </Steps>
  <h4><T k="network:DomainsIntro.before" /></h4>
  <ul>
    <li><T k="network:DomainsIntro.before.reach" /></li>
    <li><T k="network:DomainsIntro.before.serve" /></li>
    <li><T k="network:DomainsIntro.before.copy" /></li>
    <li><T k="network:DomainsIntro.before.services" /></li>
    <li><T k="network:DomainsIntro.before.earlier" /></li>
  </ul>
</div>

<style>
  .explainer {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 46em;
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
  /* The member's name is one long word. */
  .member {
    overflow-wrap: anywhere;
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding-left: var(--space-6);
  }
</style>
