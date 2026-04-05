import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useGameStore } from '../hooks/useGameStore';
import socketService from '../services/socket';

export default function Lobby() {
  const { player, logout } = useAuth();
  const navigate = useNavigate();
  const { rooms, isLoadingRooms, loadRooms, searchRooms, joinRoom, createRoom } = useGameStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [createData, setCreateData] = useState({
    name: '',
    password: '',
    mode: 'pvp',
    map: 'desert',
    maxPlayers: 10
  });
  const [joinData, setJoinData] = useState<{ roomId: string; password: string; team: 'auto' | 'CT' | 'T' }>({
    roomId: '',
    password: '',
    team: 'auto',
  });
  const [error, setError] = useState('');

  useEffect(() => {
    loadRooms();
    const interval = setInterval(loadRooms, 5000);
    return () => clearInterval(interval);
  }, [loadRooms]);

  useEffect(() => {
    const handleRoomUpdate = () => loadRooms();
    socketService.on('lobby:rooms', handleRoomUpdate);
    return () => socketService.off('lobby:rooms', handleRoomUpdate);
  }, [loadRooms]);

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    searchRooms(e.target.value);
  };

  const handleCreateRoom = async () => {
    if (!createData.name.trim()) {
      setError('请输入房间名称');
      return;
    }
    setError('');
    try {
      const roomId = await createRoom({
        name: createData.name,
        password: createData.password || undefined,
        settings: {
          mode: createData.mode as any,
          map: createData.map,
          maxPlayers: createData.mode === '1v1' ? 2 : createData.maxPlayers
        }
      });
      setShowCreateModal(false);
      navigate(`/room/${roomId}`);
    } catch (err: any) {
      setError(err.response?.data?.error || '创建失败');
    }
  };

  const handleJoinRoom = async () => {
    if (!joinData.roomId.trim()) {
      setError('请输入房间号');
      return;
    }
    setError('');
    try {
      await joinRoom(
        joinData.roomId,
        joinData.password || undefined,
        joinData.team === 'auto' ? undefined : joinData.team
      );
      setShowJoinModal(false);
      navigate(`/room/${joinData.roomId.toUpperCase()}`);
    } catch (err: any) {
      setError(err.response?.data?.error || '加入失败');
    }
  };

  const handleQuickJoin = async () => {
    if (rooms.length === 0) {
      setShowCreateModal(true);
      return;
    }
    const availableRoom =
      rooms.find((r) => r.gameState === 'waiting' && r.currentPlayers < r.maxPlayers) ??
      rooms.find((r) => r.gameState === 'playing' && r.currentPlayers < r.maxPlayers);
    if (availableRoom) {
      await joinRoom(availableRoom.roomId);
      navigate(`/room/${availableRoom.roomId}`);
    } else {
      setShowCreateModal(true);
    }
  };

  return (
    <div id="lobby-screen" className="screen">
      <div className="lobby-header">
        <div className="lobby-user">
          <span className="user-name">{player?.nickname || player?.username}</span>
          <span className="user-level">Lv.{player?.level || 1}</span>
          <span className="user-coins">💰 {player?.coins || 1000}</span>
        </div>
        <div>
          <button className="lobby-btn" onClick={() => setShowCreateModal(true)}>创建房间</button>
          <button className="lobby-btn" onClick={() => setShowJoinModal(true)}>加入房间</button>
          <button className="lobby-btn" onClick={logout}>退出登录</button>
        </div>
      </div>

      <div className="lobby-main">
        <div className="lobby-sidebar">
          <div className="server-status">
            <h3>服务器状态</h3>
            <div className="status-item">在线玩家: <span>{rooms.reduce((sum, r) => sum + r.currentPlayers, 0)}</span></div>
            <div className="status-item">房间数: <span>{rooms.length}</span></div>
          </div>
          <div className="quick-join">
            <button className="quick-btn" onClick={handleQuickJoin}>快速加入</button>
          </div>
        </div>

        <div className="lobby-content">
          <div className="room-list-header">
            <h3>房间列表</h3>
            <input
              type="text"
              id="room-search"
              placeholder="搜索房间号..."
              value={searchQuery}
              onChange={handleSearch}
            />
          </div>

          <div className="room-list">
            {isLoadingRooms ? (
              <div className="room-empty">加载中...</div>
            ) : rooms.length === 0 ? (
              <div className="room-empty">暂无房间，点击创建房间开始游戏</div>
            ) : (
              rooms.map(room => (
                <div key={room.roomId} className="room-item" onClick={() => navigate(`/room/${room.roomId}`)}>
                  <div className="room-info">
                    <h4>{room.name}</h4>
                    <span>{room.map === 'desert' ? '沙漠2' : room.map === 'warehouse' ? '仓库突袭' : room.map}</span>
                  </div>
                  <div className="room-players">{room.currentPlayers}/{room.maxPlayers}</div>
                  <div className="room-mode">
                    {room.mode === '1v1' ? '1v1' : room.mode === 'pvp' ? 'PVP' : room.mode === 'pve' ? 'PVE' : '死斗'}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Create Room Modal */}
      {showCreateModal && (
        <div className="modal" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h2>创建房间</h2>
            <div className="form-group">
              <label>房间名称</label>
              <input
                type="text"
                placeholder="我的房间"
                value={createData.name}
                onChange={e => setCreateData({ ...createData, name: e.target.value })}
                maxLength={30}
              />
            </div>
            <div className="form-group">
              <label>密码 (留空为公开)</label>
              <input
                type="password"
                placeholder="可选"
                value={createData.password}
                onChange={e => setCreateData({ ...createData, password: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>游戏模式</label>
              <select
                value={createData.mode}
                onChange={e => setCreateData({ ...createData, mode: e.target.value })}
              >
                <option value="pvp">PVP 对战（可补 AI）</option>
                <option value="1v1">1v1 单挑（仅真人，固定 2 人）</option>
                <option value="pve">PVE 生存</option>
                <option value="deathmatch">死斗模式</option>
              </select>
            </div>
            <div className="form-group">
              <label>地图</label>
              <select
                value={createData.map}
                onChange={e => setCreateData({ ...createData, map: e.target.value })}
              >
                <option value="desert">沙漠2</option>
                <option value="warehouse">仓库突袭</option>
              </select>
            </div>
            {createData.mode !== '1v1' && (
            <div className="form-group">
              <label>最大人数</label>
              <select
                value={createData.maxPlayers}
                onChange={e => setCreateData({ ...createData, maxPlayers: parseInt(e.target.value) })}
              >
                <option value={4}>4人</option>
                <option value={6}>6人</option>
                <option value={8}>8人</option>
                <option value={10}>10人</option>
              </select>
            </div>
            )}
            {error && <div className="auth-error">{error}</div>}
            <div className="modal-actions">
              <button className="modal-btn primary" onClick={handleCreateRoom}>创建</button>
              <button className="modal-btn" onClick={() => setShowCreateModal(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* Join Room Modal */}
      {showJoinModal && (
        <div className="modal" onClick={() => setShowJoinModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h2>加入房间</h2>
            <div className="form-group">
              <label>房间号</label>
              <input
                type="text"
                placeholder="输入房间号"
                value={joinData.roomId}
                onChange={e => setJoinData({ ...joinData, roomId: e.target.value.toUpperCase() })}
                maxLength={6}
              />
            </div>
            <div className="form-group">
              <label>密码 (公开房间留空)</label>
              <input
                type="password"
                placeholder="可选"
                value={joinData.password}
                onChange={e => setJoinData({ ...joinData, password: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>加入位置（PVP 可进房后再点空位；也可在此预选）</label>
              <select
                value={joinData.team}
                onChange={e => setJoinData({ ...joinData, team: e.target.value as 'auto' | 'CT' | 'T' })}
              >
                <option value="auto">自动分配队伍</option>
                <option value="CT">反恐精英 CT</option>
                <option value="T">恐怖分子 T</option>
              </select>
            </div>
            {error && <div className="auth-error">{error}</div>}
            <div className="modal-actions">
              <button className="modal-btn primary" onClick={handleJoinRoom}>加入</button>
              <button className="modal-btn" onClick={() => setShowJoinModal(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}