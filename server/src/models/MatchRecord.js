const mongoose = require('mongoose');

const playerStatsSchema = new mongoose.Schema({
  playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' },
  nickname: String,
  team: String,
  kills: { type: Number, default: 0 },
  deaths: { type: Number, default: 0 },
  score: { type: Number, default: 0 },
  mvps: { type: Number, default: 0 },
  headshots: { type: Number, default: 0 },
  damage: { type: Number, default: 0 }
}, { _id: false });

const matchRecordSchema = new mongoose.Schema({
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
  roomName: String,
  mode: String,
  map: String,
  players: [playerStatsSchema],
  result: {
    winner: { type: String, enum: ['CT', 'T', 'draw', 'PVE'] },
    ctScore: { type: Number, default: 0 },
    tScore: { type: Number, default: 0 }
  },
  duration: { type: Number, default: 0 },
  playedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// 索引
matchRecordSchema.index({ playedAt: -1 });
matchRecordSchema.index({ 'players.playerId': 1 });

module.exports = mongoose.model('MatchRecord', matchRecordSchema);