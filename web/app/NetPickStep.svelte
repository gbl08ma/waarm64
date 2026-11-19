<!--
  The Network wizard's first step when attaching and the browser has connections (NetWizard.svelte): one of them (the
  one attached, else the one `preselect` picks), each with its kind and who holds it, or New connection…. A double
  click attaches at once. Each connection's Edit… (ConnectionEditButton.svelte, as on the Connections pane) opens its
  editor in the wizard's place; the editor's Save or Back comes back here (`flow.edit`).
-->
<script lang="ts">
  import type { Attachment } from 'svelte/attachments';
  import Choice from './ui/Choice.svelte';
  import ConnectionEditButton from './ConnectionEditButton.svelte';
  import Note from './ui/Note.svelte';
  import Step from './ui/Step.svelte';
  import T from './T.svelte';
  import { msg, t, type Msg } from '../i18n.ts';
  import { preselect, type Connection } from './connections.ts';
  import type { Flow } from './net-wizard.ts';
  import type { PageNetwork } from './net-live.ts';
  import { isPrivateRoom, parseRoomLink } from '../room.ts';
  import { current } from './areas/current.svelte.ts';
  import { page } from './page.ts';

  type Props = { flow: Flow; net: PageNetwork; active: boolean; onsubmit: () => void };
  let { flow, net, active, onsubmit }: Props = $props();

  const conns = $derived(net.connections);
  let picked = $state<string>();
  /** Who holds the connections another tab has (their machine's name, as it says). */
  let holders = $state<Record<string, string>>({});
  /** The choices' buttons, for the focus: New connection… under `''`. */
  const buttons: Record<string, HTMLElement | undefined> = {};
  const keep =
    (id: string): Attachment<HTMLElement> =>
    (el) => {
      buttons[id] = el;
      return () => {
        if (buttons[id] === el) buttons[id] = undefined;
      };
    };

  const KINDS: Record<Connection['kind'], (c: Connection) => Msg> = {
    tailnet: (c) => msg('network:NetPickStep.kind.tailnet', { host: new URL(c.tailnet?.controlURL ?? '').host }),
    local: () => msg('network:NetPickStep.kind.local'),
    demo: () => msg('network:NetPickStep.kind.demo'),
    room: (c) => {
      const l = parseRoomLink(c.room?.link ?? '');
      return 'room' in l && isPrivateRoom(l.room.id)
        ? msg('network:NetPickStep.kind.roomPrivate')
        : msg('network:NetPickStep.kind.roomPublic');
    },
    tailcat: (c) =>
      c.tailcat?.exit ? msg('network:NetPickStep.kind.tailcatExit') : msg('network:NetPickStep.kind.tailcatServe'),
  };
  /** A connection's line under its name: its kind, and the machine that has it, if one does. */
  function lineOf(c: Connection): Msg {
    const k = KINDS[c.kind](c);
    const kind = c.ephemeral ? msg('network:NetPickStep.kind.ephemeral', { kind: k }) : k;
    if (!net.held.has(c.id)) return kind;
    const holder = holders[c.id];
    return holder
      ? msg('network:NetPickStep.kind.held', { kind, holder })
      : msg('network:NetPickStep.kind.heldElsewhere', { kind });
  }

  /** A connection is chosen: the dialog's Attach shows. */
  export const chosen = () => picked !== undefined;

  export function begin() {
    const o = flow.opened;
    const attached = o.machine === current.id ? net.views()[o.adapter ?? 0]?.connection?.id : undefined;
    picked = attached ?? preselect(conns, (id) => net.held.has(id));
    holders = {};
    if (o.mode !== 'attach') return;
    for (const id of net.held)
      void page.netHolder(id).then((name) => {
        if (name) holders = { ...holders, [id]: name };
      });
  }
  export function enter() {
    queueMicrotask(() => buttons[picked ?? '']?.focus());
  }
  export async function save() {
    const c = conns.find((x) => x.id === picked);
    if (!c) return flow.fail(msg('network:NetPickStep.choose'));
    await flow.made(c);
  }
</script>

<Step id="net-step-pick" {active}>
  <Note size="md">{t('network:NetPickStep.pick.note')}</Note>
  <Choice
    id="net-pick-new"
    label={t('network:NetPickStep.pick.new')}
    onclick={() => flow.go('kind')}
    {@attach keep('')}
  >
    {t('network:NetPickStep.pick.new.note')}
  </Choice>
  {#each conns as c (c.id)}
    <Choice
      id={`net-pick-${c.id}`}
      label={c.name}
      data-connection={c.id}
      pressed={picked === c.id}
      onclick={() => (picked = c.id)}
      ondblclick={() => {
        picked = c.id;
        onsubmit();
      }}
      {@attach keep(c.id)}
    >
      <T m={lineOf(c)} />
      {#snippet after()}
        <ConnectionEditButton
          connection={c}
          id={`net-pick-edit-${c.id}`}
          onclick={() => {
            picked = c.id;
            flow.edit(c);
          }}
        />
      {/snippet}
    </Choice>
  {/each}
</Step>
