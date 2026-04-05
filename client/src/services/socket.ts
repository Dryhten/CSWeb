import { io, Socket } from 'socket.io-client';

export function normalizeRoomId(roomId: string): string {
  return String(roomId || '').trim().toUpperCase();
}

class SocketService {
  private socket: Socket | null = null;
  private listeners: Map<string, Set<Function>> = new Map();

  connect() {
    if (this.socket?.connected) return;
    // 已有实例但已断开：主动重连，避免永远卡在「未连接」
    if (this.socket && !this.socket.connected) {
      this.socket.connect();
      return;
    }

    this.socket = io('/', {
      transports: ['websocket', 'polling'],
      autoConnect: true,
    });

    this.socket.on('connect', () => {
      console.log('Socket connected', this.socket?.id);
      const playerId = localStorage.getItem('playerId');
      const token = localStorage.getItem('token');
      if (playerId && token) {
        this.emit('auth', { playerId, token });
      }
    });

    this.socket.on('disconnect', () => {
      console.log('Socket disconnected');
    });

    this.socket.on('room:error', (data: { message: string }) => {
      console.error('Room error:', data.message);
    });

    this.socket.on('game:error', (data: { message: string }) => {
      console.error('Game error:', data.message);
    });

    this.socket.on('room:closed', (data: { reason: string }) => {
      console.log('Room closed:', data.reason);
    });
  }

  isConnected(): boolean {
    return this.socket?.connected || false;
  }

  /**
   * 等待首次连接；超时则结束，避免 UI（如 /game 门控、房间页）永远卡在等待。
   * @returns 是否在超时前已连接
   */
  waitForConnection(timeoutMs = 15000): Promise<boolean> {
    return new Promise((resolve) => {
      this.connect();
      const sock = this.socket;
      if (!sock) {
        console.warn('[socket] waitForConnection: socket 未创建');
        resolve(false);
        return;
      }
      if (sock.connected) {
        resolve(true);
        return;
      }
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.off('connect', onConnect);
        resolve(ok);
      };
      const onConnect = () => finish(true);
      const timer = setTimeout(() => {
        console.warn(`[socket] waitForConnection 超时 (${timeoutMs}ms)，请检查网络与 /socket.io 代理`);
        finish(false);
      }, timeoutMs);
      sock.once('connect', onConnect);
    });
  }

  disconnect() {
    this.socket?.disconnect();
    this.socket = null;
  }

  emit(event: string, data?: any) {
    this.socket?.emit(event, data);
  }

  on(event: string, callback: (...args: any[]) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
    this.socket?.on(event, callback);
  }

  off(event: string, callback: (...args: any[]) => void) {
    this.listeners.get(event)?.delete(callback);
    this.socket?.off(event, callback);
  }

  // Room events
  joinRoom(roomId: string) {
    const rid = normalizeRoomId(roomId);
    this.emit('room:join', { roomId: rid });
  }

  /**
   * connect 后立刻 join 时，auth 包可能尚未被服务端处理，导致 odId 未绑定、命中事件找不到玩家。
   * 在已连接前提下延迟再 join（房间页与对局页均使用）。
   */
  joinRoomAfterConnect(roomId: string, delayMs = 160) {
    setTimeout(() => this.joinRoom(roomId), delayMs);
  }

  leaveRoom(roomId: string) {
    const rid = normalizeRoomId(roomId);
    this.emit('room:leave', { roomId: rid });
  }

  setReady(roomId: string, isReady: boolean) {
    const rid = normalizeRoomId(roomId);
    this.emit('room:ready', { roomId: rid, isReady });
  }

  switchTeam(roomId: string, team: string) {
    const rid = normalizeRoomId(roomId);
    this.emit('room:switchTeam', { roomId: rid, team });
  }

  sendRoomChat(roomId: string, text: string) {
    const rid = normalizeRoomId(roomId);
    this.emit('room:chat', { roomId: rid, text });
  }

  startGame(roomId: string) {
    const rid = normalizeRoomId(roomId);
    this.emit('game:start', { roomId: rid });
  }

  /** 对局结束回房间：服务端将 gameState 置为 waiting，便于房间内再次开局 */
  returnToRoomAfterMatch(roomId: string, onDone?: (ok: boolean) => void) {
    this.connect();
    const sock = this.socket;
    if (!sock) {
      onDone?.(false);
      return;
    }
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      onDone?.(ok);
    };
    const fallback = setTimeout(() => finish(false), 10000);
    sock.emit('game:returnToRoom', { roomId: normalizeRoomId(roomId) }, (res: { ok?: boolean } | undefined) => {
      finish(!!res?.ok);
    });
  }

  // Game events
  sendPlayerMove(roomId: string, position: any, rotation: any, weaponType?: string) {
    const rid = normalizeRoomId(roomId);
    const payload: Record<string, unknown> = { roomId: rid, position, rotation };
    if (weaponType != null && weaponType !== '') payload.weapon = String(weaponType);
    this.emit('game:playerMove', payload);
  }

  sendShoot(roomId: string, weapon: string, position: any, direction: any) {
    const rid = normalizeRoomId(roomId);
    this.emit('game:shoot', { roomId: rid, weapon, position, direction });
  }

  sendHit(
    roomId: string,
    payload: {
      targetId: string;
      weapon: string;
      hitType: string;
      bodyPart?: string;
      distanceMeters?: number;
      throughWood?: boolean;
      meleeKind?: string;
    }
  ) {
    const rid = normalizeRoomId(roomId);
    const { targetId, weapon, hitType, bodyPart, distanceMeters, throughWood, meleeKind } = payload;
    const out: Record<string, unknown> = { roomId: rid, targetId, weapon, hitType };
    if (bodyPart != null) out.bodyPart = bodyPart;
    if (distanceMeters != null && Number.isFinite(distanceMeters)) out.distanceMeters = distanceMeters;
    if (throughWood === true) out.throughWood = true;
    if (meleeKind != null) out.meleeKind = meleeKind;
    this.emit('game:hit', out);
  }

  sendSpawnProtectShoot(roomId: string) {
    const rid = normalizeRoomId(roomId);
    this.emit('game:spawnProtectShoot', { roomId: rid });
  }

  sendPlayerRespawn(
    roomId: string,
    position?: { x: number; y: number; z: number },
    rotation?: { x: number; y: number; z: number; w: number }
  ) {
    const rid = normalizeRoomId(roomId);
    const payload: Record<string, unknown> = { roomId: rid };
    if (
      position &&
      rotation &&
      [position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w].every(
        (v) => typeof v === 'number' && Number.isFinite(v)
      )
    ) {
      payload.position = position;
      payload.rotation = rotation;
    }
    this.emit('game:playerRespawn', payload);
  }

  sendRoundEnd(roomId: string, winner: string) {
    const rid = normalizeRoomId(roomId);
    this.emit('game:roundEnd', { roomId: rid, winner });
  }

  /** 1v1 回合时间到：仅应由房主调用，服务端校验 */
  sendRoundTimeUp(roomId: string) {
    const rid = normalizeRoomId(roomId);
    this.emit('game:roundTimeUp', { roomId: rid });
  }

  get id() {
    return this.socket?.id;
  }
}

export const socketService = new SocketService();
export default socketService;