const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const playerSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 20
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  nickname: {
    type: String,
    default: function() { return this.username; }
  },
  avatar: {
    type: String,
    default: '/assets/avatars/default.png'
  },
  level: {
    type: Number,
    default: 1
  },
  exp: {
    type: Number,
    default: 0
  },
  coins: {
    type: Number,
    default: 1000
  },
  registerTime: {
    type: Date,
    default: Date.now
  },
  lastLoginTime: {
    type: Date,
    default: Date.now
  },
  stats: {
    totalKills: { type: Number, default: 0 },
    totalDeaths: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 },
    totalLosses: { type: Number, default: 0 },
    totalMVP: { type: Number, default: 0 },
    headshots: { type: Number, default: 0 },
    accuracy: { type: Number, default: 0 },
    playTime: { type: Number, default: 0 }
  },
  inventory: {
    weapons: [{
      type: String
    }],
    currentWeapon: {
      type: String,
      default: 'AK-47'
    }
  },
  settings: {
    sensitivity: { type: Number, default: 0.003 },
    volume: { type: Number, default: 0.8 },
    crosshairColor: { type: String, default: '#FF6A00' }
  }
}, {
  timestamps: true
});

// 密码加密
playerSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// 验证密码
playerSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// 获取公开信息
playerSchema.methods.toPublicJSON = function() {
  return {
    id: this._id,
    nickname: this.nickname,
    avatar: this.avatar,
    level: this.level,
    stats: {
      totalKills: this.stats.totalKills,
      totalDeaths: this.stats.totalDeaths,
      totalWins: this.stats.totalWins,
      totalMVP: this.stats.totalMVP,
      accuracy: this.stats.accuracy
    }
  };
};

module.exports = mongoose.model('Player', playerSchema);