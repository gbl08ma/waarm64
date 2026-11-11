<!--
  The Network wizard (docs/network-adapters.md §3.2), a dialog opened through `ui.netWizard`: attach a connection
  to a machine's adapter (one of the browser's, or a new one: New connection… first), make a new connection on its own,
  or edit one (what changes without a new node: a tailnet's hostname, tailcat's server and relay, a room's switches). A
  room is created (a name, private or public, its relays under Advanced: web/room.ts builds the link) or joined (a link,
  or a public room's name), with a key of its own or another room connection's. A new connection is
  kept in this browser unless Keep is off (ephemeral: gone when the page closes). The toolbar's Network menu and the
  Machines page's Network tab and Connections open it; the page (web/app/main.ts) attaches and connects.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Button from './ui/Button.svelte';
  import Choice from './ui/Choice.svelte';
  import Field from './ui/Field.svelte';
  import Modal from './ui/Modal.svelte';
  import Note from './ui/Note.svelte';
  import Check from './ui/Check.svelte';
  import T from './T.svelte';
  import { describe, msg, t, text, type Described, type Msg } from '../i18n.ts';
  import { preselect, type Connection } from './connections.ts';
  import type { PageNetwork } from './net-live.ts';
  import {
    DEFAULT_CONTROL,
    hasTailcatIdentity,
    parseAllow,
    parseControlURL,
    parseHostname,
    parseRelay,
    parseTailcatAddr,
    tailcatBuilt,
    tailscaleBuilt,
  } from './network.ts';
  import { page, ui } from './ui.svelte.ts';
  import { parseLocalURL } from '../local-net.ts';
  import { hasRoomIdentity, isPrivateRoom, parseRoomLink, privateRoomId, roomLink, type RoomLink } from '../room.ts';
  import { installLines, RELEASE, SOURCE, targetName, TARGETS, thisTarget, type Target } from '../local-release.ts';

  let { net }: { net: PageNetwork } = $props();

  /** What the room's note on one's IP address links to: DERP, Nostr and STUN explained. */
  const DERP_DOC = 'https://tailscale.com/kb/1232/derp-servers';
  const NOSTR_DOC = 'https://github.com/nostr-protocol/nips/blob/master/01.md';
  const STUN_DOC = 'https://en.wikipedia.org/wiki/STUN';
  type Step = 'pick' | 'kind' | 'tailscale' | 'tailcat' | 'local' | 'roomPick' | 'roomCreate' | 'roomJoin' | 'roomEdit';
  const roomStep = (s: Step) => s === 'roomCreate' || s === 'roomJoin' || s === 'roomEdit';
  let wizard: Modal;
  let w = $state<NonNullable<typeof ui.netWizard>>({ mode: 'new' });
  let step = $state<Step>('kind');
  let formError = $state<Described>();
  let working = $state(false);
  const conns = $derived((void ui.net, net.connections));
  let picked = $state<string>();
  let holders = $state<Record<string, string>>({});
  let editing = $state.raw<Connection>(); // raw: the record goes to the store whole (a deep proxy can't be cloned)
  let control = $state(''),
    hostname = $state(''),
    authKey = $state(''),
    reveal = $state(false);
  let tcExit = $state(true),
    tcServe = $state(false),
    tailcat = $state(''),
    relay = $state(''),
    allow = $state('');
  let advanced = $state(false),
    identityKept = $state(false);
  let keep = $state(true);
  let localURL = $state(''),
    target = $state<Target>();
  let roomId = $state(''),
    roomPrivate = $state(true),
    roomJoin = $state(''),
    nostr = $state(''),
    derp = $state('');
  let incoming = $state(true),
    relayOnly = $state(false),
    keyOf = $state(''),
    roomAdvanced = $state(false),
    roomKept = $state(false);
  /** The room connections whose key a new one may share: the stored ones (an ephemeral one's key is gone with its tab). */
  const keys = $derived(conns.filter((c) => c.kind === 'room' && !c.ephemeral));
  void thisTarget().then((t) => {
    target = t;
  });
  const pickable = $derived(w.mode === 'attach' && conns.length > 0);
  /** Whether what the wizard attaches connects now (the machine is the page's): an auth key is asked for then. */
  const here = $derived(w.mode === 'attach' && !!w.here);

  $effect(() => {
    const o = ui.netWizard;
    if (!o) return;
    void o.tick;
    untrack(() => void begin(o));
  });

  const kindMsg = (c: Connection): Msg => {
    const kind =
      c.kind === 'tailnet'
        ? msg('network:NetWizard.kind.tailnet', { host: new URL(c.tailnet!.controlURL).host })
        : c.kind === 'local'
          ? msg('network:NetWizard.kind.local')
          : c.kind === 'room'
            ? roomKindMsg(c)
            : c.tailcat?.exit
              ? msg('network:NetWizard.kind.tailcatExit')
              : msg('network:NetWizard.kind.tailcatServe');
    return c.ephemeral ? msg('network:NetWizard.kind.ephemeral', { kind }) : kind;
  };
  const roomKindMsg = (c: Connection): Msg => {
    const l = parseRoomLink(c.room?.link ?? '');
    return 'room' in l && isPrivateRoom(l.room.id)
      ? msg('network:NetWizard.kind.roomPrivate')
      : msg('network:NetWizard.kind.roomPublic');
  };
  /** A connection's line under its name: its kind, and the machine that has it, if one does. */
  const kindText = (c: Connection) => {
    const kind = kindMsg(c);
    if (!net.held.has(c.id)) return text(kind);
    const holder = holders[c.id];
    return holder
      ? t('network:NetWizard.kind.held', { kind, holder })
      : t('network:NetWizard.kind.heldElsewhere', { kind });
  };
  /** An error the form shows (a message, or an error with its details). */
  const fail = (e: Msg | unknown) => void (formError = describe(e));

  async function begin(o: NonNullable<typeof ui.netWizard>) {
    w = o;
    formError = undefined;
    authKey = '';
    reveal = false;
    keep = true;
    editing = o.mode === 'edit' ? conns.find((c) => c.id === o.connection) : undefined;
    const t = editing?.tailnet,
      cat = editing?.tailcat;
    control = t && t.controlURL !== DEFAULT_CONTROL ? t.controlURL : '';
    hostname = t?.hostname ?? '';
    tcExit = cat ? !!cat.exit : true;
    tcServe = cat?.serve ?? false;
    tailcat = cat?.exit ?? '';
    relay = cat?.relay ?? '';
    allow = (cat?.allow ?? []).join('\n');
    advanced = !!relay || !!allow;
    localURL = editing?.local?.url ?? o.localURL ?? '';
    const r = editing?.room;
    [roomId, roomPrivate, roomJoin, nostr, derp, keyOf, roomAdvanced] = ['', true, '', '', '', '', false];
    incoming = r?.incoming ?? true;
    relayOnly = r?.relayOnly ?? false;
    wizard.open();
    if (editing)
      return showStep(
        editing.kind === 'tailnet'
          ? 'tailscale'
          : editing.kind === 'local'
            ? 'local'
            : editing.kind === 'room'
              ? 'roomEdit'
              : 'tailcat',
      );
    if (o.localURL) return showStep('local'); // the helper's pairing link opened the page
    if (!pickable) return showStep('kind');
    const attached = o.machine === ui.current ? net.views()[o.adapter ?? 0]?.connection?.id : undefined;
    picked = attached ?? preselect(conns, (id) => net.held.has(id));
    holders = {};
    showStep('pick');
    for (const id of net.held)
      void page.netHolder(id).then((name) => {
        if (name) holders = { ...holders, [id]: name };
      });
  }

  function showStep(to: Step) {
    step = to;
    formError = undefined;
    if (to === 'tailcat') {
      const cat = editing?.tailcat;
      if (!cat) identityKept = false;
      else if (cat.identity) identityKept = true;
      else
        void hasTailcatIdentity(cat.identityKey).then((kept) => {
          identityKept = kept;
        });
    }
    if (to === 'roomEdit') {
      const r = editing?.room;
      if (r?.identity) roomKept = true;
      else if (r)
        void hasRoomIdentity(r.identityKey).then((kept) => {
          roomKept = kept;
        });
    }
    queueMicrotask(() =>
      document
        .getElementById(
          to === 'pick'
            ? picked
              ? `net-pick-${picked}`
              : 'net-pick-new'
            : to === 'kind'
              ? 'net-pick-tailnet'
              : to === 'tailscale'
                ? editing
                  ? 'net-hostname'
                  : 'net-control'
                : to === 'local'
                  ? 'net-local-url'
                  : to === 'roomPick'
                    ? 'net-room-create'
                    : to === 'roomCreate'
                      ? 'net-room-id'
                      : to === 'roomJoin'
                        ? 'net-room-link'
                        : to === 'roomEdit'
                          ? 'net-room-direct'
                          : 'net-tc-exit',
        )
        ?.focus(),
    );
  }
  const goBack = () =>
    showStep(step === 'kind' ? 'pick' : step === 'roomCreate' || step === 'roomJoin' ? 'roomPick' : 'kind');
  const close = () => {
    wizard.close();
    ui.netWizard = undefined;
  };

  /** Attaches `c` (and connects it, on the page's machine); the menu then shows how it goes. */
  async function attach(c: Connection, key?: string) {
    await page.netAttach(w.machine, w.adapter ?? 0, c, key);
    close();
    if (here) ui.netMenu++;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (working) return;
    working = true;
    try {
      await save();
    } catch (err) {
      fail(err);
    } finally {
      working = false;
    }
  }

  /** The relays as typed: one per line (or separated by spaces or commas). */
  const lines = (s: string) => s.split(/[\s,]+/).filter((x) => x);

  async function saveRoom() {
    if (step === 'roomEdit' && editing?.room) {
      await page.netEdit({ ...editing, room: { ...editing.room, incoming, relayOnly } });
      return close();
    }
    let link: { link: string; room?: RoomLink } | { error: Msg };
    if (step === 'roomCreate') {
      const name = roomId.trim();
      if (!name) return fail(msg('network:NetWizard.room.noName'));
      link = roomLink({ id: roomPrivate ? privateRoomId(name) : name, nostr: lines(nostr), derp: lines(derp) });
    } else link = parseRoomLink(roomJoin);
    if ('error' in link) return fail(link.error);
    formError = undefined;
    if (!(await tailcatBuilt())) return fail(msg('network:NetWizard.tailcatNotBuilt'));
    const c = await page.netCreate({
      kind: 'room',
      ephemeral: !keep,
      room: { link: link.link, incoming, relayOnly, ...(keyOf ? { keyOf } : {}) },
    });
    return w.mode === 'attach' ? attach(c) : close();
  }

  async function save() {
    if (roomStep(step)) return saveRoom();
    if (step === 'local') {
      const u = parseLocalURL(localURL);
      if ('error' in u) return fail(u.error);
      formError = undefined;
      if (editing) {
        await page.netEdit({ ...editing, local: { url: u.url } });
        return close();
      }
      const c = await page.netCreate({ kind: 'local', ephemeral: !keep, local: { url: u.url } });
      return w.mode === 'attach' ? attach(c) : close();
    }
    if (step === 'pick') {
      const c = conns.find((x) => x.id === picked);
      if (!c) return fail(msg('network:NetWizard.choose'));
      return attach(c);
    }
    if (step === 'tailcat') {
      if (!tcExit && !tcServe) return fail(msg('network:NetWizard.chooseTailcat'));
      const addr = tcExit ? parseTailcatAddr(tailcat) : { addr: '' };
      if ('error' in addr) return fail(addr.error);
      const r = tcServe && !tcExit ? parseRelay(relay) : { relay: relay.trim() };
      if ('error' in r) return fail(r.error);
      const letIn = tcServe ? parseAllow(allow) : { allow: [] };
      if ('error' in letIn) return fail(letIn.error);
      formError = undefined;
      if (!(await tailcatBuilt())) return fail(msg('network:NetWizard.tailcatNotBuilt'));
      const settings = {
        exit: addr.addr || undefined,
        serve: tcServe,
        relay: r.relay,
        allow: letIn.allow.length ? letIn.allow : undefined,
      };
      if (editing) {
        await page.netEdit({ ...editing, tailcat: { ...editing.tailcat!, ...settings } });
        return close();
      }
      const c = await page.netCreate({ kind: 'tailcat', ephemeral: !keep, tailcat: settings });
      return w.mode === 'attach' ? attach(c) : close();
    }
    const url = parseControlURL(control);
    const host = parseHostname(hostname);
    if ('error' in url) return fail(url.error);
    if ('error' in host) return fail(host.error);
    formError = undefined;
    const key = authKey.trim();
    if (!(await tailscaleBuilt())) return fail(msg('network:NetWizard.tailscaleNotBuilt'));
    if (editing) {
      await page.netEdit({ ...editing, tailnet: { ...editing.tailnet!, hostname: host.hostname } });
      return close();
    }
    const c = await page.netCreate({
      kind: 'tailnet',
      ephemeral: !keep,
      tailnet: { controlURL: url.url, hostname: host.hostname, exitNode: '' },
    });
    authKey = '';
    return w.mode === 'attach' ? attach(c, key || undefined) : close();
  }

  async function forget() {
    const now = editing && (await page.netNewAddress(editing));
    if (!now) return;
    editing = now; // what Save writes back: the new key or identity, not the one the wizard opened with
    identityKept = false;
    roomKept = false;
  }

  const title = $derived(
    editing
      ? t('network:NetWizard.title.edit', { name: editing.name })
      : step === 'pick'
        ? t('network:NetWizard.title.pick', { adapter: (w.adapter ?? 0) + 1 })
        : step === 'kind'
          ? t('network:NetWizard.title.kind')
          : step === 'tailscale'
            ? t('network:NetWizard.title.tailnet')
            : step === 'local'
              ? t('network:NetWizard.title.local')
              : step === 'roomCreate'
                ? t('network:NetWizard.title.roomCreate')
                : step === 'roomJoin'
                  ? t('network:NetWizard.title.roomJoin')
                  : step === 'roomPick'
                    ? t('network:NetWizard.title.room')
                    : t('network:NetWizard.title.tailcat'),
  );
  /** The install lines shown first: this browser's platform's, else Linux x86-64's. */
  const shown = $derived(target ?? TARGETS[0]);
  const submitLabel = $derived(
    editing
      ? t('network:NetWizard.save')
      : w.mode === 'new'
        ? t('network:NetWizard.create')
        : here
          ? t('network:NetWizard.connect')
          : t('network:NetWizard.attach'),
  );
</script>

<Modal
  id="net-wizard"
  bodyId="net-form"
  bind:this={wizard}
  {title}
  auto={false}
  onclose={() => {
    ui.netWizard = undefined;
  }}
  onsubmit={submit}
>
  <section id="net-step-pick" class="step" hidden={step !== 'pick'}>
    <Note size="md">{t('network:NetWizard.pick.note')}</Note>
    <Choice id="net-pick-new" label={t('network:NetWizard.pick.new')} onclick={() => showStep('kind')}
      >{t('network:NetWizard.pick.new.note')}</Choice
    >
    {#each conns as c (c.id)}
      <Choice
        id={`net-pick-${c.id}`}
        label={c.name}
        data-connection={c.id}
        pressed={picked === c.id}
        onclick={() => (picked = c.id)}
        ondblclick={() => {
          picked = c.id;
          document.getElementById('net-connect')?.click();
        }}>{kindText(c)}</Choice
      >
    {/each}
  </section>
  <section id="net-step-kind" class="step" hidden={step !== 'kind'}>
    <Note size="md">{t('network:NetWizard.kind.note')}</Note>
    <Choice id="net-pick-tailnet" label={t('network:NetWizard.kind.pickTailnet')} onclick={() => showStep('tailscale')}
      >{t('network:NetWizard.kind.pickTailnet.note')}</Choice
    >
    <Choice id="net-pick-tailcat" label={t('network:NetWizard.kind.pickTailcat')} onclick={() => showStep('tailcat')}
      >{t('network:NetWizard.kind.pickTailcat.note')}</Choice
    >
    <Choice id="net-pick-local" label={t('network:NetWizard.kind.pickLocal')} onclick={() => showStep('local')}
      >{t('network:NetWizard.kind.pickLocal.note')}</Choice
    >
    <Choice id="net-pick-room" label={t('network:NetWizard.kind.pickRoom')} onclick={() => showStep('roomPick')}
      >{t('network:NetWizard.kind.pickRoom.note')}</Choice
    >
  </section>
  <section id="net-step-room-pick" class="step" hidden={step !== 'roomPick'}>
    <Choice id="net-room-create" label={t('network:NetWizard.room.create')} onclick={() => showStep('roomCreate')}
      >{t('network:NetWizard.room.create.note')}</Choice
    >
    <Choice id="net-room-join" label={t('network:NetWizard.room.join')} onclick={() => showStep('roomJoin')}
      >{t('network:NetWizard.room.join.note')}</Choice
    >
  </section>
  <section id="net-step-room" class="step" hidden={!roomStep(step)}>
    {#if step === 'roomCreate'}
      <Field label={t('network:NetWizard.room.name')}
        ><input id="net-room-id" bind:value={roomId} autocomplete="off" spellcheck="false" /></Field
      >
      <Check
        id="net-room-private"
        bind:checked={roomPrivate}
        note={roomPrivate ? t('network:NetWizard.room.private.note') : t('network:NetWizard.room.public.note')}
        >{t('network:NetWizard.room.private')}</Check
      >
    {:else if step === 'roomJoin'}
      <Field label={t('network:NetWizard.room.link')}
        ><input id="net-room-link" bind:value={roomJoin} type="password" autocomplete="off" spellcheck="false" /></Field
      >
      <Note size="md">{t('network:NetWizard.room.link.note')}</Note>
    {/if}
    {#snippet link(href: string, text: string)}<a {href} target="_blank" rel="noopener">{text}</a>{/snippet}
    {#snippet ipNote()}<span id="net-room-ip"
        >{#if relayOnly}<T k="network:NetWizard.room.ip.relayed"
            >{#snippet derp(text)}{@render link(DERP_DOC, text)}{/snippet}{#snippet nostr(text)}{@render link(
                NOSTR_DOC,
                text,
              )}{/snippet}</T
          >{:else}<T k="network:NetWizard.room.ip.direct"
            >{#snippet derp(text)}{@render link(DERP_DOC, text)}{/snippet}{#snippet nostr(text)}{@render link(
                NOSTR_DOC,
                text,
              )}{/snippet}{#snippet stun(text)}{@render link(STUN_DOC, text)}{/snippet}</T
          >{/if}</span
      >{/snippet}
    <Check id="net-room-direct" checked={!relayOnly} onchange={(on) => (relayOnly = !on)} note={ipNote}
      >{t('network:NetWizard.room.direct')}</Check
    >
    {#snippet incomingSwitch()}
      <Check
        id="net-room-incoming"
        bind:checked={incoming}
        note={incoming ? t('network:NetWizard.room.incoming.note') : t('network:NetWizard.room.incoming.off')}
        >{t('network:NetWizard.room.incoming')}</Check
      >
    {/snippet}
    {#if step !== 'roomEdit'}
      <details id="net-room-advanced" bind:open={roomAdvanced}>
        <summary>{t('network:NetWizard.advanced')}</summary>
        {@render incomingSwitch()}
        {#if step === 'roomCreate'}
          <Field label={t('network:NetWizard.room.nostr')}
            ><textarea
              id="net-room-nostr"
              bind:value={nostr}
              rows="2"
              placeholder={t('network:NetWizard.room.nostr.placeholder')}
              autocomplete="off"
              spellcheck="false"></textarea></Field
          >
          <Note size="md">{t('network:NetWizard.room.nostr.note')}</Note>
          <Field label={t('network:NetWizard.room.derp')}
            ><textarea
              id="net-room-derp"
              bind:value={derp}
              rows="2"
              placeholder={t('network:NetWizard.room.derp.placeholder')}
              autocomplete="off"
              spellcheck="false"></textarea></Field
          >
          <Note size="md">
            <T k="network:NetWizard.room.derp.note"
              >{#snippet a(text)}<a
                  href="https://github.com/tailscale/tailscale/tree/main/cmd/derper"
                  target="_blank"
                  rel="noopener">{text}</a
                >{/snippet}</T
            >
          </Note>
        {/if}
        <Field label={t('network:NetWizard.room.key')}
          ><select id="net-room-key" bind:value={keyOf}>
            <option value="">{t('network:NetWizard.room.key.new')}</option>
            {#each keys as k (k.id)}<option value={k.id}>{t('network:NetWizard.room.key.of', { name: k.name })}</option
              >{/each}
          </select></Field
        >
        <Note size="md">{t('network:NetWizard.room.key.note')}</Note>
      </details>
    {:else}
      <details id="net-room-advanced" bind:open={roomAdvanced}>
        <summary>{t('network:NetWizard.advanced')}</summary>
        {@render incomingSwitch()}
        <div class="row">
          <Button type="button" id="net-room-new-name" disabled={!roomKept} onclick={forget}
            >{t('network:NetWizard.room.newName')}</Button
          >
        </div>
        <Note size="md">{t('network:NetWizard.room.newName.note')}</Note>
      </details>
    {/if}
  </section>
  <section id="net-step-local" class="step" hidden={step !== 'local'}>
    {#snippet localField(label: string)}
      <Field {label}
        ><input
          id="net-local-url"
          bind:value={localURL}
          type="password"
          // i18n-ignore-next: an example of the link, not words
          placeholder="https://vm.tny.im/#net=ws://127.0.0.1:8740/…"
          autocomplete="off"
          spellcheck="false"
        /></Field
      >
    {/snippet}
    {#if editing}
      {@render localField(t('network:NetWizard.local.link'))}
    {:else}
      <ol class="steps">
        <li>
          <T k="network:NetWizard.local.run"
            >{#snippet a(text)}<a href={SOURCE} target="_blank" rel="noopener">{text}</a>{/snippet}</T
          >
          <details id="net-local-install" open={!localURL}>
            <summary>{t('network:NetWizard.install', { version: RELEASE.version })}</summary>
            <Field label={t('network:NetWizard.install.for')}
              ><select
                id="net-local-target"
                value={`${shown.os}-${shown.arch}`}
                onchange={(e) => {
                  target = TARGETS.find((t) => `${t.os}-${t.arch}` === e.currentTarget.value);
                }}
              >
                {#each TARGETS as t (`${t.os}-${t.arch}`)}<option value={`${t.os}-${t.arch}`}>{targetName(t)}</option
                  >{/each}
              </select></Field
            >
            <Note size="md">
              {shown.os === 'windows'
                ? t('network:NetWizard.install.note.windows')
                : t('network:NetWizard.install.note')}
            </Note>
            <pre id="net-local-lines">{installLines(RELEASE, shown)}</pre>
          </details>
        </li>
        <li>{@render localField(t('network:NetWizard.local.paste'))}</li>
      </ol>
    {/if}
    <Note size="md">{t('network:NetWizard.local.note')}</Note>
  </section>
  <section id="net-step-tailnet" class="step" hidden={step !== 'tailscale'}>
    <Field label={t('network:NetWizard.control')}
      ><input
        id="net-control"
        bind:value={control}
        disabled={!!editing}
        placeholder={t('network:NetWizard.control.placeholder')}
        autocomplete="off"
        spellcheck="false"
      /></Field
    >
    {#if !editing}<Note size="md">
        <T k="network:NetWizard.control.note">{#snippet code(text)}<code>{text}</code>{/snippet}</T>
      </Note>{/if}
    <Field label={t('network:NetWizard.hostname')}
      ><input
        id="net-hostname"
        bind:value={hostname}
        // i18n-ignore-next: the default hostname, not words
        placeholder="webpc"
        autocomplete="off"
        spellcheck="false"
      /></Field
    >
    {#if here}
      <Field label={t('network:NetWizard.authKey')}
        ><input
          id="net-authkey"
          bind:value={authKey}
          type={reveal ? 'text' : 'password'}
          autocomplete="off"
          spellcheck="false"
        /></Field
      >
      <Check id="net-reveal" bind:checked={reveal}>{t('network:NetWizard.authKey.show')}</Check>
      <Note size="md">{t('network:NetWizard.authKey.note')}</Note>
    {:else if editing}
      <Note size="md">{t('network:NetWizard.control.edit')}</Note>
    {:else}
      <Note size="md">{t('network:NetWizard.login.note')}</Note>
    {/if}
  </section>
  <section id="net-step-tailcat" class="step" hidden={step !== 'tailcat'}>
    <Check id="net-tc-exit" bind:checked={tcExit}>{t('network:NetWizard.tailcat.exit')}</Check>
    <div id="net-tc-exit-fields" class="sub" hidden={!tcExit}>
      <ol class="steps">
        <li>
          <T k="network:NetWizard.tailcat.exit.install"
            >{#snippet a(text)}<a href="https://github.com/tailscale/tailcat" target="_blank" rel="noopener">{text}</a
              >{/snippet}</T
          >
        </li>
        <li><T k="network:NetWizard.tailcat.exit.run">{#snippet code(text)}<code>{text}</code>{/snippet}</T></li>
        <li>
          <Field label={t('network:NetWizard.tailcat.exit.paste')}
            ><input
              id="net-tailcat"
              bind:value={tailcat}
              type="password"
              // i18n-ignore-next: how an address starts, not words
              placeholder="tc…"
              autocomplete="off"
              spellcheck="false"
            /></Field
          >
        </li>
      </ol>
      <Note size="md">{t('network:NetWizard.tailcat.exit.note')}</Note>
    </div>
    <Check id="net-tc-serve" bind:checked={tcServe}>{t('network:NetWizard.tailcat.serve')}</Check>
    <div id="net-tc-serve-fields" class="sub" hidden={!tcServe}>
      <Note size="md">
        <T
          k="network:NetWizard.tailcat.serve.note"
          params={{ ssh: 'tailcat ssh <address>', connect: 'tailcat <address> <port>' }}
          >{#snippet code(text)}<code>{text}</code>{/snippet}</T
        >
      </Note>
      <details id="net-tc-advanced" bind:open={advanced}>
        <summary>{t('network:NetWizard.advanced')}</summary>
        <Field label={t('network:NetWizard.relay')}
          ><input
            id="net-tc-relay"
            bind:value={relay}
            disabled={tcExit}
            placeholder={t('network:NetWizard.relay.placeholder')}
            autocomplete="off"
            spellcheck="false"
          /></Field
        >
        <Note size="md">
          <T k="network:NetWizard.relay.note"
            >{#snippet a(text)}<a
                href="https://github.com/tailscale/tailscale/tree/main/cmd/derper"
                target="_blank"
                rel="noopener">{text}</a
              >{/snippet}</T
          >
        </Note>
        <Field label={t('network:NetWizard.allow')}
          ><textarea
            id="net-tc-allow"
            bind:value={allow}
            rows="3"
            placeholder={t('network:NetWizard.allow.placeholder')}
            autocomplete="off"
            spellcheck="false"></textarea></Field
        >
        <Note size="md">
          <T k="network:NetWizard.allow.note" params={{ genkey: 'tailcat genkey --client --key=client-default' }}
            >{#snippet code(text)}<code>{text}</code>{/snippet}</T
          >
        </Note>
        {#if editing}
          <div class="row">
            <Button type="button" id="net-tc-forget" disabled={!identityKept} onclick={forget}
              >{t('network:NetWizard.newAddress')}</Button
            >
          </div>
          <Note size="md">{t('network:NetWizard.newAddress.note')}</Note>
        {/if}
      </details>
    </div>
  </section>
  {#if !editing && (step === 'tailscale' || step === 'tailcat' || step === 'local' || step === 'roomCreate' || step === 'roomJoin')}
    <Check id="net-keep" bind:checked={keep}>
      {t('network:NetWizard.keep')}
      {#snippet note()}<span id="net-keep-note"
          >{keep ? t('network:NetWizard.keep.note') : t('network:NetWizard.keep.ephemeral')}</span
        >{/snippet}
    </Check>
  {/if}
  <Note tone="error" size="md" id="net-error" class="error" hidden={!formError}>
    {formError?.headline}{#each formError?.details ?? [] as d, i (i)}<br />{d}{/each}
  </Note>
  {#snippet back()}
    <Button
      type="button"
      id="net-back"
      hidden={!!editing || step === 'pick' || (step === 'kind' && !pickable)}
      onclick={goBack}>{t('network:NetWizard.back')}</Button
    >
  {/snippet}
  {#snippet buttons()}
    <Button type="button" id="net-cancel" onclick={close}>{t('network:NetWizard.cancel')}</Button>
    <Button
      id="net-connect"
      variant="primary"
      type="submit"
      disabled={working}
      hidden={step === 'kind' || step === 'roomPick' || (step === 'pick' && !picked)}>{submitLabel}</Button
    >
  {/snippet}
</Modal>

<style>
  .step {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  /* What a switch opens: under it, past its box. */
  .sub {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-left: var(--space-6);
  }
  .row {
    display: flex;
    gap: var(--space-3);
  }
  details summary {
    cursor: pointer;
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  details[open] {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  /* A details element's children are in its content slot: the gap between them is set there. */
  details[open]::details-content {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  /* A choice's numbered steps, which end at its field: the steps' words at the dialog's size, the field's label too. */
  .steps {
    --field-name-size: var(--text-base);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding-left: var(--space-6);
  }
  .steps li > details {
    margin-top: var(--space-3);
  }
  /* The commands as they're typed, a line each: they scroll rather than wrap. */
  #net-local-lines {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
  #net-tc-allow {
    resize: vertical;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
</style>
