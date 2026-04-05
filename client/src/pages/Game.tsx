import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGameStore } from '../hooks/useGameStore';
import socketService, { normalizeRoomId } from '../services/socket';
import { lobbyApi } from '../services/api';
import './styles/game.css';

export default function Game() {
  const navigate = useNavigate();
  const { currentRoom, updateRoom } = useGameStore();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [allowPlay, setAllowPlay] = useState(false);
  const [gateChecked, setGateChecked] = useState(false);

  /** 仅当房间 gameState 为 playing 时允许加载对局；否则拉取后退回房间页 */
  useEffect(() => {
    let cancelled = false;
    async function gate() {
      if (!currentRoom) {
        navigate('/lobby');
        return;
      }
      const rid = currentRoom.roomId;
      if (currentRoom.gameState?.status === 'playing') {
        const ok = await socketService.waitForConnection(15000);
        if (cancelled) return;
        if (ok) socketService.joinRoomAfterConnect(rid);
        setAllowPlay(true);
        setGateChecked(true);
        return;
      }
      try {
        const { data } = await lobbyApi.getRoom(rid);
        if (cancelled) return;
        updateRoom(data);
        if (data.gameState?.status !== 'playing') {
          navigate(`/room/${data.roomId}`, { replace: true });
          setGateChecked(true);
          return;
        }
        const ok = await socketService.waitForConnection(15000);
        if (cancelled) return;
        if (ok) socketService.joinRoomAfterConnect(rid);
        setAllowPlay(true);
        setGateChecked(true);
      } catch {
        if (!cancelled) {
          navigate(`/room/${rid}`, {
            replace: true,
            state: { gateError: '无法校验对局状态，请检查网络后重试' },
          });
        }
        setGateChecked(true);
      }
    }
    gate();
    return () => {
      cancelled = true;
    };
  }, [currentRoom?.roomId, currentRoom?.gameState?.status, navigate, updateRoom]);

  useEffect(() => {
    if (!allowPlay || !currentRoom || !gateChecked) return;

    const iframe = iframeRef.current;
    if (!iframe) return;

    const sendInit = () => {
      const w = iframe.contentWindow;
      if (!w) return;
      const myPid = localStorage.getItem('playerId');
      const meInRoom = currentRoom.players.find(
        (p) => p.playerId != null && String(p.playerId) === String(myPid)
      );
      const gameData = {
        type: 'init',
        roomId: currentRoom.roomId,
        playerId: myPid,
        nickname: localStorage.getItem('nickname'),
        team: meInRoom?.team ?? 'CT',
        isHost: meInRoom?.isHost ?? false,
        localSocketId: socketService.id || null,
        players: currentRoom.players.map((p) => ({
          odId: p.odId,
          playerId: p.playerId,
          nickname: p.nickname,
          team: p.team,
          isHost: p.isHost,
          isBot: p.nickname.startsWith('_bot_'),
        })),
        gameState: {
          ...currentRoom.gameState,
          status: currentRoom.gameState?.status ?? 'playing',
        },
        settings: {
          ...(currentRoom.settings ?? {}),
          mode: currentRoom.settings?.mode ?? 'pvp',
        },
      };
      w.postMessage(gameData, '*');
    };

    const onChildReady = (e: MessageEvent) => {
      if (e.data?.type !== 'csweb-game-ready') return;
      if (e.source !== iframe.contentWindow) return;
      sendInit();
    };
    window.addEventListener('message', onChildReady);

    /** Socket 每次连接/重连后刷新 init，保证 localSocketId、players.odId 与当前 socket 一致 */
    const onSocketConnect = () => sendInit();
    socketService.on('connect', onSocketConnect);

    /** 首帧 + 延迟重发：避免 iframe 内模块尚未注册 message 时 init 丢失导致 running 永为 false */
    sendInit();
    const t1 = window.setTimeout(sendInit, 50);
    const t2 = window.setTimeout(sendInit, 200);
    const t3 = window.setTimeout(sendInit, 600);

    const onLoad = () => sendInit();
    iframe.addEventListener('load', onLoad);

    return () => {
      window.removeEventListener('message', onChildReady);
      socketService.off('connect', onSocketConnect);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      iframe.removeEventListener('load', onLoad);
    };
  }, [allowPlay, gateChecked, currentRoom]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'quit-game') {
        navigate('/lobby');
        return;
      }
      if (event.data?.type === 'return-to-room') {
        const rid = event.data.roomId as string | undefined;
        if (!rid) return;
        socketService.returnToRoomAfterMatch(rid, () => {
          navigate(`/room/${rid}`, { replace: true });
        });
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [navigate]);

  /** iframe ↔ 单 socket：本机位移 → game:playerMove；game:playerMoved → iframe 远端渲染 */
  useEffect(() => {
    if (!allowPlay || !currentRoom) return;
    const roomId = currentRoom.roomId;
    if (!roomId) return;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;

    const roomIdNorm = normalizeRoomId(roomId);
    let lastSelfEmit = 0;

    const onIframeMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const t = event.data?.type;
      if (t === 'mp-sync-self') {
        const { roomId: rid, position, rotation, weaponType } = event.data as {
          roomId?: string;
          position?: unknown;
          rotation?: unknown;
          weaponType?: string;
        };
        if (normalizeRoomId(rid ?? '') !== roomIdNorm || !position) return;
        const now = performance.now();
        if (now - lastSelfEmit < 50) return;
        lastSelfEmit = now;
        socketService.sendPlayerMove(roomId, position, rotation, weaponType);
        return;
      }
      if (t === 'mp-send-hit') {
        const d = event.data as {
          roomId?: string;
          targetId?: string;
          weapon?: string;
          hitType?: string;
          bodyPart?: string;
          distanceMeters?: number;
          throughWood?: boolean;
          meleeKind?: string;
        };
        if (normalizeRoomId(d.roomId ?? '') !== roomIdNorm || !d.targetId) return;
        socketService.sendHit(roomId, {
          targetId: String(d.targetId),
          weapon: String(d.weapon || ''),
          hitType: String(d.hitType || 'gun'),
          ...(d.bodyPart != null && d.bodyPart !== '' ? { bodyPart: String(d.bodyPart) } : {}),
          ...(typeof d.distanceMeters === 'number' && Number.isFinite(d.distanceMeters)
            ? { distanceMeters: d.distanceMeters }
            : {}),
          ...(d.throughWood === true ? { throughWood: true } : {}),
          ...(d.meleeKind != null && d.meleeKind !== ''
            ? { meleeKind: String(d.meleeKind) }
            : {}),
        });
        return;
      }
      if (t === 'mp-respawn-self') {
        const { roomId: rid, position, rotation } = event.data as {
          roomId?: string;
          position?: { x: number; y: number; z: number };
          rotation?: { x: number; y: number; z: number; w: number };
        };
        if (!rid || normalizeRoomId(rid) !== roomIdNorm) return;
        socketService.sendPlayerRespawn(roomId, position, rotation);
        return;
      }
      if (t === 'mp-spawn-protect-shoot') {
        const rid = event.data?.roomId as string | undefined;
        if (!rid || normalizeRoomId(rid) !== roomIdNorm) return;
        socketService.sendSpawnProtectShoot(roomId);
      }
    };

    const onPlayerMoved = (data: {
      socketId: string;
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number; w: number };
      weapon?: string;
    }) => {
      iframe.contentWindow?.postMessage(
        {
          type: 'mp-sync-remote',
          socketId: data.socketId,
          position: data.position,
          rotation: data.rotation,
          weaponType: data.weapon,
        },
        '*'
      );
    };

    const onPlayerHit = (data: Record<string, unknown>) => {
      iframe.contentWindow?.postMessage({ type: 'mp-player-hit', ...data }, '*');
    };

    const onPlayerRespawned = (data: {
      socketId?: string;
      position?: { x: number; y: number; z: number };
      rotation?: { x: number; y: number; z: number; w: number };
      spawnProtect?: boolean;
    }) => {
      iframe.contentWindow?.postMessage(
        {
          type: 'mp-player-respawned',
          socketId: data.socketId,
          position: data.position,
          rotation: data.rotation,
          spawnProtect: data.spawnProtect,
        },
        '*'
      );
    };

    const onSpawnProtectEnd = (data: { socketId?: string }) => {
      iframe.contentWindow?.postMessage(
        { type: 'mp-spawn-protect-end', socketId: data.socketId },
        '*'
      );
    };

    window.addEventListener('message', onIframeMessage);
    socketService.on('game:playerMoved', onPlayerMoved);
    socketService.on('game:playerHit', onPlayerHit);
    socketService.on('game:playerRespawned', onPlayerRespawned);
    socketService.on('game:spawnProtectEnd', onSpawnProtectEnd);
    return () => {
      window.removeEventListener('message', onIframeMessage);
      socketService.off('game:playerMoved', onPlayerMoved);
      socketService.off('game:playerHit', onPlayerHit);
      socketService.off('game:playerRespawned', onPlayerRespawned);
      socketService.off('game:spawnProtectEnd', onSpawnProtectEnd);
    };
  }, [allowPlay, currentRoom?.roomId]);

  if (!currentRoom) {
    return null;
  }

  if (!gateChecked || !allowPlay) {
    return (
      <div className="game-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
        校验对局状态…
      </div>
    );
  }

  return (
    <div className="game-container">
      <iframe
        ref={iframeRef}
        src="/game.html"
        className="game-iframe"
        title="Game"
      />
    </div>
  );
}
