const mongoose = require('mongoose');

const playerInRoomSchema = new mongoose.Schema({
  odId: String,
  playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' },
  nickname: String,
  team: {
    type: String,
    enum: ['CT', 'T', 'spectator'],
    default: 'T'
  },
  isReady: {
    type: Boolean,
    default: false
  },
  isHost: {
    type: Boolean,
    default: false
  },
  /** 对局内血量（PVP），开局与复活时置满 */
  health: {
    type: Number,
    default: 100
  },
  stats: {
    kills: { type: Number, default: 0 },
    deaths: { type: Number, default: 0 },
    score: { type: Number, default: 0 },
    mvps: { type: Number, default: 0 },
    damage: { type: Number, default: 0 }
  }
}, { _id: false });

const roomSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true,
    maxlength: 30
  },
  password: {
    type: String,
    default: null
  },
  isPrivate: {
    type: Boolean,
    default: false
  },
  settings: {
    mode: {
      type: String,
      enum: ['pvp', 'pve', '1v1'],
      default: 'pvp'
    },
    map: {
      type: String,
      default: 'desert'
    },
    maxPlayers: {
      type: Number,
      default: 10,
      min: 2,
      max: 16
    },
    roundTime: {
      type: Number,
      default: 120
    },
    winScore: {
      type: Number,
      default: 16
    },
    friendlyFire: {
      type: Boolean,
      default: false
    }
  },
  players: [playerInRoomSchema],
  gameState: {
    status: {
      type: String,
      enum: ['waiting', 'playing', 'ended'],
      default: 'waiting'
    },
    round: {
      type: Number,
      default: 0
    },
    ctScore: {
      type: Number,
      default: 0
    },
    tScore: {
      type: Number,
      default: 0
    },
    startTime: Date,
    endTime: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Player'
  }
}, {
  timestamps: true
});

// 索引
roomSchema.index({ isPrivate: 1 });
roomSchema.index({ 'gameState.status': 1 });

module.exports = mongoose.model('Room', roomSchema);