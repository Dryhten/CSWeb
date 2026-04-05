/**
 * 房间内机器人：用 AI 填满每队空位，使 CT/T 人数均为 min(5, floor(maxPlayers/2))；
 * 真人加入时通过重新平衡减少机器人，保持总数不超过 maxPlayers。
 */

let ioInstance = null;

function setIo(io) {
  ioInstance = io;
}

function isBot(p) {
  return p && typeof p.nickname === 'string' && p.nickname.startsWith('_bot_');
}

/** 每队真人上限（与 rebalanceRoomBots 中 maxPerTeam 一致；1v1 为 1） */
function maxHumansPerTeam(room) {
  if (room.settings?.mode === '1v1') return 1;
  const maxPlayers = Math.max(2, Number(room.settings?.maxPlayers) || 10);
  return Math.min(5, Math.floor(maxPlayers / 2));
}

const BOT_NAMES = [
  '_bot_Alpha', '_bot_Bravo', '_bot_Charlie', '_bot_Delta', '_bot_Echo',
  '_bot_Foxtrot', '_bot_Golf', '_bot_Hotel', '_bot_India', '_bot_Juliet',
  '_bot_Kilo', '_bot_Lima'
];

function mapPlayerForEmit(p) {
  return {
    odId: p.odId,
    playerId: p.playerId != null ? p.playerId.toString() : null,
    nickname: p.nickname,
    team: p.team,
    isReady: p.isReady,
    isHost: p.isHost
  };
}

/**
 * 重新计算并替换 room.players（先保留所有真人，再按每队名额补机器人）
 * 模式 1v1：仅真人，不补机器人，上限 2 人由 maxPlayers 与 join 校验保证
 */
function rebalanceRoomBots(room) {
  if (room.settings?.mode === '1v1') {
    const humans = room.players.filter(p => !isBot(p));
    room.players = humans;
    room.settings.maxPlayers = 2;
    return;
  }

  /** PVE：真人仅 CT 小队；T 侧仅机器人占位（后续可替换为怪物） */
  if (room.settings?.mode === 'pve') {
    const maxPlayers = Math.max(2, Number(room.settings?.maxPlayers) || 10);
    const maxPerTeam = Math.min(5, Math.floor(maxPlayers / 2));
    const humans = room.players.filter(p => !isBot(p));
    humans.forEach((h) => { h.team = 'CT'; });
    let botsT = Math.max(0, maxPerTeam);
    while (humans.length + botsT > maxPlayers && botsT > 0) botsT -= 1;
    const ts = Date.now();
    const bots = [];
    for (let i = 0; i < botsT; i++) {
      bots.push({
        odId: `bot_${ts}_T_${i}_${Math.random().toString(36).slice(2, 10)}`,
        playerId: null,
        nickname: BOT_NAMES[i % BOT_NAMES.length],
        team: 'T',
        isReady: true,
        isHost: false,
        stats: { kills: 0, deaths: 0, score: 0, mvps: 0, damage: 0, headshots: 0 }
      });
    }
    room.players = [...humans, ...bots];
    return;
  }

  const maxPlayers = Math.max(2, Number(room.settings?.maxPlayers) || 10);
  const maxPerTeam = maxHumansPerTeam(room);

  const humans = room.players.filter(p => !isBot(p));
  const realCT = humans.filter(p => p.team === 'CT').length;
  const realT = humans.filter(p => p.team === 'T').length;

  let botsCT = Math.max(0, maxPerTeam - realCT);
  let botsT = Math.max(0, maxPerTeam - realT);

  while (humans.length + botsCT + botsT > maxPlayers) {
    if (botsCT >= botsT && botsCT > 0) botsCT -= 1;
    else if (botsT > 0) botsT -= 1;
    else break;
  }

  const ts = Date.now();
  let nameIdx = 0;
  const bots = [];

  function addBot(team, i) {
    bots.push({
      odId: `bot_${ts}_${team}_${i}_${Math.random().toString(36).slice(2, 10)}`,
      playerId: null,
      nickname: BOT_NAMES[nameIdx % BOT_NAMES.length],
      team,
      isReady: true,
      isHost: false,
      stats: { kills: 0, deaths: 0, score: 0, mvps: 0, damage: 0, headshots: 0 }
    });
    nameIdx += 1;
  }

  for (let i = 0; i < botsCT; i++) addBot('CT', i);
  for (let i = 0; i < botsT; i++) addBot('T', i);

  room.players = [...humans, ...bots];
}

function emitRoomPlayersUpdated(room) {
  if (!ioInstance || !room || !room.roomId) return;
  ioInstance.to(room.roomId).emit('room:playerJoined', {
    socketId: null,
    playerId: null,
    players: room.players.map(mapPlayerForEmit)
  });
}

module.exports = {
  setIo,
  isBot,
  maxHumansPerTeam,
  rebalanceRoomBots,
  emitRoomPlayersUpdated
};
