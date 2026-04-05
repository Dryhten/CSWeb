/**
 * PVP 命中伤害（服务端权威，与 client/src/game/constants.ts + entry 中算法对齐）
 */

const CS_SU_PER_METER = 39.3700787;

/** 与客户端 WEAPONS 中参与伤害结算的字段保持一致 */
const WEAPONS = [
  {
    name: 'AK-47',
    type: 'rifle',
    damage: 36,
    rangeSU: 500,
    rangeModifier: 0.98,
    headMult: 4,
    dmgChestMult: 1,
    dmgLimbMult: 0.75,
    penetration: 2,
  },
  {
    name: 'USP-S',
    type: 'pistol',
    damage: 35,
    rangeSU: 500,
    rangeModifier: 0.85,
    headMult: 4,
    dmgChestMult: 1,
    dmgLimbMult: 0.75,
    penetration: 1,
  },
  {
    name: 'AWP',
    type: 'sniper',
    damage: 115,
    rangeSU: 8192,
    rangeModifier: 0.99,
    headMult: 4,
    dmgChestMult: 1,
    dmgLimbMult: 0.75,
    penetration: 3,
  },
  {
    name: 'Knife',
    type: 'melee',
    damage: 40,
    rangeSU: 60,
    rangeModifier: 1,
    headMult: 1,
    dmgChestMult: 1,
    dmgLimbMult: 1,
    penetration: 0,
  },
];

const WEAPON_BY_NAME = new Map(WEAPONS.map((w) => [w.name, w]));

function weaponDamageFalloffFactor(w, distMeters) {
  const rangeSU = w.rangeSU != null ? w.rangeSU : 500;
  const rm = w.rangeModifier != null ? w.rangeModifier : 0.98;
  const distSU = Math.max(0, distMeters * CS_SU_PER_METER);
  return Math.pow(rm, distSU / rangeSU);
}

function woodPenetrationDamageMult(w) {
  const pen = w.penetration != null ? w.penetration : 1;
  return Math.min(0.52, 0.22 + Math.min(3.5, pen) * 0.075);
}

function computeWeaponHitDamage(w, bodyPart, distMeters) {
  const falloff = weaponDamageFalloffFactor(w, distMeters);
  const effBase = w.damage * falloff;
  if (w.type === 'melee') {
    return Math.max(0, Math.floor(effBase));
  }
  if (bodyPart === 'head') {
    const hm = w.headMult != null ? w.headMult : 4;
    return Math.max(0, Math.floor(effBase * hm));
  }
  if (bodyPart === 'torso') {
    const cm = w.dmgChestMult != null ? w.dmgChestMult : 1;
    return Math.max(0, Math.floor(effBase * cm));
  }
  const lm = w.dmgLimbMult != null ? w.dmgLimbMult : 0.75;
  return Math.max(0, Math.floor(effBase * lm));
}

function normalizeBodyPart(bp) {
  const s = String(bp || '').toLowerCase();
  if (s === 'head') return 'head';
  if (s === 'limb') return 'limb';
  return 'torso';
}

/**
 * @returns {{ damage: number, hitType: 'headshot'|'body' }}
 */
function resolveGunHitDamage(weaponName, bodyPart, distanceMeters, throughWood) {
  const w = WEAPON_BY_NAME.get(String(weaponName || ''));
  if (!w || w.type === 'melee') {
    return { damage: 0, hitType: 'body' };
  }
  const part = normalizeBodyPart(bodyPart);
  const dist = Math.max(0, Number(distanceMeters) || 0);
  let dmg = computeWeaponHitDamage(w, part, dist);
  let hitType = part === 'head' ? 'headshot' : 'body';
  if (throughWood) {
    dmg = Math.floor(dmg * woodPenetrationDamageMult(w));
    hitType = 'body';
  }
  return { damage: Math.max(0, dmg), hitType };
}

/** 轻击与客户端 MELEE_LIGHT_DAMAGE=40、重击秒杀一致 */
function resolveMeleeHitDamage(weaponName, meleeKind) {
  const w = WEAPON_BY_NAME.get(String(weaponName || ''));
  if (!w || w.type !== 'melee') {
    return { damage: 0, hitType: 'melee' };
  }
  const kind = String(meleeKind || 'light').toLowerCase();
  if (kind === 'heavy') {
    return { damage: 2000, hitType: 'melee' };
  }
  return { damage: 40, hitType: 'melee' };
}

module.exports = {
  resolveGunHitDamage,
  resolveMeleeHitDamage,
  WEAPON_BY_NAME,
  normalizeBodyPart,
};
