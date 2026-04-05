const Room = require('../models/Room');
const MatchRecord = require('../models/MatchRecord');
const Player = require('../models/Player');
const { isBot, rebalanceRoomBots, maxHumansPerTeam } = require('../services/roomBots');
const {
  resolveGunHitDamage,
  resolveMeleeHitDamage,
  normalizeBodyPart,
} = require('../game/hitDamage');

/** 与 REST / 数据库一致：房间号统一大写，避免 URL 小写时 findOne 失败 */
function normalizeRoomId(roomId) {
  if (roomId == null || roomId === '') return '';
  return String(roomId).trim().toUpperCase();
}

// 存储socketId到playerId的映射
const socketPlayerMap = new Map();
const playerSocketMap = new Map();

/** PVP 复活后短时无敌：socketId → { until, ox, oy, oz }（与复活包相机位一致） */
const spawnProtectBySocket = new Map();
const SPAWN_PROTECT_MS = 5000;
const SPAWN_PROTECT_MOVE_EPS_XZ = 0.14;
const SPAWN_PROTECT_MOVE_EPS_Y = 0.11;

function clearSpawnProtectForSocket(io, roomId, socketId) {
  if (!spawnProtectBySocket.has(socketId)) return;
  spawnProtectBySocket.delete(socketId);
  const rid = normalizeRoomId(roomId);
  if (rid) io.to(rid).emit('game:spawnProtectEnd', { socketId });
}

function isSpawnProtectedNow(socketId) {
  const sp = spawnProtectBySocket.get(socketId);
  if (!sp) return false;
  if (Date.now() >= sp.until) {
    spawnProtectBySocket.delete(socketId);
    return false;
  }
  return true;
}

function setupSocket(io) {
  io.on('connection', (socket) => {
    console.log(`玩家连接: ${socket.id}`);

    // 玩家认证
    socket.on('auth', async (data) => {
      try {
        const { playerId, token } = data;
        if (playerId && token) {
          socketPlayerMap.set(socket.id, playerId);
          playerSocketMap.set(playerId, socket.id);
          socket.playerId = playerId;
          console.log(`玩家 ${playerId} 认证成功`);
        }
      } catch (error) {
        console.error('认证错误:', error);
      }
    });

    // 加入房间
    socket.on('room:join', async (data) => {
      try {
        const roomId = normalizeRoomId(data?.roomId);
        const playerId = socket.playerId;
        
        if (!playerId) {
          socket.emit('room:error', { message: '请先登录' });
          return;
        }
        if (!roomId) {
          socket.emit('room:error', { message: '房间参数无效' });
          return;
        }

        const room = await Room.findOne({ roomId });
        if (!room) {
          socket.emit('room:error', { message: '房间不存在' });
          return;
        }

        // 加入房间socket room
        socket.join(roomId);
        
        // 更新socket绑定
        const player = room.players.find(p => p.playerId?.toString() === playerId);
        if (player) {
          player.odId = socket.id;
        }
        await room.save();

        // 通知房间内所有玩家
        io.to(roomId).emit('room:playerJoined', {
          socketId: socket.id,
          playerId: playerId,
          players: room.players.map(p => ({
            odId: p.odId,
            playerId: p.playerId?.toString(),
            nickname: p.nickname,
            team: p.team,
            isReady: p.isReady,
            isHost: p.isHost
          }))
        });
      } catch (error) {
        console.error('加入房间错误:', error);
        socket.emit('room:error', { message: '加入房间失败' });
      }
    });

    // 离开房间
    socket.on('room:leave', async (data) => {
      try {
        const roomId = normalizeRoomId(data?.roomId);
        const playerId = socket.playerId;
        if (!roomId) return;

        const room = await Room.findOne({ roomId });
        if (!room) return;

        const playerIndex = room.players.findIndex(p =>
          p.playerId?.toString() === playerId || p.odId === socket.id
        );

        if (playerIndex === -1) {
          socket.leave(roomId);
          return;
        }

        const isHost = room.players[playerIndex].isHost;
        room.players.splice(playerIndex, 1);

        const realPlayers = room.players.filter(p => !isBot(p));

        if (room.players.length === 0 || realPlayers.length === 0) {
          await Room.deleteOne({ _id: room._id });
          io.to(roomId).emit('room:closed', { reason: isHost ? '房主离开' : '房间已解散' });
          socket.leave(roomId);
          return;
        }

        if (isHost) {
          room.players.forEach(p => { p.isHost = false; });
          realPlayers[0].isHost = true;
        }

        rebalanceRoomBots(room);
        await room.save();

        socket.leave(roomId);
        io.to(roomId).emit('room:playerLeft', {
          socketId: socket.id,
          players: room.players.map(p => ({
            odId: p.odId,
            playerId: p.playerId?.toString(),
            nickname: p.nickname,
            team: p.team,
            isReady: p.isReady,
            isHost: p.isHost
          }))
        });
      } catch (error) {
        console.error('离开房间错误:', error);
      }
    });

    // 准备/取消准备
    socket.on('room:ready', async (data) => {
      try {
        const roomId = normalizeRoomId(data?.roomId);
        const { isReady } = data;
        const playerId = socket.playerId;
        if (!roomId) return;

        const room = await Room.findOne({ roomId });
        if (!room) return;

        const player = room.players.find(p => 
          p.playerId?.toString() === playerId
        );
        if (player) {
          player.isReady = isReady;
          await room.save();
        }

        io.to(roomId).emit('room:playerReady', {
          socketId: socket.id,
          isReady: isReady,
          players: room.players.map(p => ({
            odId: p.odId,
            playerId: p.playerId?.toString(),
            nickname: p.nickname,
            team: p.team,
            isReady: p.isReady,
            isHost: p.isHost
          }))
        });
      } catch (error) {
        console.error('准备状态错误:', error);
      }
    });

    // 切换队伍
    socket.on('room:switchTeam', async (data) => {
      try {
        const roomId = normalizeRoomId(data?.roomId);
        const { team } = data;
        const playerId = socket.playerId;
        if (!roomId) return;

        const room = await Room.findOne({ roomId });
        if (!room) return;

        const player = room.players.find(p =>
          p.playerId?.toString() === playerId
        );
        if (!player || (team !== 'CT' && team !== 'T')) return;

        const maxPerTeam = maxHumansPerTeam(room);
        let hCT = room.players.filter(p => !isBot(p) && p.team === 'CT').length;
        let hT = room.players.filter(p => !isBot(p) && p.team === 'T').length;
        if (player.team === 'CT') hCT -= 1;
        if (player.team === 'T') hT -= 1;
        if (team === 'CT' && hCT + 1 > maxPerTeam) {
          socket.emit('room:error', { message: 'CT 方已满' });
          return;
        }
        if (team === 'T' && hT + 1 > maxPerTeam) {
          socket.emit('room:error', { message: 'T 方已满' });
          return;
        }

        player.team = team;
        rebalanceRoomBots(room);
        await room.save();

        io.to(roomId).emit('room:teamChanged', {
          socketId: socket.id,
          team: team,
          players: room.players.map(p => ({
            odId: p.odId,
            playerId: p.playerId?.toString(),
            nickname: p.nickname,
            team: p.team,
            isReady: p.isReady,
            isHost: p.isHost
          }))
        });
      } catch (error) {
        console.error('切换队伍错误:', error);
      }
    });

    // 开始游戏 (房主)
    socket.on('game:start', async (data) => {
      try {
        const roomId = normalizeRoomId(data?.roomId);
        const playerId = socket.playerId;
        console.log(`game:start 接收 - roomId: ${roomId}, playerId: ${playerId}, socket.id: ${socket.id}`);

        if (!playerId) {
          socket.emit('game:error', { message: '请先登录后再开始游戏' });
          return;
        }
        if (!roomId) {
          socket.emit('game:error', { message: '房间参数无效' });
          return;
        }

        const room = await Room.findOne({ roomId });
        if (!room) {
          socket.emit('game:error', { message: '房间不存在' });
          return;
        }

        if (room.gameState.status === 'playing') {
          socket.emit('game:error', { message: '对局已在进行中' });
          return;
        }

        const host = room.players.find(p => p.isHost);
        console.log('房主:', host);

        if (!host || host.playerId?.toString() !== playerId) {
          socket.emit('game:error', { message: '只有房主可以开始游戏' });
          return;
        }

        const humans = room.players.filter(p => !isBot(p));
        if (room.settings.mode === '1v1' && humans.length < 2) {
          socket.emit('game:error', { message: '1v1 模式需要双方玩家到齐后才能开始' });
          return;
        }

        // 房主可以直接开始 (跳过准备检查)
        console.log('所有玩家:', room.players.map(p => ({ nickname: p.nickname, isReady: p.isReady, isHost: p.isHost })));

        // 开始游戏
        room.gameState.status = 'playing';
        room.gameState.round = 1;
        room.gameState.startTime = new Date();
        room.players.forEach((p) => {
          p.health = 100;
        });
        room.markModified('players');
        await room.save();

        io.to(roomId).emit('game:started', {
          round: room.gameState.round,
          settings: room.settings,
          gameState: {
            status: room.gameState.status,
            round: room.gameState.round,
            ctScore: room.gameState.ctScore,
            tScore: room.gameState.tScore,
            startTime: room.gameState.startTime
          }
        });

        console.log(`房间 ${roomId} 游戏开始`);
      } catch (error) {
        console.error('开始游戏错误:', error);
        socket.emit('game:error', { message: '开始游戏失败，请稍后重试' });
      }
    });

    // 对局结束（如客户端 PVP 时间到）：回到房间可再次开局，将 gameState 置为 waiting
    socket.on('game:returnToRoom', async (data, ack) => {
      const reply = (payload) => {
        if (typeof ack === 'function') ack(payload);
      };
      try {
        const roomId = normalizeRoomId(data?.roomId);
        const playerId = socket.playerId;
        if (!roomId || !playerId) {
          return reply({ ok: false, error: '参数无效' });
        }
        const room = await Room.findOne({ roomId });
        if (!room) {
          return reply({ ok: false, error: '房间不存在' });
        }
        const inRoom = room.players.some(
          (p) => p.playerId && p.playerId.toString() === playerId.toString()
        );
        if (!inRoom) {
          return reply({ ok: false, error: '不在房间内' });
        }
        if (room.gameState.status === 'waiting') {
          io.to(roomId).emit('room:gameStateUpdated', {
            gameState: {
              status: room.gameState.status,
              round: room.gameState.round,
              ctScore: room.gameState.ctScore,
              tScore: room.gameState.tScore,
              startTime: room.gameState.startTime
            }
          });
          return reply({ ok: true });
        }
        room.gameState.status = 'waiting';
        room.gameState.round = 0;
        room.gameState.ctScore = 0;
        room.gameState.tScore = 0;
        room.gameState.startTime = undefined;
        room.gameState.endTime = undefined;
        await room.save();
        io.to(roomId).emit('room:gameStateUpdated', {
          gameState: {
            status: room.gameState.status,
            round: room.gameState.round,
            ctScore: room.gameState.ctScore,
            tScore: room.gameState.tScore,
            startTime: room.gameState.startTime
          }
        });
        return reply({ ok: true });
      } catch (error) {
        console.error('game:returnToRoom 错误:', error);
        return reply({ ok: false, error: '服务器错误' });
      }
    });

    // 玩家移动同步
    socket.on('game:playerMove', (data) => {
      const roomId = normalizeRoomId(data?.roomId);
      const { position, rotation, weapon } = data || {};
      if (!roomId) return;
      const sp = spawnProtectBySocket.get(socket.id);
      if (sp && Date.now() < sp.until && position && ['x', 'y', 'z'].every((k) => Number.isFinite(Number(position[k])))) {
        const px = Number(position.x);
        const py = Number(position.y);
        const pz = Number(position.z);
        if (sp.ox == null || sp.oy == null || sp.oz == null) {
          sp.ox = px;
          sp.oy = py;
          sp.oz = pz;
        } else {
          const dx = px - sp.ox;
          const dz = pz - sp.oz;
          const dy = py - sp.oy;
          if (Math.hypot(dx, dz) > SPAWN_PROTECT_MOVE_EPS_XZ || Math.abs(dy) > SPAWN_PROTECT_MOVE_EPS_Y) {
            clearSpawnProtectForSocket(io, roomId, socket.id);
          }
        }
      } else if (sp && Date.now() >= sp.until) {
        spawnProtectBySocket.delete(socket.id);
      }
      const moved = {
        socketId: socket.id,
        position,
        rotation
      };
      if (weapon != null && weapon !== '') moved.weapon = String(weapon);
      socket.to(roomId).emit('game:playerMoved', moved);
    });

    // 开火事件
    socket.on('game:shoot', (data) => {
      const roomId = normalizeRoomId(data?.roomId);
      const { weapon, position, direction } = data || {};
      if (!roomId) return;
      if (isSpawnProtectedNow(socket.id)) {
        clearSpawnProtectForSocket(io, roomId, socket.id);
      }
      socket.to(roomId).emit('game:playerShot', {
        socketId: socket.id,
        weapon,
        position,
        direction,
        timestamp: Date.now()
      });
    });

    /** 客户端实弹射击（与 game:shoot 同步接入时可二选一；当前 iframe 仅发此事件用于取消复活无敌） */
    socket.on('game:spawnProtectShoot', (data) => {
      const roomId = normalizeRoomId(data?.roomId);
      if (!roomId) return;
      if (isSpawnProtectedNow(socket.id)) {
        clearSpawnProtectForSocket(io, roomId, socket.id);
      }
    });

    // 命中事件（伤害仅服务端按武器/部位/距离/穿木计算，不信任客户端 damage）
    socket.on('game:hit', async (data) => {
      try {
        const roomId = normalizeRoomId(data?.roomId);
        const {
          targetId,
          weapon,
          hitType,
          bodyPart,
          distanceMeters,
          throughWood,
          meleeKind,
        } = data || {};
        if (!roomId) return;

        const room = await Room.findOne({ roomId });
        if (!room) return;

        const sid = String(socket.id || '');
        const tid = String(targetId || '');
        const attacker = room.players.find(p => String(p.odId || '') === sid);
        const target = room.players.find(p => String(p.odId || '') === tid);

        if (!attacker || !target || String(attacker.odId || '') === String(target.odId || '')) return;

        if (!room.settings.friendlyFire && attacker.team === target.team) return;

        if (isSpawnProtectedNow(tid)) return;

        const weaponName = String(weapon || '');
        const ht = String(hitType || '');

        let dmg = 0;
        let resolvedHitType = 'body';

        if (ht === 'melee' || weaponName === 'Knife') {
          const r = resolveMeleeHitDamage(weaponName, meleeKind);
          dmg = r.damage;
          resolvedHitType = r.hitType;
        } else {
          let part =
            bodyPart != null && String(bodyPart) !== ''
              ? normalizeBodyPart(bodyPart)
              : null;
          if (part == null) {
            part = ht === 'headshot' ? 'head' : 'torso';
          }
          const dist = Number(distanceMeters);
          const r = resolveGunHitDamage(
            weaponName,
            part,
            Number.isFinite(dist) ? dist : 0,
            !!throughWood
          );
          dmg = r.damage;
          resolvedHitType = r.hitType;
        }

        dmg = Math.max(0, Math.floor(dmg));
        if (dmg <= 0) return;

        attacker.stats.damage += dmg;

        let hp = target.health != null ? Number(target.health) : 100;
        if (!Number.isFinite(hp)) hp = 100;
        hp = Math.max(0, Math.floor(hp - dmg));
        target.health = hp;

        const payload = {
          attackerId: socket.id,
          targetId: tid,
          damage: dmg,
          weapon: weaponName,
          hitType: resolvedHitType,
          remainingHealth: hp,
          killed: hp <= 0,
          attackerStats: attacker.stats,
          targetStats: target.stats
        };

        if (hp <= 0) {
          target.stats.deaths += 1;
          attacker.stats.kills += 1;
          attacker.stats.score += (resolvedHitType === 'headshot' ? 300 : 100);
        }

        /** 嵌套 players[].health 变更必须标记，否则 save 不写库，每枪都像从满血起算 → 永远打不死 */
        room.markModified('players');
        await room.save();
        io.to(roomId).emit('game:playerHit', payload);
      } catch (error) {
        console.error('命中事件错误:', error);
      }
    });

    /** 客户端复活后同步服务端血量，便于后续受击结算 */
    socket.on('game:playerRespawn', async (data) => {
      try {
        const roomId = normalizeRoomId(data?.roomId);
        if (!roomId) return;
        const { position, rotation } = data || {};
        const room = await Room.findOne({ roomId });
        if (!room) return;
        const p = room.players.find((x) => String(x.odId || '') === String(socket.id || ''));
        if (p) {
          p.health = 100;
          room.markModified('players');
          await room.save();
          const posOk =
            position &&
            ['x', 'y', 'z'].every((k) => Number.isFinite(Number(position[k])));
          const rotOk =
            rotation &&
            ['x', 'y', 'z', 'w'].every((k) => Number.isFinite(Number(rotation[k])));
          const respPayload = { socketId: socket.id, spawnProtect: true };
          if (posOk && rotOk) {
            const pos = {
              x: Number(position.x),
              y: Number(position.y),
              z: Number(position.z),
            };
            const rot = {
              x: Number(rotation.x),
              y: Number(rotation.y),
              z: Number(rotation.z),
              w: Number(rotation.w),
            };
            respPayload.position = pos;
            respPayload.rotation = rot;
            const until = Date.now() + SPAWN_PROTECT_MS;
            spawnProtectBySocket.set(socket.id, {
              until: until,
              ox: pos.x,
              oy: pos.y,
              oz: pos.z,
            });
            io.to(roomId).emit('game:playerMoved', {
              socketId: socket.id,
              position: pos,
              rotation: rot,
            });
          } else {
            const until = Date.now() + SPAWN_PROTECT_MS;
            spawnProtectBySocket.set(socket.id, {
              until: until,
              ox: null,
              oy: null,
              oz: null,
            });
          }
          io.to(roomId).emit('game:playerRespawned', respPayload);
        }
      } catch (error) {
        console.error('game:playerRespawn 错误:', error);
      }
    });

    // 回合结束
    socket.on('game:roundEnd', async (data) => {
      try {
        const roomId = normalizeRoomId(data?.roomId);
        const { winner } = data || {};
        if (!roomId) return;

        const room = await Room.findOne({ roomId });
        if (!room) return;

        if (winner === 'CT') {
          room.gameState.ctScore += 1;
        } else if (winner === 'T') {
          room.gameState.tScore += 1;
        }

        // 检查是否获胜
        if (room.gameState.ctScore >= room.settings.winScore || 
            room.gameState.tScore >= room.settings.winScore) {
          room.gameState.status = 'ended';
          room.gameState.endTime = new Date();
          
          // 记录战绩
          await recordMatchResult(room);
          
          io.to(roomId).emit('game:ended', {
            winner: winner,
            ctScore: room.gameState.ctScore,
            tScore: room.gameState.tScore
          });
        } else {
          room.gameState.round += 1;
          io.to(roomId).emit('game:roundEnded', {
            winner: winner,
            round: room.gameState.round,
            ctScore: room.gameState.ctScore,
            tScore: room.gameState.tScore
          });
        }

        await room.save();
      } catch (error) {
        console.error('回合结束错误:', error);
      }
    });

    // 断开连接
    socket.on('disconnect', async () => {
      console.log(`玩家断开: ${socket.id}`);
      spawnProtectBySocket.delete(socket.id);

      const playerId = socketPlayerMap.get(socket.id);
      if (playerId) {
        playerSocketMap.delete(playerId);
        socketPlayerMap.delete(socket.id);

        // 从所有房间中移除该玩家（含对局中掉线；否则真人仍占坑，只剩机器人时房间无法删除）
        const rooms = await Room.find({ 'players.odId': socket.id });

        for (const room of rooms) {
          const playerIndex = room.players.findIndex(p => p.odId === socket.id);
          if (playerIndex === -1) continue;

          const isHost = room.players[playerIndex].isHost;
          room.players.splice(playerIndex, 1);

          const realPlayers = room.players.filter(p => !isBot(p));

          if (room.players.length === 0 || realPlayers.length === 0) {
            await Room.deleteOne({ _id: room._id });
            io.to(room.roomId).emit('room:closed', { reason: isHost ? '房主离开' : '房间已解散' });
            continue;
          }

          if (isHost) {
            room.players.forEach(p => { p.isHost = false; });
            realPlayers[0].isHost = true;
          }

          rebalanceRoomBots(room);
          await room.save();

          io.to(room.roomId).emit('room:playerLeft', {
            socketId: socket.id,
            players: room.players.map(p => ({
              odId: p.odId,
              playerId: p.playerId?.toString(),
              nickname: p.nickname,
              team: p.team,
              isReady: p.isReady,
              isHost: p.isHost
            }))
          });
        }
      }
    });
  });
}

// 记录比赛结果
async function recordMatchResult(room) {
  try {
    const matchRecord = new MatchRecord({
      roomId: room._id,
      roomName: room.name,
      mode: room.settings.mode,
      map: room.settings.map,
      players: room.players.map(p => ({
        playerId: p.playerId,
        nickname: p.nickname,
        team: p.team,
        kills: p.stats.kills,
        deaths: p.stats.deaths,
        score: p.stats.score,
        mvps: p.stats.mvps,
        headshots: 0,
        damage: p.stats.damage
      })),
      result: {
        winner: room.gameState.ctScore > room.gameState.tScore ? 'CT' : 
                room.gameState.tScore > room.gameState.ctScore ? 'T' : 'draw',
        ctScore: room.gameState.ctScore,
        tScore: room.gameState.tScore
      },
      duration: room.gameState.endTime && room.gameState.startTime
        ? Math.floor((room.gameState.endTime - room.gameState.startTime) / 1000)
        : 0,
      playedAt: new Date()
    });

    await matchRecord.save();

    // 更新玩家战绩
    for (const player of room.players) {
      if (player.playerId) {
        const playerDoc = await Player.findById(player.playerId);
        if (playerDoc) {
          playerDoc.stats.totalKills += player.stats.kills;
          playerDoc.stats.totalDeaths += player.stats.deaths;
          
          const isWinner = (player.team === 'CT' && room.gameState.ctScore > room.gameState.tScore) ||
                          (player.team === 'T' && room.gameState.tScore > room.gameState.ctScore);
          
          if (isWinner) {
            playerDoc.stats.totalWins += 1;
            playerDoc.coins += Math.floor(player.stats.score * 0.1);
          } else {
            playerDoc.stats.totalLosses += 1;
          }
          
          await playerDoc.save();
        }
      }
    }

    console.log(`比赛记录已保存: ${room.roomId}`);
  } catch (error) {
    console.error('记录比赛结果错误:', error);
  }
}

module.exports = { setupSocket };