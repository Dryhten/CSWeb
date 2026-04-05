// @ts-nocheck
import * as THREE from 'three';

/** 角色与墙体 AABB 相交（用于玩家/敌人，禁止穿模） */
export function actorIntersectsWallBox(mapObjects, x, z, radius, yMin, yMax) {
  const testBox = new THREE.Box3(
    new THREE.Vector3(x - radius, yMin, z - radius),
    new THREE.Vector3(x + radius, yMax, z + radius)
  );
  for(let i = 0; i < mapObjects.length; i++) {
    const obj = mapObjects[i];
    if(!obj.box) continue;
    if(testBox.intersectsBox(obj.box)) return true;
  }
  return false;
}

export function isInsideWall(mapObjects, x, z, radius) {
  radius = radius || 0.55;
  return actorIntersectsWallBox(mapObjects, x, z, radius, 0.05, 1.95);
}

/** 脚下可站立表面高度（薄台、箱子顶等；厚墙 Y 向尺寸大，不参与） */
export function getFeetSurfaceY(mapObjects, x, z, footR) {
  footR = footR || 0.42;
  let best = 0;
  mapObjects.forEach(obj => {
    if(!obj.box) return;
    const b = obj.box;
    if(x + footR <= b.min.x || x - footR >= b.max.x || z + footR <= b.min.z || z - footR >= b.max.z) return;
    const th = b.max.y - b.min.y;
    if(th < 2.4 && b.max.y > best) best = b.max.y;
  });
  return best;
}

/** 略大于玩家胶囊半径，贴近人形 NPC 模型占地 */
export const ENEMY_WALL_R = 0.42;
export const ENEMY_WALL_Y0 = 0.02;
export const ENEMY_WALL_Y1 = 1.78;

export function enemyPositionBlocked(mapObjects, x, z) {
  return actorIntersectsWallBox(mapObjects, x, z, ENEMY_WALL_R, ENEMY_WALL_Y0, ENEMY_WALL_Y1);
}

/**
 * 若已与墙体 AABB 重叠，沿穿透最浅方向推出（与玩家 resolvePlayerWallPenetration 同思路）。
 * 用于 NPC 被玩家距离圈 / 互推后仍卡在墙内的强制修正。
 */
export function resolveActorWallPenetrationXZ(mapObjects, pos, radius, yMin, yMax, pad = 0.04, maxIter = 10) {
  for(let k = 0; k < maxIter; k++) {
    const cx = pos.x;
    const cz = pos.z;
    let fixed = false;
    for(let i = 0; i < mapObjects.length; i++) {
      const obj = mapObjects[i];
      if(!obj.box) continue;
      const b = obj.box;
      if(cx + radius <= b.min.x || cx - radius >= b.max.x || cz + radius <= b.min.z || cz - radius >= b.max.z) continue;
      if(yMax <= b.min.y || yMin >= b.max.y) continue;
      const penL = (cx + radius) - b.min.x;
      const penR = b.max.x - (cx - radius);
      const penF = (cz + radius) - b.min.z;
      const penB = b.max.z - (cz - radius);
      const m = Math.min(penL, penR, penF, penB);
      if(m === penL) pos.x -= penL + pad;
      else if(m === penR) pos.x += penR + pad;
      else if(m === penF) pos.z -= penF + pad;
      else pos.z += penB + pad;
      fixed = true;
      break;
    }
    if(!fixed) break;
  }
}
