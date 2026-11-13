// A room's link as the page writes and reads it (web/room.ts, docs/networking/rooms.md): the same text net/ts's
// room/link.rs writes (its own test's link, byte for byte), the defaults left to the module, a private room's ID, and
// what a pasted link or the Create form's relays may not be.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base32, isPrivateRoom, parseRoomLink, privateRoomId, ROOM_MAX_ID, roomLink, roomName } from '../web/room.ts';




test("a room's link: link.rs's text, read back; a bare ID gets the defaults", () => {
  // link.rs `a_link_reads_back`'s link, as Link::encode writes it.
  const rust = 'waarm64-room:gabriel%20lan?nostr=wss%3A%2F%2Frelay.example&derp=900&derp=derp.example%3A8443';
  assert.deepEqual(roomLink({ id: 'gabriel lan', nostr: ['wss://relay.example'], derp: ['900', 'derp.example:8443'] }), { link: rust });
  const back = parseRoomLink(`${rust}&x=later`);
  assert.ok('link' in back);
  assert.equal(back.link, rust, 'a later version\'s parts are ignored, as link.rs does');
  assert.deepEqual(back.room, { id: 'gabriel lan', nostr: ['wss://relay.example'], derp: ['900', 'derp.example:8443'] });
  assert.deepEqual(parseRoomLink('waarm64-room:a?derp=%5B%3A%3A1%5D%3A3340'), { link: 'waarm64-room:a?derp=%5B%3A%3A1%5D%3A3340', room: { id: 'a', nostr: [], derp: ['[::1]:3340'] } });
  // A bare ID (a public room's name): no relays in the link, so the module's defaults.
  assert.deepEqual(parseRoomLink('  café lan '), { link: 'waarm64-room:caf%C3%A9%20lan', room: { id: 'café lan', nostr: [], derp: [] } });
});

test("a private room's ID: the name, a hyphen and 128 random bits in base32; nothing else is private", () => {
  assert.equal(base32(new Uint8Array([0xff, 0, 0x55])), '74afk');
  const id = privateRoomId(' work ');
  assert.match(id, /^work-[a-z2-7]{26}$/);
  assert.notEqual(privateRoomId('work'), id);
  assert.ok(isPrivateRoom(id));
  assert.equal(roomName(id), 'work');
  assert.ok(!isPrivateRoom('work'));
  assert.ok(!isPrivateRoom('work-tooshort'));
  assert.equal(roomName('gabriel-lan'), 'gabriel-lan');
});

test("what a link or the form's relays may not be", () => {
  const err = (r: ReturnType<typeof parseRoomLink> | ReturnType<typeof roomLink>) => ('error' in r ? r.error.key : 'ok');

  assert.equal(err(parseRoomLink('   ')), 'network:room.pasteLink');
  assert.equal(err(parseRoomLink('waarm64-room:')), 'network:room.noName');
  assert.equal(err(parseRoomLink('waarm64-room:a%zz')), 'network:room.badLink');
  assert.equal(err(parseRoomLink('waarm64-room:a%ff')), 'network:room.badLink', 'not UTF-8');
  assert.equal(err(parseRoomLink('waarm64-room:a?nostr=https%3A%2F%2Fx')), 'network:room.badRelay');
  assert.equal(err(parseRoomLink('waarm64-room:a?derp=-1')), 'network:room.badDerp');
  assert.equal(err(roomLink({ id: 'a', nostr: [], derp: ['https://x'] })), 'network:room.badDerp');
  assert.equal(err(roomLink({ id: 'é'.repeat(ROOM_MAX_ID / 2 + 1), nostr: [], derp: [] })), 'network:room.longName', 'bytes, not characters');
  assert.equal(err(roomLink({ id: 'é'.repeat(ROOM_MAX_ID / 2), nostr: [], derp: [] })), 'ok');
  assert.equal(err(roomLink({ id: 'a', nostr: Array(9).fill('wss://r.example'), derp: [] })), 'network:room.tooMany');
  assert.equal(err(roomLink({ id: 'a', nostr: ['ws://127.0.0.1:7777'], derp: ['127.0.0.1:8444', '0'] })), 'ok', "one's own relays, and a region of the map");
});

test("a pasted link with raw non-ASCII decodes as link.rs does, and a derper's port fits in 16 bits", () => {
  const room = (s: string) => { const r = parseRoomLink(s); return 'room' in r ? r.room.id : r.error.key; };
  assert.equal(room('waarm64-room:café%20lan'), 'café lan');
  assert.equal(room('waarm64-room:é%4142'), 'éA42');
  const err = (r: ReturnType<typeof roomLink>) => ('error' in r ? r.error.key : 'ok');
  assert.equal(err(roomLink({ id: 'a', nostr: [], derp: ['derp.example:99999'] })), 'network:room.badDerp');
  assert.equal(err(roomLink({ id: 'a', nostr: [], derp: ['[::1]:65536'] })), 'network:room.badDerp');
  assert.equal(err(roomLink({ id: 'a', nostr: [], derp: ['derp.example:65535'] })), 'ok');
});
