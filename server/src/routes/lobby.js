const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const Room = require('../models/Room');
const { auth, optionalAuth } = require('../middleware/auth');
const { isBot, rebalanceRoomBots, emitRoomPlayersUpdated, maxHumansPerTeam } = require('../services/roomBots');

// 生成房间号
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// 获取公开房间列表
router.get('/rooms', optionalAuth, async (req, res) => {
  try {
    const rooms = await Room.find({ 
      isPrivate: false,
      'gameState.status': { $ne: 'ended' }
    })
    .select('roomId name settings players gameState createdAt')
    .sort({ createdAt: -1 })
    .limit(50);
    
    res.json(rooms.map(room => ({
      roomId: room.roomId,
      name: room.name,
      mode: room.settings.mode,
      map: room.settings.map,
      maxPlayers: room.settings.maxPlayers,
      currentPlayers: room.players.length,
      gameState: room.gameState.status,
      createdAt: room.createdAt
    })));
  } catch (error) {
    console.error('获取房间列表错误:', error);
    res.status(500).json({ error: '获取失败' });
  }
});

// 搜索房间
router.get('/rooms/search/:roomId', optionalAuth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const room = await Room.findOne({ 
      roomId: roomId.toUpperCase(),
      'gameState.status': { $ne: 'ended' }
    }).select('-password');
    
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }
    
    res.json({
      roomId: room.roomId,
      name: room.name,
      mode: room.settings.mode,
      map: room.settings.map,
      maxPlayers: room.settings.maxPlayers,
      currentPlayers: room.players.length,
      gameState: room.gameState.status,
      isPrivate: room.isPrivate
    });
  } catch (error) {
    console.error('搜索房间错误:', error);
    res.status(500).json({ error: '搜索失败' });
  }
});

// 创建房间
router.post('/rooms', auth, async (req, res) => {
  try {
    const { name, password, settings } = req.body;
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: '房间名称不能为空' });
    }
    
    let roomId;
    let unique = false;
    while (!unique) {
      roomId = generateRoomId();
      const existing = await Room.findOne({ roomId });
      if (!existing) unique = true;
    }
    
    let mode = settings?.mode || 'pvp';
    if (!['pvp', 'pve', '1v1'].includes(mode)) mode = 'pvp';
    const maxPlayers = mode === '1v1' ? 2 : Math.min(16, Math.max(2, Number(settings?.maxPlayers) || 10));

    let roundTime = Number(settings?.roundTime);
    if (!Number.isFinite(roundTime) || roundTime < 60 || roundTime > 600) roundTime = 120;

    const room = new Room({
      roomId,
      name: name.substring(0, 30),
      password: password || null,
      isPrivate: !!password,
      settings: {
        mode,
        map: settings?.map || 'desert',
        maxPlayers,
        roundTime: Math.floor(roundTime),
        winScore: mode === '1v1' ? 8 : (settings?.winScore || 16),
        friendlyFire: settings?.friendlyFire || false
      },
      players: [{
        odId: req.query.socketId || '',
        playerId: req.player._id,
        nickname: req.player.nickname,
        team: 'CT',
        isReady: false,
        isHost: true,
        stats: { kills: 0, deaths: 0, score: 0, mvps: 0, damage: 0, headshots: 0 }
      }],
      gameState: {
        status: 'waiting',
        round: 0,
        ctScore: 0,
        tScore: 0
      },
      createdBy: req.player._id
    });

    rebalanceRoomBots(room);
    await room.save();
    emitRoomPlayersUpdated(room);

    res.status(201).json({
      message: '房间创建成功',
      room: {
        roomId: room.roomId,
        name: room.name,
        isPrivate: room.isPrivate,
        settings: room.settings,
        host: req.player.nickname
      }
    });
  } catch (error) {
    console.error('创建房间错误:', error);
    res.status(500).json({ error: '创建失败' });
  }
});

// 获取房间信息
router.get('/room/:roomId', optionalAuth, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId.toUpperCase() })
      .select('-password')
      .populate('players.playerId', 'nickname avatar level');
    
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }
    
    res.json({
      roomId: room.roomId,
      name: room.name,
      isPrivate: room.isPrivate,
      settings: room.settings,
      players: room.players.map(p => ({
        odId: p.odId,
        playerId: p.playerId?._id,
        nickname: p.playerId?.nickname || p.nickname,
        team: p.team,
        isReady: p.isReady,
        isHost: p.isHost,
        stats: p.stats
      })),
      gameState: room.gameState,
      createdBy: room.createdBy
    });
  } catch (error) {
    console.error('获取房间信息错误:', error);
    res.status(500).json({ error: '获取失败' });
  }
});

// 加入房间
router.post('/join/:roomId', auth, async (req, res) => {
  try {
    const { password, team: bodyTeam } = req.body;
    const roomId = req.params.roomId.toUpperCase();
    
    const room = await Room.findOne({ roomId });
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    if (room.gameState.status === 'ended') {
      return res.status(400).json({ error: '对局已结束' });
    }
    
    if (room.isPrivate && room.password !== password) {
      return res.status(403).json({ error: '密码错误' });
    }
    
    const humanCount = room.players.filter(p => !isBot(p)).length;
    if (humanCount >= room.settings.maxPlayers) {
      return res.status(400).json({ error: '房间已满' });
    }
    
    const existingPlayer = room.players.find(p => 
      p.playerId?.toString() === req.player._id.toString()
    );
    if (existingPlayer) {
      return res.status(400).json({ error: '你已在房间中' });
    }

    const maxPerTeam = maxHumansPerTeam(room);
    const humanCT = room.players.filter(p => !isBot(p) && p.team === 'CT').length;
    const humanT = room.players.filter(p => !isBot(p) && p.team === 'T').length;

    let team;
    if (room.settings.mode === 'pve') {
      if (bodyTeam === 'T') {
        return res.status(400).json({ error: 'PVE 请加入反恐小队' });
      }
      const maxSquad = Math.max(1, Number(room.settings.maxPlayers) || 10);
      if (humanCount >= maxSquad) {
        return res.status(400).json({ error: '小队已满' });
      }
      team = 'CT';
    } else if (room.settings.mode === '1v1') {
      team = humanCT <= humanT ? 'CT' : 'T';
    } else if (bodyTeam === 'CT' || bodyTeam === 'T') {
      if (bodyTeam === 'CT' && humanCT >= maxPerTeam) {
        return res.status(400).json({ error: 'CT 方已满' });
      }
      if (bodyTeam === 'T' && humanT >= maxPerTeam) {
        return res.status(400).json({ error: 'T 方已满' });
      }
      team = bodyTeam;
    } else {
      team = humanCT <= humanT ? 'CT' : 'T';
      if (team === 'CT' && humanCT >= maxPerTeam) team = 'T';
      else if (team === 'T' && humanT >= maxPerTeam) team = 'CT';
      const hCT2 = team === 'CT' ? humanCT + 1 : humanCT;
      const hT2 = team === 'T' ? humanT + 1 : humanT;
      if (hCT2 > maxPerTeam || hT2 > maxPerTeam) {
        return res.status(400).json({ error: '所选队伍已满，请指定另一队或稍后重试' });
      }
    }
    
    room.players.push({
      odId: req.query.socketId || '',
      playerId: req.player._id,
      nickname: req.player.nickname,
      team,
      isReady: false,
      isHost: false,
      stats: { kills: 0, deaths: 0, score: 0, mvps: 0, damage: 0, headshots: 0 }
    });

    rebalanceRoomBots(room);
    await room.save();
    emitRoomPlayersUpdated(room);

    res.json({
      message: '加入成功',
      room: {
        roomId: room.roomId,
        name: room.name,
        settings: room.settings,
        players: room.players.map(p => ({
          odId: p.odId,
          nickname: p.nickname,
          team: p.team,
          isReady: p.isReady,
          isHost: p.isHost
        }))
      }
    });
  } catch (error) {
    console.error('加入房间错误:', error);
    res.status(500).json({ error: '加入失败' });
  }
});

// 离开房间
router.post('/leave/:roomId', auth, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId.toUpperCase() });
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }
    
    const playerIndex = room.players.findIndex(p => 
      p.playerId?.toString() === req.player._id.toString()
    );
    
    if (playerIndex === -1) {
      return res.status(400).json({ error: '你不在房间中' });
    }
    
    // 如果是房主，转移房主或删除房间
    const isHost = room.players[playerIndex].isHost;
    room.players.splice(playerIndex, 1);
    
    if (room.players.length === 0) {
      await Room.deleteOne({ _id: room._id });
      return res.json({ message: '房间已解散' });
    }

    const realPlayers = room.players.filter(p => !isBot(p));
    if (realPlayers.length === 0) {
      await Room.deleteOne({ _id: room._id });
      return res.json({ message: '房间已解散' });
    }

    if (isHost) {
      room.players.forEach(p => { p.isHost = false; });
      realPlayers[0].isHost = true;
    }

    rebalanceRoomBots(room);
    await room.save();
    emitRoomPlayersUpdated(room);
    res.json({ message: '离开成功' });
  } catch (error) {
    console.error('离开房间错误:', error);
    res.status(500).json({ error: '离开失败' });
  }
});

// 房主：更新房间设置
router.put('/room/:roomId/settings', auth, async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId.toUpperCase() });
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }
    
    const hostPlayer = room.players.find(p => 
      p.playerId?.toString() === req.player._id.toString()
    );
    if (!hostPlayer || !hostPlayer.isHost) {
      return res.status(403).json({ error: '只有房主可以修改设置' });
    }
    
    const { settings } = req.body;
    if (settings) {
      room.settings = { ...room.settings.toObject(), ...settings };
      if (room.settings.roundTime != null) {
        const rt = Number(room.settings.roundTime);
        if (!Number.isFinite(rt) || rt < 60 || rt > 600) {
          return res.status(400).json({ error: '回合时长需在 60–600 秒之间' });
        }
        room.settings.roundTime = Math.floor(rt);
      }
      if (room.settings.mode === '1v1') {
        room.settings.maxPlayers = 2;
        room.settings.winScore = 8;
        const humans = room.players.filter(p => !isBot(p));
        if (humans.length > 2) {
          return res.status(400).json({ error: '1v1 仅支持 2 名真人，请先请离多余玩家' });
        }
      }
    }

    rebalanceRoomBots(room);
    await room.save();
    emitRoomPlayersUpdated(room);
    res.json({ message: '设置已更新', settings: room.settings });
  } catch (error) {
    console.error('更新房间设置错误:', error);
    res.status(500).json({ error: '更新失败' });
  }
});

// 房主：踢出玩家
router.post('/room/:roomId/kick', auth, async (req, res) => {
  try {
    const { playerId } = req.body;
    const room = await Room.findOne({ roomId: req.params.roomId.toUpperCase() });
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }
    
    const hostPlayer = room.players.find(p => 
      p.playerId?.toString() === req.player._id.toString()
    );
    if (!hostPlayer || !hostPlayer.isHost) {
      return res.status(403).json({ error: '只有房主可以踢人' });
    }
    
    const playerIndex = room.players.findIndex(p => 
      p.playerId?.toString() === playerId || p.odId === playerId
    );
    
    if (playerIndex === -1) {
      return res.status(404).json({ error: '玩家不在房间中' });
    }
    
    room.players.splice(playerIndex, 1);

    rebalanceRoomBots(room);
    await room.save();
    emitRoomPlayersUpdated(room);
    res.json({ message: '玩家已踢出' });
  } catch (error) {
    console.error('踢出玩家错误:', error);
    res.status(500).json({ error: '操作失败' });
  }
});

module.exports = router;