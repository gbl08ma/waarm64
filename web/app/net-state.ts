// Where the page keeps its connections' state (web/app/connections.ts `ConnectionState`; docs/networking/adapters.md
// §2.1): a tailnet's node in `waarm64-tailscale`, tailcat's identity in `waarm64-tailcat`, a room's key in
// `waarm64-room`, each where its client reads it.
import { forgetRoomIdentity, keepRoomIdentity, readRoomIdentity, roomIdentity } from '../room.ts';
import { forgetTailcatIdentity } from '../tailcat.ts';
import { forgetProfile } from '../tailscale-state.ts';
import type { ConnectionState } from './connections.ts';

export const pageConnectionState: ConnectionState = {
  forgetTailnet: forgetProfile,
  forgetTailcat: forgetTailcatIdentity,
  forgetRoom: forgetRoomIdentity,
  readRoom: readRoomIdentity,
  roomIdentity,
  keepRoom: keepRoomIdentity,
};
