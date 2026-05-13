/**
 * DispersalRoom — Cloudflare Durable Object
 *
 * One instance per dispersal room, keyed by roomId.
 * Manages room state, WebSocket connections, and draft logic.
 *
 * Internal HTTP routes (called by the Worker):
 *   POST /init                           → initialize room state
 *   GET  /api/dispersal/:id              → return public state
 *   DELETE /api/dispersal/:id            → delete room (commissioner only)
 *   POST /api/dispersal/:id/claim        → claim a team slot, get sessionToken
 *   GET  /api/dispersal/:id/ws (Upgrade) → WebSocket connection for live picks
 */

export class DispersalRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // sessionId -> WebSocket
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Internal init call from the Worker (room creation)
    if (url.pathname === '/init' && request.method === 'POST') {
      const room = await request.json();
      await this.state.storage.put('room', room);
      await this.state.storage.setAlarm(room.expiresAt);
      return ok({ ok: true });
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    // HTTP routes — extract action segment after the room ID
    // Path: /api/dispersal/{id}          → action = ''
    //       /api/dispersal/{id}/claim    → action = 'claim'
    const parts = url.pathname.split('/').filter(Boolean);
    const action = parts[3] || ''; // index: api=0, dispersal=1, id=2, action=3

    if (!action) {
      if (request.method === 'GET') return this.getState();
      if (request.method === 'DELETE') return this.deleteRoom(request);
    }
    if (action === 'claim' && request.method === 'POST') return this.claimSlot(request);

    return new Response('Not found', { status: 404 });
  }

  // ── State ──────────────────────────────────────────────────────────────────

  async getState() {
    const room = await this.state.storage.get('room');
    if (!room) return new Response('Room not found', { status: 404 });
    return ok(this.publicState(room));
  }

  async deleteRoom(request) {
    const { commissionerCode } = await request.json().catch(() => ({}));
    const room = await this.state.storage.get('room');
    if (!room) return new Response('Room not found', { status: 404 });
    if (room.commissionerCode !== commissionerCode) {
      return new Response('Unauthorized', { status: 401 });
    }
    for (const ws of this.sessions.values()) {
      try { ws.close(1000, 'Room deleted'); } catch {}
    }
    this.sessions.clear();
    await this.state.storage.deleteAll();
    return ok({ ok: true });
  }

  async claimSlot(request) {
    const { claimCode } = await request.json().catch(() => ({}));
    const room = await this.state.storage.get('room');
    if (!room) return new Response('Room not found', { status: 404 });

    const slot = room.teamSlots.find(s => s.claimCode === claimCode?.toUpperCase());
    if (!slot) return new Response('Invalid claim code', { status: 403 });

    // If already claimed, return the existing token so the owner can reconnect
    if (slot.sessionToken) {
      return ok({ sessionToken: slot.sessionToken, slotIndex: slot.index, slotName: slot.name });
    }

    const tokenBytes = new Uint8Array(16);
    crypto.getRandomValues(tokenBytes);
    const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    slot.sessionToken = token;
    slot.claimed = true;
    await this.state.storage.put('room', room);
    this.broadcast({ type: 'state', room: this.publicState(room) });

    return ok({ sessionToken: token, slotIndex: slot.index, slotName: slot.name });
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  async handleWebSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const sid = Math.random().toString(36).slice(2);
    this.sessions.set(sid, server);

    const room = await this.state.storage.get('room');
    if (!room) {
      server.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
      server.close(1008, 'Room not found');
    } else {
      server.send(JSON.stringify({ type: 'state', room: this.publicState(room) }));
    }

    server.addEventListener('message', async evt => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'pick') {
          await this.processPick(msg.assetId, msg.sessionToken, server);
        }
      } catch {}
    });

    server.addEventListener('close', () => this.sessions.delete(sid));
    server.addEventListener('error', () => this.sessions.delete(sid));

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Draft Logic ────────────────────────────────────────────────────────────

  async processPick(assetId, sessionToken, senderWs) {
    const room = await this.state.storage.get('room');
    if (!room || room.status === 'complete') return;

    // Validate token → slot
    const slot = room.teamSlots.find(s => s.sessionToken === sessionToken);
    if (!slot) {
      senderWs?.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      return;
    }

    // Check that it's this slot's turn
    const expectedSlot = snakeSlot(room.currentOverallPick, room.numTeams, room.draftOrder);
    if (slot.index !== expectedSlot) {
      senderWs?.send(JSON.stringify({ type: 'error', message: 'Not your turn' }));
      return;
    }

    // Find available asset
    const asset = room.assets.find(a => a.id === assetId && a.pickedBy === null);
    if (!asset) {
      senderWs?.send(JSON.stringify({ type: 'error', message: 'Asset not available' }));
      return;
    }

    asset.pickedBy = slot.index;
    const pick0 = room.currentOverallPick - 1;
    room.picks.push({
      overallPick: room.currentOverallPick,
      round: Math.floor(pick0 / room.numTeams) + 1,
      pickInRound: (pick0 % room.numTeams) + 1,
      slotIndex: slot.index,
      assetId,
      timestamp: Date.now(),
    });
    room.currentOverallPick++;

    if (room.picks.length >= room.assets.length) {
      room.status = 'complete';
    }

    await this.state.storage.put('room', room);
    this.broadcast({ type: 'state', room: this.publicState(room) });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Strip commissioner-only fields before sending to clients */
  publicState(room) {
    return {
      ...room,
      commissionerCode: undefined,
      teamSlots: room.teamSlots.map(({ claimCode, sessionToken, ...rest }) => rest),
    };
  }

  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const [sid, ws] of this.sessions) {
      try { ws.send(text); } catch { this.sessions.delete(sid); }
    }
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Given an overall pick number (1-based), the number of teams, and the draft
 * order array, returns the slotIndex whose turn it is (snake logic).
 */
function snakeSlot(overallPick, numTeams, draftOrder) {
  const pick0  = overallPick - 1;
  const round  = Math.floor(pick0 / numTeams);
  const pos    = pick0 % numTeams;
  const idx    = round % 2 === 0 ? pos : (numTeams - 1 - pos);
  return draftOrder[idx];
}

function ok(body) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}
