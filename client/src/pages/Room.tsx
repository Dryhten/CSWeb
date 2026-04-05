import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useGameStore } from '../hooks/useGameStore';
import socketService, { normalizeRoomId } from '../services/socket';
import { lobbyApi } from '../services/api';
import type { GameState, Room, RoomPlayer } from '../types';

function isRoomBot(p: { nickname: string }) {
  return p.nickname.startsWith('_bot_');
}

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { player } = useAuth();
  const { currentRoom, isHost, isReady, isInRoom, setReady, updateRoom, leaveRoom, reset, joinRoom } =
    useGameStore();
  const [chatMessages, setChatMessages] = useState<Array<{ sender: string; text: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [slotJoinError, setSlotJoinError] = useState('');
  const [socketActionError, setSocketActionError] = useState('');
  const [roomLoadError, setRoomLoadError] = useState('');
  const [roundTimeDraft, setRoundTimeDraft] = useState('');
  const [roundTimeSaving, setRoundTimeSaving] = useState(false);
  const [roundTimeError, setRoundTimeError] = useState('');
  /** 进入房间页自动占坑（未满且未结束时），每房间仅尝试一次（失败可手动点空位） */
  const autoJoinTriedRef = useRef(false);

  useEffect(() => {
    autoJoinTriedRef.current = false;
  }, [roomId]);

  useEffect(() => {
    const st = location.state as { gateError?: string } | undefined;
    if (st?.gateError) {
      setSocketActionError(st.gateError);
      navigate(location.pathname + location.search, { replace: true, state: {} });
    }
  }, [location.state, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (!roomId) return;

    setChatMessages([]);

    const loadRoom = async () => {
      setRoomLoadError('');
      try {
        const response = await lobbyApi.getRoom(roomId);
        setSlotJoinError('');
        updateRoom(response.data);
      } catch (error) {
        console.error('Failed to load room:', error);
        setRoomLoadError('无法加载房间，请检查网络或房间是否仍存在');
      }
    };

    loadRoom();

    // Wait for socket connection before joining
    const initSocket = async () => {
      await socketService.waitForConnection(15000);
      setIsConnected(true);
      socketService.joinRoomAfterConnect(roomId);
    };
    initSocket();

    const handlePlayerJoined = (data: any) => {
      const room = useGameStore.getState().currentRoom;
      if (room) {
        updateRoom({ ...room, players: data.players } as Room);
      }
    };

    const handlePlayerLeft = (data: any) => {
      const room = useGameStore.getState().currentRoom;
      if (room) {
        updateRoom({ ...room, players: data.players } as Room);
      }
    };

    const handlePlayerReady = (data: any) => {
      const room = useGameStore.getState().currentRoom;
      if (room) {
        updateRoom({ ...room, players: data.players } as Room);
      }
    };

    const handleTeamChanged = (data: any) => {
      const room = useGameStore.getState().currentRoom;
      if (room) {
        updateRoom({ ...room, players: data.players } as Room);
      }
    };

    socketService.on('room:playerJoined', handlePlayerJoined);
    socketService.on('room:playerLeft', handlePlayerLeft);
    socketService.on('room:playerReady', handlePlayerReady);
    socketService.on('room:teamChanged', handleTeamChanged);

    const handleGameStarted = (data: any) => {
      setSocketActionError('');
      const room = useGameStore.getState().currentRoom;
      if (!room) return;
      const gs = data.gameState;
      const nextRoom = {
        ...room,
        settings: data.settings || room.settings,
        gameState: gs
          ? {
              ...room.gameState,
              status: gs.status ?? 'playing',
              round: gs.round ?? 1,
              ctScore: gs.ctScore ?? room.gameState.ctScore,
              tScore: gs.tScore ?? room.gameState.tScore,
              startTime: gs.startTime,
            }
          : { ...room.gameState, status: 'playing' as const, round: data.round ?? 1 },
      } as Room;
      updateRoom(nextRoom);
      const playerStr = localStorage.getItem('player');
      const pl = playerStr ? JSON.parse(playerStr) : null;
      const myId = pl?.id;
      const me = nextRoom.players.find(
        (p) =>
          !isRoomBot(p) &&
          p.playerId != null &&
          String(p.playerId) === String(myId)
      );
      /** 开局时全员已准备，仅已准备玩家自动进入对局 */
      if (me && me.isReady) {
        navigate('/game');
      }
    };

    socketService.on('game:started', handleGameStarted);

    const handleGameStateUpdated = (data: { gameState?: Partial<GameState> }) => {
      const room = useGameStore.getState().currentRoom;
      if (!room || !data.gameState) return;
      updateRoom({
        ...room,
        gameState: { ...room.gameState, ...data.gameState },
      } as Room);
    };
    socketService.on('room:gameStateUpdated', handleGameStateUpdated);

    const handleRoomClosed = () => {
      reset();
      navigate('/lobby');
    };
    socketService.on('room:closed', handleRoomClosed);

    const handleGameError = (data: { message?: string }) => {
      const msg = data?.message || '游戏操作失败';
      setSocketActionError(msg);
    };
    const handleRoomError = (data: { message?: string }) => {
      const msg = data?.message || '房间操作失败';
      setSocketActionError(msg);
    };
    socketService.on('game:error', handleGameError);
    socketService.on('room:error', handleRoomError);

    const roomIdNorm = normalizeRoomId(roomId);
    const handleRoomChatMessage = (data: {
      roomId?: string;
      sender?: string;
      text?: string;
    }) => {
      if (normalizeRoomId(data?.roomId ?? '') !== roomIdNorm) return;
      const text = typeof data?.text === 'string' ? data.text : '';
      if (!text) return;
      const sender = typeof data?.sender === 'string' && data.sender ? data.sender : '玩家';
      setChatMessages((prev) => {
        const next = [...prev, { sender, text }];
        return next.length > 100 ? next.slice(-100) : next;
      });
    };
    socketService.on('room:chatMessage', handleRoomChatMessage);

    return () => {
      // 不主动调用 leaveRoom，让 socket 断开连接时自动处理
      socketService.off('room:playerJoined', handlePlayerJoined);
      socketService.off('room:playerLeft', handlePlayerLeft);
      socketService.off('room:playerReady', handlePlayerReady);
      socketService.off('room:teamChanged', handleTeamChanged);
      socketService.off('game:started', handleGameStarted);
      socketService.off('room:gameStateUpdated', handleGameStateUpdated);
      socketService.off('room:closed', handleRoomClosed);
      socketService.off('game:error', handleGameError);
      socketService.off('room:error', handleRoomError);
      socketService.off('room:chatMessage', handleRoomChatMessage);
    };
  }, [roomId, isConnected, navigate, updateRoom, reset]);

  const handleEnterGame = () => {
    navigate('/game');
  };

  const handleToggleReady = async () => {
    if (!roomId) return;
    await socketService.waitForConnection(15000);
    const newReady = !isReady;
    setReady(newReady);
    socketService.setReady(roomId, newReady);
  };

  const handleStartGame = async () => {
    if (!roomId) return;
    setSocketActionError('');
    await socketService.waitForConnection(15000);
    socketService.startGame(roomId);
  };

  const handleLeave = async () => {
    if (isInRoom) await leaveRoom();
    navigate('/lobby');
  };

  const handleSwitchTeam = async (team: 'CT' | 'T') => {
    if (!roomId || !isInRoom) return;
    await socketService.waitForConnection(15000);
    socketService.switchTeam(roomId, team);
  };

  const handleSlotClick = async (team: 'CT' | 'T') => {
    if (!roomId || !currentRoom) return;
    /** 对局中仅允许未进房玩家点空位加入，禁止在房内换队 */
    if (currentRoom.gameState.status === 'playing' && isInRoom) return;
    if (currentRoom.settings.mode === 'pve') {
      if (!isInRoom) {
        setSlotJoinError('');
        try {
          await joinRoom(roomId, undefined, 'CT');
        } catch (e: unknown) {
          const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
          setSlotJoinError(msg || '加入失败');
        }
      }
      return;
    }
    if (currentRoom.settings.mode === '1v1') {
      if (!isInRoom) {
        setSlotJoinError('');
        try {
          await joinRoom(roomId, undefined, team);
        } catch (e: unknown) {
          const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
          setSlotJoinError(msg || '加入失败');
        }
        return;
      }
      if (myTeam === team) return;
      await handleSwitchTeam(team);
      return;
    }
    if (!isInRoom) {
      setSlotJoinError('');
      try {
        await joinRoom(roomId, undefined, team);
      } catch (e: unknown) {
        const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
        setSlotJoinError(msg || '加入失败');
      }
      return;
    }
    if (myTeam === team) return;
    await handleSwitchTeam(team);
  };

  const handleSendChat = async (e: FormEvent) => {
    e.preventDefault();
    const t = chatInput.trim();
    if (!t || !roomId) return;
    await socketService.waitForConnection(15000);
    socketService.sendRoomChat(roomId, t);
    setChatInput('');
  };

  const handleSaveRoundTime = async () => {
    if (!roomId) return;
    const n = parseInt(roundTimeDraft, 10);
    if (!Number.isFinite(n) || n < 60 || n > 600) {
      setRoundTimeError('每回合时长须为 60–600 秒');
      return;
    }
    setRoundTimeSaving(true);
    setRoundTimeError('');
    try {
      await lobbyApi.updateRoomSettings(roomId, { roundTime: n });
      const { data } = await lobbyApi.getRoom(roomId);
      updateRoom(data);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setRoundTimeError(msg || '保存失败');
    } finally {
      setRoundTimeSaving(false);
    }
  };

  useEffect(() => {
    if (!currentRoom) return;
    const rt = currentRoom.settings?.roundTime;
    setRoundTimeDraft(String(rt != null && rt > 0 ? rt : 120));
  }, [currentRoom?.roomId, currentRoom?.settings?.roundTime]);

  /** 未满且未结束时自动占坑：PVE 固定进 CT 小队，其余模式由服务端分配阵营 */
  useEffect(() => {
    if (!roomId || !currentRoom) return;
    if (currentRoom.gameState.status === 'ended') return;
    if (useGameStore.getState().isInRoom) return;
    const humans = currentRoom.players.filter((p) => !isRoomBot(p)).length;
    if (humans >= currentRoom.settings.maxPlayers) return;
    if (autoJoinTriedRef.current) return;
    autoJoinTriedRef.current = true;
    const mode = currentRoom.settings.mode;
    if (mode === 'pve') {
      void joinRoom(roomId, undefined, 'CT').catch(() => {});
    } else {
      void joinRoom(roomId).catch(() => {});
    }
  }, [roomId, currentRoom, joinRoom]);

  if (!currentRoom) {
    if (roomLoadError) {
      return (
        <div className="screen" style={{ background: '#0a0a0f', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', maxWidth: 420, padding: 24 }}>
            <div style={{ color: '#ff6a6a', fontFamily: 'Orbitron', marginBottom: 16 }}>{roomLoadError}</div>
            <button type="button" className="room-btn" onClick={() => navigate('/lobby')}>
              返回大厅
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="screen" style={{ background: '#0a0a0f', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#FF6A00', fontFamily: 'Orbitron' }}>加载中...</div>
      </div>
    );
  }

  const is1v1 = currentRoom.settings.mode === '1v1';
  const isPve = currentRoom.settings.mode === 'pve';
  const maxPerTeam = is1v1 ? 1 : Math.min(5, Math.floor(currentRoom.settings.maxPlayers / 2));
  const maxSquadSlots = Math.max(1, currentRoom.settings.maxPlayers);
  const ctHumans = currentRoom.players.filter((p) => p.team === 'CT' && !isRoomBot(p));
  const tHumans = currentRoom.players.filter((p) => p.team === 'T' && !isRoomBot(p));
  const humanCount = currentRoom.players.filter((p) => !isRoomBot(p)).length;

  const myPid = String(player?.id ?? '');
  const mePlayer = currentRoom.players.find(
    (p) => !isRoomBot(p) && p.playerId != null && String(p.playerId) === myPid
  );
  const myTeam = mePlayer?.team as 'CT' | 'T' | undefined;

  const humanPlayers = currentRoom.players.filter((p) => !isRoomBot(p));
  const allHumansReady =
    humanPlayers.length >= 1 && humanPlayers.every((p) => p.isReady === true);
  const minPlayersOk = is1v1 ? humanCount >= 2 : humanCount >= 1;
  const canHostStart = isHost && minPlayersOk && allHumansReady;

  const renderHumanRow = (p: RoomPlayer) => (
    <div key={p.odId} className={`player-slot ${p.isHost ? 'host' : ''} ${p.isReady ? 'ready' : ''}`}>
      <span className="player-name">{p.nickname}</span>
      <span className="player-status">{p.isReady ? '已准备' : '未准备'}</span>
    </div>
  );

  const renderEmptySlot = (team: 'CT' | 'T', index: number) => {
    const status = currentRoom.gameState.status;
    const matchLive = status === 'playing';
    const canUseSlot = status !== 'ended';
    const isMySide = myTeam === team;
    const showClick =
      canUseSlot &&
      (matchLive ? !isInRoom : !isInRoom || !isMySide);
    return (
      <button
        type="button"
        key={`${team}-empty-${index}`}
        className="player-slot"
        disabled={!showClick}
        onClick={() => showClick && handleSlotClick(team)}
        style={{
          opacity: showClick ? 0.85 : 0.4,
          cursor: showClick ? 'pointer' : 'default',
          border: '1px dashed rgba(255,255,255,0.25)',
          background: 'rgba(0,0,0,0.2)',
          textAlign: 'left',
          width: '100%',
          font: 'inherit',
          color: 'inherit',
        }}
      >
        <span className="player-name" style={{ color: 'rgba(255,255,255,0.5)' }}>
          空位
        </span>
        <span className="player-status" style={{ fontSize: 12 }}>
          {!isInRoom
            ? matchLive
              ? '点击加入对局'
              : '点击加入'
            : isMySide
              ? '—'
              : '点击换队'}
        </span>
      </button>
    );
  };

  const renderPveEmptySlot = (index: number) => {
    const status = currentRoom.gameState.status;
    const matchLive = status === 'playing';
    const canUseSlot = status !== 'ended';
    const showClick = canUseSlot && !isInRoom;
    return (
      <button
        type="button"
        key={`pve-empty-${index}`}
        className="player-slot"
        disabled={!showClick}
        onClick={() => showClick && void handleSlotClick('CT')}
        style={{
          opacity: showClick ? 0.85 : 0.4,
          cursor: showClick ? 'pointer' : 'default',
          border: '1px dashed rgba(255,255,255,0.25)',
          background: 'rgba(0,0,0,0.2)',
          textAlign: 'left',
          width: '100%',
          font: 'inherit',
          color: 'inherit',
        }}
      >
        <span className="player-name" style={{ color: 'rgba(255,255,255,0.5)' }}>
          空位
        </span>
        <span className="player-status" style={{ fontSize: 12 }}>
          {!isInRoom ? (matchLive ? '点击加入对局' : '点击加入小队') : '—'}
        </span>
      </button>
    );
  };

  const renderTeamSlots = (team: 'CT' | 'T', humans: RoomPlayer[]) => {
    const slots: ReactNode[] = [];
    for (let i = 0; i < maxPerTeam; i++) {
      const h = humans[i];
      if (h) slots.push(renderHumanRow(h));
      else slots.push(renderEmptySlot(team, i));
    }
    return slots;
  };

  return (
    <div id="room-screen" className="screen">
      <div className="room-header">
        <div className="room-info">
          <h2>{currentRoom.name}</h2>
          <span className="room-id">房间号: <span>{currentRoom.roomId}</span></span>
        </div>
        <button className="room-btn" onClick={handleLeave}>
          {isInRoom ? '退出房间' : '返回大厅'}
        </button>
      </div>

      {socketActionError && (
        <div
          role="alert"
          style={{
            margin: '0 16px 12px',
            padding: '10px 14px',
            background: 'rgba(180, 40, 40, 0.35)',
            border: '1px solid rgba(255, 100, 100, 0.5)',
            borderRadius: 8,
            color: '#ffb3b3',
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <span>{socketActionError}</span>
          <button
            type="button"
            onClick={() => setSocketActionError('')}
            style={{
              flexShrink: 0,
              background: 'rgba(0,0,0,0.35)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: '#fff',
              borderRadius: 4,
              padding: '4px 10px',
              cursor: 'pointer',
            }}
          >
            关闭
          </button>
        </div>
      )}

      <div className="room-main">
        <div className="room-teams">
          {slotJoinError && (
            <div
              style={{
                gridColumn: '1 / -1',
                color: '#ff6a6a',
                fontSize: 13,
                marginBottom: 8,
                textAlign: 'center',
              }}
            >
              {slotJoinError}
            </div>
          )}
          {isPve ? (
            <div className="team-panel ct" style={{ flex: 1, maxWidth: 720, margin: '0 auto', width: '100%' }}>
              <h3>玩家小队（PVE）</h3>
              <div className="team-players">
                {Array.from({ length: maxSquadSlots }, (_, i) => {
                  const h = humanPlayers[i];
                  return h ? renderHumanRow(h) : renderPveEmptySlot(i);
                })}
              </div>
            </div>
          ) : (
            <>
              <div className="team-panel ct">
                <h3>CT (反恐精英)</h3>
                <div className="team-players">{renderTeamSlots('CT', ctHumans)}</div>
              </div>

              <div className="team-panel t">
                <h3>T (恐怖分子)</h3>
                <div className="team-players">{renderTeamSlots('T', tHumans)}</div>
              </div>
            </>
          )}
        </div>

        <div className="room-sidebar">
          <div className="room-settings-panel">
            <h3>房间设置</h3>
            <div className="setting-item">模式: <span>
              {currentRoom.settings.mode === '1v1' ? '1v1 单挑（仅真人）' :
               currentRoom.settings.mode === 'pvp' ? 'PVP 对战' :
               currentRoom.settings.mode === 'pve' ? 'PVE 生存' : '死斗模式'}
            </span></div>
            <div className="setting-item">地图: <span>
              {currentRoom.settings.map === 'desert' ? '沙漠2' : '仓库突袭'}
            </span></div>
            <div className="setting-item">人数: <span>{humanCount}/{currentRoom.settings.maxPlayers}</span></div>
            {is1v1 && (
              <div className="setting-item">制胜分: <span>8（先达 8 分胜）</span></div>
            )}
            {is1v1 && isHost && currentRoom.gameState.status === 'waiting' && (
              <div className="setting-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <span>每回合时长（秒，60–600，默认 120）</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="number"
                    min={60}
                    max={600}
                    value={roundTimeDraft}
                    onChange={(e) => setRoundTimeDraft(e.target.value)}
                    style={{
                      width: 100,
                      padding: '6px 8px',
                      background: 'rgba(0,0,0,0.4)',
                      border: '1px solid rgba(255,255,255,0.15)',
                      borderRadius: 4,
                      color: '#fff',
                    }}
                  />
                  <button
                    type="button"
                    className="room-btn"
                    disabled={roundTimeSaving}
                    onClick={() => void handleSaveRoundTime()}
                    style={{ padding: '6px 12px', fontSize: 13 }}
                  >
                    {roundTimeSaving ? '保存中…' : '保存'}
                  </button>
                </div>
                {roundTimeError && (
                  <span style={{ color: '#ff6a6a', fontSize: 12 }}>{roundTimeError}</span>
                )}
              </div>
            )}
            {!isPve && currentRoom.settings.mode !== '1v1' && (
            <div className="setting-item" style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
              列表仅显示真人；空位进房或换队后由 AI 自动让出位置，开战时由服务端平衡。
            </div>
            )}
            {isPve && (
            <div className="setting-item" style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
              PVE 仅显示真人小队；敌方由后续怪物生成，当前由服务端在 T 侧占位机器人。
            </div>
            )}
          </div>

          <div className="room-chat">
            <h3>房间消息</h3>
            <div className="chat-messages">
              {chatMessages.map((msg, i) => (
                <div key={i} className="chat-msg">
                  <span className="sender">{msg.sender}: </span>
                  {msg.text}
                </div>
              ))}
            </div>
            <form onSubmit={handleSendChat} style={{ marginTop: 10 }}>
              <input
                type="text"
                placeholder="发送消息..."
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                style={{ width: '100%', padding: '8px', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, color: '#fff' }}
              />
            </form>
          </div>

          <div className="room-actions">
            {!isInRoom && currentRoom.gameState.status !== 'ended' && (
              <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.55)', marginBottom: 12, fontSize: 13 }}>
                你未在本房间，请点击场上空位加入
                {currentRoom.gameState.status === 'playing' ? '（对局中仍可补位）' : ''}
              </div>
            )}
            {currentRoom.gameState.status === 'playing' ? (
              <>
                <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.75)', marginBottom: 12, fontSize: 14 }}>
                  {is1v1 ? '对局进行中，加入后可立即进入游戏' : '对局进行中，点击下方进入游戏'}
                </div>
                <button type="button" className="start-btn" onClick={handleEnterGame} disabled={!isInRoom}>
                  加入游戏
                </button>
              </>
            ) : (
              isInRoom && (
              <>
                <button
                  className={`ready-btn ${isReady ? 'ready' : ''}`}
                  onClick={handleToggleReady}
                >
                  {isReady ? '取消准备' : '准备'}
                </button>
                {isHost && (
                  <button
                    className={`start-btn ${canHostStart ? '' : 'hidden'}`}
                    onClick={handleStartGame}
                  >
                    开始游戏
                  </button>
                )}
                {isHost && !canHostStart && (
                  <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.5)', marginTop: 10, fontSize: 13 }}>
                    {humanCount < 1
                      ? '等待玩家加入。'
                      : is1v1 && humanCount < 2
                        ? '1v1 需双方到齐后才能开始。'
                        : !allHumansReady
                          ? '等待全部玩家准备（含房主）。'
                          : ''}
                  </div>
                )}
              </>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}