const mongoose = require('mongoose');

const weaponConfigSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['rifle', 'pistol', 'sniper', 'smg', 'shotgun'], required: true },
  damage: { type: Number, required: true },
  fireRate: { type: Number, required: true },
  bulletSpeed: { type: Number, required: true },
  magSize: { type: Number, required: true },
  reserve: { type: Number, required: true },
  reloadTime: { type: Number, required: true },
  maxSpeedU: { type: Number, required: true },
  price: { type: Number, default: 0 },
  rangeSU: { type: Number, default: 500 },
  rangeModifier: { type: Number, default: 0.98 },
  headMult: { type: Number, default: 4 },
  dmgChestMult: { type: Number, default: 1 },
  dmgStomachMult: { type: Number, default: 1 },
  dmgLimbMult: { type: Number, default: 0.75 },
  armorPenetration: { type: Number, default: 50 },
  penetration: { type: Number, default: 1 },
  patternId: { type: String, default: '' },
  inaccuracyCrouchMult: { type: Number, default: 0.5 },
  inaccuracyStand: { type: Number, default: 0.002 },
  inaccuracyMove: { type: Number, default: 0.014 },
  inaccuracySpray: { type: Number, default: 0.001 },
  inaccuracyMax: { type: Number, default: 0.05 },
  vmKickZ: { type: Number, default: 0.05 },
  vmKickY: { type: Number, default: 0.15 },
  vmRecoilBackMax: { type: Number, default: 0.13 },
  auto: { type: Boolean, default: false },
  mode: { type: String, enum: ['AUTO', 'SEMI', 'BOLT'], default: 'AUTO' },
  label: { type: String, default: '' },
  slotLabel: { type: String, default: '' },
  isDefault: { type: Boolean, default: false }
}, { _id: false });

const characterConfigSchema = new mongoose.Schema({
  moveKnifeSpeed: { type: Number, default: 6 },
  sprintMultiplier: { type: Number, default: 1.6 },
  jumpForce: { type: Number, default: 9 },
  gravity: { type: Number, default: -25 },
  playerHeight: { type: Number, default: 1.7 },
  playerRadius: { type: Number, default: 0.4 }
}, { _id: false });

const gameModeSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: String,
  maxPlayers: { type: Number, default: 10 },
  defaultRoundTime: { type: Number, default: 120 },
  defaultWinScore: { type: Number, default: 16 }
}, { _id: false });

const mapConfigSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: String,
  thumbnail: String,
  isActive: { type: Boolean, default: true }
}, { _id: false });

const gameConfigSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    default: '默认配置'
  },
  weapons: [weaponConfigSchema],
  character: characterConfigSchema,
  gameModes: [gameModeSchema],
  maps: [mapConfigSchema],
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('GameConfig', gameConfigSchema);