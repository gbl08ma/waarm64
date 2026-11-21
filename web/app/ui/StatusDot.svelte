<!--
  A state's light: a small dot in the tone of what it says (`ok`: on, connected; `busy`: on its way; `warn`: needs
  attention soon; `bad`: failed; `off`). The network menu's, an adapter's, the clipboard menu's, a domain's card. `class` and other attributes go on the dot.
-->
<script lang="ts">
  type Props = { tone: 'ok' | 'busy' | 'warn' | 'bad' | 'off'; class?: string; [attr: string]: unknown };
  let { tone, class: cls, ...rest }: Props = $props();
</script>

<span class={['dot', tone, cls]} {...rest}></span>

<style>
  .dot {
    flex: none;
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--status-off);
  }
  .ok {
    background: var(--status-ok);
  }
  .busy {
    background: var(--status-busy);
  }
  .warn {
    background: var(--status-warn);
  }
  .bad {
    background: var(--status-bad);
  }
</style>
