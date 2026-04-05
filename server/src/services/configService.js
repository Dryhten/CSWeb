const GameConfig = require('../models/GameConfig');

const defaultWeapons = [
  {
    id: 'AK-47',
    name: 'AK-47',
    type: 'rifle',
    damage: 36,
    fireRate: 100,
    bulletSpeed: 355,
    magSize: 30,
    reserve: 90,
    reloadTime: 2430,
    maxSpeedU: 215,
    price: 2700,
    rangeSU: 500,
    rangeModifier: 0.98,
    headMult: 4,
    dmgChestMult: 1,
    dmgStomachMult: 1,
    dmgLimbMult: 0.75,
    armorPenetration: 77.5,
    penetration: 2,
    patternId: 'ak',
    inaccuracyCrouchMult: 0.5,
    inaccuracyStand: 0.00205,
    inaccuracyMove: 0.0142,
    inaccuracySpray: 0.00092,
    inaccuracyMax: 0.048,
    vmKickZ: 0.048,
    vmKickY: 0.145,
    vmRecoilBackMax: 0.132,
    auto: true,
    mode: 'AUTO',
    label: 'AK-47',
    slotLabel: 'AK',
    isDefault: true
  },
  {
    id: 'USP-S',
    name: 'USP-S',
    type: 'pistol',
    damage: 35,
    fireRate: 170,
    bulletSpeed: 218,
    magSize: 12,
    reserve: 24,
    reloadTime: 2200,
    maxSpeedU: 230,
    price: 200,
    rangeSU: 500,
    rangeModifier: 0.85,
    headMult: 4,
    dmgChestMult: 1,
    dmgStomachMult: 1,
    dmgLimbMult: 0.75,
    armorPenetration: 50.5,
    penetration: 1,
    patternId: 'usp',
    inaccuracyCrouchMult: 0.55,
    inaccuracyStand: 0.00145,
    inaccuracyMove: 0.0098,
    inaccuracySpray: 0.00058,
    inaccuracyMax: 0.034,
    vmKickZ: 0.03,
    vmKickY: 0.085,
    vmRecoilBackMax: 0.072,
    auto: false,
    mode: 'SEMI',
    label: 'USP-S',
    slotLabel: 'USP',
    isDefault: true
  },
  {
    id: 'AWP',
    name: 'AWP',
    type: 'sniper',
    damage: 115,
    fireRate: 1480,
    bulletSpeed: 428,
    magSize: 5,
    reserve: 30,
    reloadTime: 3670,
    maxSpeedU: 200,
    price: 4750,
    rangeSU: 8192,
    rangeModifier: 0.99,
    headMult: 4,
    dmgChestMult: 1,
    dmgStomachMult: 1,
    dmgLimbMult: 0.75,
    armorPenetration: 97.5,
    penetration: 3,
    patternId: 'awp',
    inaccuracyCrouchMult: 0.48,
    inaccuracyStand: 0.00115,
    inaccuracyMove: 0.042,
    inaccuracySpray: 0,
    inaccuracyMax: 0.065,
    inaccuracyScoped: 0.00022,
    vmKickZ: 0.1,
    vmKickY: 0.38,
    vmRecoilBackMax: 0.142,
    auto: false,
    mode: 'BOLT',
    label: 'AWP',
    slotLabel: 'AWP',
    isDefault: true
  },
  {
    id: 'M4A1',
    name: 'M4A1',
    type: 'rifle',
    damage: 30,
    fireRate: 91,
    bulletSpeed: 355,
    magSize: 30,
    reserve: 90,
    reloadTime: 3100,
    maxSpeedU: 220,
    price: 3100,
    rangeSU: 500,
    rangeModifier: 0.97,
    headMult: 4,
    dmgChestMult: 1,
    dmgStomachMult: 1,
    dmgLimbMult: 0.75,
    armorPenetration: 70,
    penetration: 2,
    patternId: 'm4',
    inaccuracyCrouchMult: 0.5,
    inaccuracyStand: 0.0018,
    inaccuracyMove: 0.0132,
    inaccuracySpray: 0.00082,
    inaccuracyMax: 0.042,
    vmKickZ: 0.04,
    vmKickY: 0.12,
    vmRecoilBackMax: 0.11,
    auto: true,
    mode: 'AUTO',
    label: 'M4A1',
    slotLabel: 'M4',
    isDefault: false
  },
  {
    id: 'Desert_Eagle',
    name: 'Desert Eagle',
    type: 'pistol',
    damage: 53,
    fireRate: 267,
    bulletSpeed: 230,
    magSize: 7,
    reserve: 35,
    reloadTime: 2200,
    maxSpeedU: 230,
    price: 700,
    rangeSU: 500,
    rangeModifier: 0.81,
    headMult: 4,
    dmgChestMult: 1,
    dmgStomachMult: 1,
    dmgLimbMult: 0.75,
    armorPenetration: 63,
    penetration: 1,
    patternId: 'de',
    inaccuracyCrouchMult: 0.55,
    inaccuracyStand: 0.00155,
    inaccuracyMove: 0.0102,
    inaccuracySpray: 0.00062,
    inaccuracyMax: 0.038,
    vmKickZ: 0.035,
    vmKickY: 0.095,
    vmRecoilBackMax: 0.078,
    auto: false,
    mode: 'SEMI',
    label: 'Desert Eagle',
    slotLabel: 'DE',
    isDefault: false
  }
];

const defaultCharacter = {
  moveKnifeSpeed: 6,
  sprintMultiplier: 1.6,
  jumpForce: 9,
  gravity: -25,
  playerHeight: 1.7,
  playerRadius: 0.4
};

const defaultGameModes = [
  {
    id: 'pvp',
    name: 'PVP 对战',
    description: '经典5v5团队竞技',
    maxPlayers: 10,
    defaultRoundTime: 120,
    defaultWinScore: 16
  },
  {
    id: 'pve',
    name: 'PVE 生存',
    description: "人机对抗，生存模式",
    maxPlayers: 8,
    defaultRoundTime: 300,
    defaultWinScore: 1
  },
  {
    id: 'deathmatch',
    name: '死斗模式',
    description: '个人竞技，自由击杀',
    maxPlayers: 12,
    defaultRoundTime: 600,
    defaultWinScore: 50
  }
];

const defaultMaps = [
  {
    id: 'desert',
    name: '沙漠2',
    description: '经典沙漠竞技地图（de_dust2 风格），适合各种战斗方式',
    thumbnail: '/assets/maps/desert_thumb.jpg',
    isActive: true
  },
  {
    id: 'warehouse',
    name: '仓库突袭',
    description: '室内近距离战斗地图',
    thumbnail: '/assets/maps/warehouse_thumb.jpg',
    isActive: true
  },
  {
    id: 'city',
    name: '城市巷战',
    description: '中大型城市地图',
    thumbnail: '/assets/maps/city_thumb.jpg',
    isActive: false
  }
];

async function initDefaultConfig() {
  try {
    const existingConfig = await GameConfig.findOne({ isActive: true });
    
    if (!existingConfig) {
      const config = new GameConfig({
        name: '默认配置',
        weapons: defaultWeapons,
        character: defaultCharacter,
        gameModes: defaultGameModes,
        maps: defaultMaps,
        isActive: true
      });
      
      await config.save();
      console.log('✓ 默认游戏配置已创建');
    } else {
      // 检查默认武器是否存在
      const existingWeaponIds = existingConfig.weapons.map(w => w.id);
      for (const weapon of defaultWeapons) {
        if (!existingWeaponIds.includes(weapon.id)) {
          existingConfig.weapons.push(weapon);
        }
      }
      await existingConfig.save();
      console.log('✓ 游戏配置已更新');
    }
  } catch (error) {
    console.error('初始化配置错误:', error);
  }
}

module.exports = { initDefaultConfig };