<!--
  The Network wizard (docs/networking/adapters.md §3.2), a dialog opened by web/app/areas/network.ts `openWizard`: attach a connection
  to a machine's adapter (one of the browser's, or a new one: New connection… first), make a new connection on its own,
  or edit one (what changes without a new node: a tailnet's hostname, tailcat's server and relay, a room's switches).
  The shell: the session, the steps' navigation, Keep (a new connection is kept in this browser unless it's off:
  ephemeral, gone when the page closes), the error and the submit; each step is a component with its own form
  (NetPickStep, NetKindStep, NetTailnetStep, NetTailcatStep, NetLocalStep, NetRoomPickStep, NetRoomStep;
  web/app/net-wizard.ts). The toolbar's Network menu and the Home page's Network tab and Connections open it; the
  page (web/app/areas/network-actions.ts) attaches and connects.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Check from './ui/Check.svelte';
  import Modal from './ui/Modal.svelte';
  import Note from './ui/Note.svelte';
  import NetKindStep from './NetKindStep.svelte';
  import NetLocalStep from './NetLocalStep.svelte';
  import NetPickStep from './NetPickStep.svelte';
  import NetRoomPickStep from './NetRoomPickStep.svelte';
  import NetRoomStep from './NetRoomStep.svelte';
  import NetTailcatStep from './NetTailcatStep.svelte';
  import NetTailnetStep from './NetTailnetStep.svelte';
  import { Actions } from './actions.svelte.ts';
  import type { Connection } from './connections.ts';
  import { t } from '../i18n.ts';
  import type { PageNetwork } from './net-live.ts';
  import { EDIT_STEP, MAKING_STEPS, type Flow, type Opened, type Step, type StepApi } from './net-wizard.ts';
  import { network } from './areas/network.ts';
  import { page } from './page.ts';

  type Props = { net: PageNetwork };
  let { net }: Props = $props();

  /** The dialog (Modal.svelte's exports). */
  let wizard = $state<{ open: () => void; close: () => void }>();
  let opened = $state<Opened>({ mode: 'new' });
  let step = $state<Step>('kind');
  let keep = $state(true);
  let editing = $state.raw<Connection>(); // raw: the record goes to the store whole (a deep proxy can't be cloned)
  const runner = new Actions();
  const pickable = $derived(opened.mode === 'attach' && net.connections.length > 0);
  const here = $derived(opened.mode === 'attach' && !!opened.here);

  // The steps (their components' exports).
  let pick = $state<StepApi & { chosen: () => boolean }>();
  let kind = $state<StepApi>();
  let tailnet = $state<StepApi>();
  let tailcat = $state<StepApi>();
  let local = $state<StepApi>();
  let roomPick = $state<StepApi>();
  let room = $state<StepApi>();
  const steps = $derived<Record<Step, StepApi | undefined>>({
    pick,
    kind,
    tailscale: tailnet,
    tailcat,
    local,
    roomPick,
    roomGlobal: room,
    roomCreate: room,
    roomJoin: room,
    roomEdit: room,
  });
  const api = (s: Step) => steps[s];

  const flow: Flow = {
    get opened() {
      return opened;
    },
    get editing() {
      return editing;
    },
    get keep() {
      return keep;
    },
    get here() {
      return here;
    },
    made: (c, key) => (opened.mode === 'attach' ? attach(c, key) : Promise.resolve(close())),
    edited: async (c) => {
      await page.netEdit(c);
      close();
    },
    fail: (e) => runner.fail(e),
    go: (to) => show(to),
    forget: async () => {
      const now = editing && (await page.netNewAddress(editing));
      if (!now) return false;
      editing = now; // what Save writes back: the new key or identity, not the one the wizard opened with
      return true;
    },
  };

  $effect(() => network.wizard.handle(begin));

  function begin(o: Opened) {
    opened = o;
    keep = true;
    editing = o.mode === 'edit' ? net.connections.find((c) => c.id === o.connection) : undefined;
    for (const s of [pick, kind, tailnet, tailcat, local, roomPick, room]) s?.begin();
    wizard?.open();
    if (editing) show(EDIT_STEP[editing.kind]);
    else if (o.localURL)
      show('local'); // the helper's pairing link opened the page
    else show(pickable ? 'pick' : 'kind');
  }

  function show(to: Step) {
    step = to;
    runner.clear();
    api(to)?.enter();
  }
  function goBack() {
    if (step === 'kind') show('pick');
    else if (step === 'roomGlobal' || step === 'roomCreate' || step === 'roomJoin') show('roomPick');
    else show('kind');
  }
  function close() {
    wizard?.close();
  }

  /** Attaches `c` (and connects it, on the page's machine); the menu then shows how it goes. */
  async function attach(c: Connection, key?: string) {
    await page.netAttach(opened.machine, opened.adapter ?? 0, c, key);
    close();
    if (here) network.openMenu(opened.adapter ?? 0);
  }

  function submit(e?: SubmitEvent) {
    e?.preventDefault();
    const save = api(step)?.save;
    if (runner.busy !== undefined || !save) return;
    void runner.run('', save);
  }

  const TITLES: Record<Step, () => string> = {
    pick: () => t('network:NetWizard.title.pick', { adapter: (opened.adapter ?? 0) + 1 }),
    kind: () => t('network:NetWizard.title.kind'),
    tailscale: () => t('network:NetWizard.title.tailnet'),
    local: () => t('network:NetWizard.title.local'),
    roomPick: () => t('network:NetWizard.title.room'),
    roomGlobal: () => t('network:NetWizard.title.roomGlobal'),
    roomCreate: () => t('network:NetWizard.title.roomCreate'),
    roomJoin: () => t('network:NetWizard.title.roomJoin'),
    roomEdit: () => t('network:NetWizard.title.tailcat'),
    tailcat: () => t('network:NetWizard.title.tailcat'),
  };
  const title = $derived(editing ? t('network:NetWizard.title.edit', { name: editing.name }) : TITLES[step]());
  function submitLabelOf() {
    if (editing) return t('network:NetWizard.save');
    if (opened.mode === 'new') return t('network:NetWizard.create');
    return here ? t('network:NetWizard.connect') : t('network:NetWizard.attach');
  }
  const submitLabel = $derived(submitLabelOf());
  /** The steps that only choose have no Save; the pick step's shows once a connection is chosen. */
  const noSubmit = $derived(step === 'kind' || step === 'roomPick' || (step === 'pick' && !pick?.chosen()));
  const noBack = $derived(!!editing || step === 'pick' || (step === 'kind' && !pickable));
</script>

<Modal id="net-wizard" bodyId="net-form" bind:this={wizard} {title} auto={false} onsubmit={submit}>
  <NetPickStep bind:this={pick} {flow} {net} active={step === 'pick'} onsubmit={() => submit()} />
  <NetKindStep bind:this={kind} {flow} active={step === 'kind'} />
  <NetRoomPickStep bind:this={roomPick} {flow} active={step === 'roomPick'} />
  <NetRoomStep bind:this={room} {flow} {net} {step} />
  <NetLocalStep bind:this={local} {flow} active={step === 'local'} />
  <NetTailnetStep bind:this={tailnet} {flow} active={step === 'tailscale'} />
  <NetTailcatStep bind:this={tailcat} {flow} active={step === 'tailcat'} />
  {#if !editing && MAKING_STEPS.has(step)}
    <Check id="net-keep" bind:checked={keep}>
      {t('network:NetWizard.keep')}
      {#snippet note()}
        <span id="net-keep-note">{keep ? t('network:NetWizard.keep.note') : t('network:NetWizard.keep.ephemeral')}</span
        >
      {/snippet}
    </Check>
  {/if}
  <Note tone="error" size="md" id="net-error" class="error" hidden={!runner.error}>{runner.error?.text}</Note>
  {#snippet back()}
    <Button type="button" id="net-back" hidden={noBack} onclick={goBack}>{t('network:NetWizard.back')}</Button>
  {/snippet}
  {#snippet buttons()}
    <Button type="button" id="net-cancel" onclick={close}>{t('network:NetWizard.cancel')}</Button>
    <Button id="net-connect" variant="primary" type="submit" disabled={runner.busy !== undefined} hidden={noSubmit}>
      {submitLabel}
    </Button>
  {/snippet}
</Modal>
