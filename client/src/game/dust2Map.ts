// @ts-nocheck
/**
 * de_dust2.glb：合并网格 + MeshBVH，用于与几何一致的射线/最近点碰撞（非 AABB）。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

let prototypesPatched = false;

export function ensureMeshBVHPrototypes() {
  if(prototypesPatched) return;
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
  prototypesPatched = true;
}

const _ray = new THREE.Ray();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3(0, -1, 0);
const _cpTarget = { point: new THREE.Vector3() };
const _tmpRay = new THREE.Ray();
const _worldN = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _m4Inst = new THREE.Matrix4();
const _m4InstLocal = new THREE.Matrix4();

/** 父链上均 visible 才算「看得见」，用于只给可见模型建碰撞 */
function objectWorldVisible(obj: THREE.Object3D): boolean {
  let o: THREE.Object3D | null = obj;
  while(o) {
    if(!o.visible) return false;
    o = o.parent;
  }
  return true;
}

/** 碰撞用：只保留 position/normal，避免合并时 uv/color 不一致导致 merge 失败 */
function prepareCollisionGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry | null {
  if(!g.attributes || !g.attributes.position) return null;
  let out = g;
  if(!out.index) {
    out = out.toNonIndexed() as THREE.BufferGeometry;
  }
  if(!out.attributes.normal) {
    out.computeVertexNormals();
  }
  ['uv', 'uv2', 'uv3', 'color', 'tangent', 'skinIndex', 'skinWeight'].forEach((name) => {
    if(out.attributes[name]) out.deleteAttribute(name);
  });
  return out;
}

function pushGeometryFromWorldMatrix(geoms: THREE.BufferGeometry[], mesh: THREE.Mesh, worldMatrix: THREE.Matrix4) {
  if(!mesh.geometry) return;
  let g = mesh.geometry.clone() as THREE.BufferGeometry;
  try {
    g.applyMatrix4(worldMatrix);
  } catch(e) {
    console.warn('[dust2] applyMatrix4 failed:', e);
    return;
  }
  g = prepareCollisionGeometry(g);
  if(g) geoms.push(g);
}

/**
 * 收集场景中三角网格用于 BVH：普通 Mesh / SkinnedMesh / InstancedMesh（逐实例展开）
 * 注意：不再检查 visible，因为地图碰撞层可能被设为不可见
 */
function collectVisibleCollisionGeometries(root: THREE.Object3D): THREE.BufferGeometry[] {
  const geoms: THREE.BufferGeometry[] = [];
  root.updateMatrixWorld(true);
  root.traverse((child: THREE.Object3D) => {
    if((child as THREE.InstancedMesh).isInstancedMesh) {
      const im = child as THREE.InstancedMesh;
      if(!im.geometry || !im.geometry.attributes || !im.geometry.attributes.position) return;
      for(let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, _m4InstLocal);
        _m4Inst.copy(im.matrixWorld).multiply(_m4InstLocal);
        pushGeometryFromWorldMatrix(geoms, im as unknown as THREE.Mesh, _m4Inst);
      }
      return;
    }

    if(!child.isMesh || !child.geometry) return;
    if((child as THREE.SkinnedMesh).isSkinnedMesh) {
      (child as THREE.SkinnedMesh).updateMatrixWorld(true);
    }
    pushGeometryFromWorldMatrix(geoms, child as THREE.Mesh, child.matrixWorld);
  });
  return geoms;
}

function mergeCollisionGeometries(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if(geoms.length === 0) {
    throw new Error('[dust2] 无可用碰撞几何');
  }
  if(geoms.length === 1) {
    return geoms[0];
  }
  let merged: THREE.BufferGeometry | null = null;
  try {
    merged = BufferGeometryUtils.mergeBufferGeometries(geoms, false);
  } catch(e) {
    console.warn('[dust2] mergeBufferGeometries(false) failed:', e);
    merged = null;
  }
  if(merged) return merged;
  try {
    merged = BufferGeometryUtils.mergeBufferGeometries(geoms, true);
  } catch(e) {
    console.warn('[dust2] mergeBufferGeometries(true) failed:', e);
    merged = null;
  }
  if(merged) return merged;

  console.warn('[dust2] 批量 mergeBufferGeometries 失败，改为逐块合并');
  let acc = geoms[0];
  for(let i = 1; i < geoms.length; i++) {
    let next: THREE.BufferGeometry | null = null;
    try {
      next = BufferGeometryUtils.mergeBufferGeometries([acc, geoms[i]], false);
    } catch(_) {
      next = null;
    }
    if(!next) {
      try {
        next = BufferGeometryUtils.mergeBufferGeometries([acc, geoms[i]], true);
      } catch(_) {
        next = null;
      }
    }
    if(!next) {
      console.warn('[dust2] 跳过无法与前面合并的几何块', i);
      continue;
    }
    acc = next;
  }
  return acc;
}

/**
 * 世界空间射线与碰撞网格的首次命中（用于射击/近战，mesh 可为未加入 scene）
 */
export function raycastMapFirst(
  raycaster: THREE.Raycaster,
  collisionMesh: THREE.Mesh
): THREE.Intersection | null {
  if(!collisionMesh.geometry || !collisionMesh.geometry.boundsTree) return null;
  const inv = new THREE.Matrix4().copy(collisionMesh.matrixWorld).invert();
  _tmpRay.copy(raycaster.ray).applyMatrix4(inv);
  const hit = collisionMesh.geometry.boundsTree.raycastFirst(_tmpRay, THREE.DoubleSide);
  if(!hit) return null;
  hit.point.applyMatrix4(collisionMesh.matrixWorld);
  hit.distance = hit.point.distanceTo(raycaster.ray.origin);
  if(hit.distance < raycaster.near || hit.distance > raycaster.far) return null;
  hit.object = collisionMesh;
  return hit as THREE.Intersection;
}

/**
 * 竖直向下射线找脚底高度（类 Source PM_GroundTrace：从上往下打，找可站立顶面）。
 * 可走面：世界法线朝上，或射线方向(0,-1,0)与法线点积 < 0（从上方击中三角正面）。
 * 若法线因合并网格/平滑异常，在包围盒合理范围内用「首个命中」兜底，避免全程 NaN 导致无限坠落。
 */
export function getFeetYFromBVH(
  collisionMesh: THREE.Mesh,
  x: number,
  z: number,
  footR: number,
  refY: number,
  bounds?: THREE.Box3,
  playerFeetY?: number
): number {
  if(!collisionMesh.geometry || !collisionMesh.geometry.boundsTree) return Number.NaN;
  const bvh = collisionMesh.geometry.boundsTree;
  collisionMesh.updateMatrixWorld(true);
  _nm.getNormalMatrix(collisionMesh.matrixWorld);

  // 从天空向下会先命中屋顶；已知脚底时用脚面上方短射线，优先命中脚下地面（室内不误用楼顶）
  let rayStartY;
  if(playerFeetY != null && Number.isFinite(playerFeetY)) {
    rayStartY = playerFeetY + 0.55;
    if(bounds) rayStartY = Math.min(rayStartY, bounds.max.y + 80);
  } else {
    rayStartY = bounds ? Math.max(refY, bounds.max.y + 400) : refY + 300;
  }

  const downDir = new THREE.Vector3(0, -1, 0);
  const rayOrigin = new THREE.Vector3();
  const downRay = new THREE.Ray();
  const _worldN = new THREE.Vector3();

  const samples = [
    [0, 0],
    [footR * 0.65, 0],
    [-footR * 0.65, 0],
    [0, footR * 0.65],
    [0, -footR * 0.65],
  ];

  let maxFeet = -1e9;

  const pickFeetFromHits = (hits: { distance: number; point: THREE.Vector3; face?: { normal: THREE.Vector3 } }[]) => {
    if(!hits.length) return -1e9;
    hits.sort((a, b) => a.distance - b.distance);

    let best = -1e9;
    for(let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if(h.face && h.face.normal) {
        _worldN.copy(h.face.normal).applyNormalMatrix(_nm);
        _worldN.normalize();
      } else {
        _worldN.set(0, 1, 0);
      }
      const dotUp = _worldN.y;
      const dotRay = downDir.dot(_worldN);
      if(dotRay < -0.001 || dotUp > 0.001) {
        return h.point.y;
      }
      if(dotUp > 0.0001) {
        best = Math.max(best, h.point.y);
      }
    }
    if(best > -1e8) return best;

    for(let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if(h.face && h.face.normal) {
        _worldN.copy(h.face.normal).applyNormalMatrix(_nm);
        _worldN.normalize();
      } else {
        _worldN.set(0, 1, 0);
      }
      if(_worldN.y < -0.22) continue;
      const py = h.point.y;
      if(playerFeetY != null && py > playerFeetY + 6) continue;
      if(bounds && Number.isFinite(py)) {
        if(py >= bounds.min.y - 30 && py <= bounds.max.y + 120) return py;
      } else if(Number.isFinite(py)) {
        return py;
      }
    }

    const h0 = hits[0];
    const py = h0.point.y;
    if(bounds && Number.isFinite(py)) {
      if(py >= bounds.min.y - 30 && py <= bounds.max.y + 120) {
        return py;
      }
    } else if(Number.isFinite(py)) {
      return py;
    }
    return -1e9;
  };

  for(let s = 0; s < samples.length; s++) {
    rayOrigin.set(x + samples[s][0], rayStartY, z + samples[s][1]);
    downRay.set(rayOrigin, downDir);
    const hits = bvh.raycast(downRay, THREE.DoubleSide);
    const colFeet = pickFeetFromHits(hits);
    if(colFeet > maxFeet) maxFeet = colFeet;
  }

  if(maxFeet > -1e8) return maxFeet;
  return Number.NaN;
}

/** 圆柱体（竖直）是否与静态网格过近（用于墙体内判定、NPC 阻挡） */
export function cylinderTooCloseToMesh(
  collisionMesh: THREE.Mesh,
  x: number,
  z: number,
  radius: number,
  yMin: number,
  yMax: number,
  pad = 0.04
): boolean {
  if(!collisionMesh.geometry || !collisionMesh.geometry.boundsTree) return false;
  const bvh = collisionMesh.geometry.boundsTree;
  const steps = 6;
  const r = radius - pad;
  for(let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = yMin + t * (yMax - yMin);
    _origin.set(x, y, z);
    const res = bvh.closestPointToPoint(_origin, _cpTarget);
    if(res && res.distance < r) return true;
  }
  return false;
}

/**
 * 脚底世界 y（含 dust2SpawnFeetLift）为 feetWorldY 时，躯干附近与碰撞网格是否有足够净空，
 * 用于剔除出生在墙体/厚装饰内部的点（仅靠向下射线会误判为「有地面」）。
 */
export function isSpawnTorsoClear(
  collisionMesh: THREE.Mesh,
  x: number,
  z: number,
  feetWorldY: number,
  minDist: number
): boolean {
  if(!collisionMesh.geometry?.boundsTree) return true;
  collisionMesh.updateMatrixWorld(true);
  _origin.set(x, feetWorldY + 0.88, z);
  const res = collisionMesh.geometry.boundsTree.closestPointToPoint(_origin, _cpTarget);
  if(!res || res.distance == null) return true;
  return res.distance >= minDist;
}

/**
 * 水平移动是否被挡：在若干高度做水平射线，若命中距离 < radius 则阻挡。
 * 法线需转到世界空间；朝上的可走面不视为侧墙。可选参数略放宽，减少碎起伏/裂缝误挡。
 */
export function horizontalMoveBlocked(
  collisionMesh: THREE.Mesh,
  x: number,
  z: number,
  ySamples: number[],
  radius: number,
  sectors = 16,
  opts?: {
    walkableMinNy?: number;
    rayInset?: number;
    /** 极近命中且像碎竖面时忽略（裂缝、三角细分边缘） */
    microGapMaxDist?: number;
    /**
     * 水平射线有效长度 = radius + castExtra（米）。
     * 略大则更早判定为挡墙，贴台沿/凸角蹭动时不易钻进碎三角（类似 Source 玩家 hull 相对几何留一点净空）。
     */
    castExtra?: number;
  }
): boolean {
  if(!collisionMesh.geometry || !collisionMesh.geometry.boundsTree) return false;
  collisionMesh.updateMatrixWorld(true);
  _nm.getNormalMatrix(collisionMesh.matrixWorld);
  const bvh = collisionMesh.geometry.boundsTree;
  const castExtra = opts && opts.castExtra != null ? opts.castExtra : 0.22;
  const castLen = radius + castExtra;
  const walkableMinNy = opts && opts.walkableMinNy != null ? opts.walkableMinNy : 0.4;
  const rayInset = opts && opts.rayInset != null ? opts.rayInset : 0.12;
  const microGapMaxDist = opts && opts.microGapMaxDist != null ? opts.microGapMaxDist : 0.13;
  for(let h = 0; h < ySamples.length; h++) {
    const y = ySamples[h];
    for(let i = 0; i < sectors; i++) {
      const ang = (i / sectors) * Math.PI * 2;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      _origin.set(x - dx * rayInset, y, z - dz * rayInset);
      _dir.set(dx, 0, dz);
      _ray.set(_origin, _dir);
      const hit = bvh.raycastFirst(_ray, THREE.DoubleSide);
      if(hit && hit.distance < castLen) {
        if(hit.face && hit.face.normal) {
          _worldN.copy(hit.face.normal).applyNormalMatrix(_nm);
        } else {
          _worldN.set(0, 1, 0);
        }
        _worldN.normalize();
        if(_worldN.y > walkableMinNy) continue;
        if(
          hit.distance < microGapMaxDist &&
          Math.abs(_worldN.y) < 0.78
        ) {
          continue;
        }
        return true;
      }
    }
  }
  return false;
}

/**
 * XZ 上相对碰撞壳的「陷入」深度（米）：max(0, (radius - pad) - 到网格最近距离)，与 resolvePenetrationXZ 语义一致。
 */
export function xzPenetrationExcess(
  collisionMesh: THREE.Mesh,
  x: number,
  z: number,
  yCenter: number,
  radius: number,
  pad: number
): number {
  if(!collisionMesh.geometry || !collisionMesh.geometry.boundsTree) return 0;
  collisionMesh.updateMatrixWorld(true);
  _origin.set(x, yCenter, z);
  const res = collisionMesh.geometry.boundsTree.closestPointToPoint(_origin, _cpTarget);
  if(!res || res.distance == null) return 0;
  const allowed = radius - pad;
  if(res.distance >= allowed) return 0;
  return allowed - res.distance;
}

/** inx,inz：玩家指向表面上最近点的方向（朝网格内），用于去掉位移中「钻进墙」的分量 */
function clipDeltaAgainstInwardXZ(
  dirx: number,
  dirz: number,
  len: number,
  inx: number,
  inz: number,
  intoEps: number
): { dx: number; dz: number } {
  const ilen = Math.hypot(inx, inz);
  if(ilen < 1e-5) return { dx: dirx * len, dz: dirz * len };
  const nix = inx / ilen;
  const niz = inz / ilen;
  const din = dirx * nix + dirz * niz;
  if(din <= intoEps) return { dx: dirx * len, dz: dirz * len };
  const tx = dirx - nix * din;
  const tz = dirz - niz * din;
  const tlen = Math.hypot(tx, tz);
  if(tlen < 0.04) return { dx: 0, dz: 0 };
  return { dx: (tx / tlen) * len, dz: (tz / tlen) * len };
}

/**
 * 前向射线未命中或掠射时：用最近点从玩家指向表面的方向，去掉「往墙里」的分量。
 */
function clipHorizontalDeltaAlongWallClosestFallback(
  collisionMesh: THREE.Mesh,
  x: number,
  z: number,
  deltaX: number,
  deltaZ: number,
  yAt: number,
  radius: number,
  castLen: number,
  intoEps: number
): { dx: number; dz: number } {
  const len = Math.hypot(deltaX, deltaZ);
  if(len < 1e-8) return { dx: 0, dz: 0 };
  const bvh = collisionMesh.geometry.boundsTree;
  _origin.set(x, yAt, z);
  const res = bvh.closestPointToPoint(_origin, _cpTarget);
  if(!res || res.distance == null) return { dx: deltaX, dz: deltaZ };
  if(res.distance >= castLen) return { dx: deltaX, dz: deltaZ };

  const dirx = deltaX / len;
  const dirz = deltaZ / len;
  const cx = res.point.x;
  const cz = res.point.z;
  const inx = cx - x;
  const inz = cz - z;
  return clipDeltaAgainstInwardXZ(dirx, dirz, len, inx, inz, intoEps);
}

/**
 * 将水平位移沿「运动方向最先碰到的竖墙」投影为贴墙滑动（ClipVelocity），用于空中贴箱/贴墙仍能沿面移动。
 * 前向射线未命中时用最近点做法线回退（平行滑墙 / 掠射）。
 */
export function clipHorizontalDeltaAlongWall(
  collisionMesh: THREE.Mesh,
  x: number,
  z: number,
  deltaX: number,
  deltaZ: number,
  yAt: number,
  radius: number,
  opts?: {
    walkableMinNy?: number;
    rayInset?: number;
    castExtra?: number;
    microGapMaxDist?: number;
  }
): { dx: number; dz: number } {
  const len = Math.hypot(deltaX, deltaZ);
  if(len < 1e-8) return { dx: 0, dz: 0 };
  if(!collisionMesh.geometry || !collisionMesh.geometry.boundsTree) return { dx: deltaX, dz: deltaZ };

  collisionMesh.updateMatrixWorld(true);
  _nm.getNormalMatrix(collisionMesh.matrixWorld);
  const bvh = collisionMesh.geometry.boundsTree;

  const dirx = deltaX / len;
  const dirz = deltaZ / len;
  const walkableMinNy = opts && opts.walkableMinNy != null ? opts.walkableMinNy : 0.44;
  const rayInset = opts && opts.rayInset != null ? opts.rayInset : 0.14;
  const castExtra = opts && opts.castExtra != null ? opts.castExtra : 0.22;
  const microGapMaxDist = opts && opts.microGapMaxDist != null ? opts.microGapMaxDist : 0.14;
  const castLen = radius + castExtra;
  const intoEps = 0.02;

  _origin.set(x - dirx * rayInset, yAt, z - dirz * rayInset);
  _dir.set(dirx, 0, dirz);
  _ray.set(_origin, _dir);
  const hit = bvh.raycastFirst(_ray, THREE.DoubleSide);
  if(!hit || hit.distance >= castLen) {
    return clipHorizontalDeltaAlongWallClosestFallback(
      collisionMesh,
      x,
      z,
      deltaX,
      deltaZ,
      yAt,
      radius,
      castLen,
      intoEps
    );
  }

  if(hit.face && hit.face.normal) {
    _worldN.copy(hit.face.normal).applyNormalMatrix(_nm);
  } else {
    _worldN.set(0, 1, 0);
  }
  _worldN.normalize();
  if(_worldN.y > walkableMinNy) return { dx: deltaX, dz: deltaZ };

  if(
    hit.distance < microGapMaxDist &&
    Math.abs(_worldN.y) < 0.78
  ) {
    return clipHorizontalDeltaAlongWallClosestFallback(
      collisionMesh,
      x,
      z,
      deltaX,
      deltaZ,
      yAt,
      radius,
      castLen,
      intoEps
    );
  }

  let nx = _worldN.x;
  let nz = _worldN.z;
  const nLen = Math.hypot(nx, nz);
  if(nLen < 0.06) {
    return clipHorizontalDeltaAlongWallClosestFallback(
      collisionMesh,
      x,
      z,
      deltaX,
      deltaZ,
      yAt,
      radius,
      castLen,
      intoEps
    );
  }
  nx /= nLen;
  nz /= nLen;

  const into = dirx * nx + dirz * nz;
  if(into >= -intoEps) return { dx: deltaX, dz: deltaZ };

  const tx = dirx - nx * into;
  const tz = dirz - nz * into;
  const tlen = Math.hypot(tx, tz);
  if(tlen < 0.04) return { dx: 0, dz: 0 };
  return { dx: (tx / tlen) * len, dz: (tz / tlen) * len };
}

/**
 * 若角色过近网格表面，沿法向推回（XZ 主要）
 */
export function resolvePenetrationXZ(
  collisionMesh: THREE.Mesh,
  pos: THREE.Vector3,
  radius: number,
  yCenter: number,
  pad = 0.04,
  opts?: { pushScale?: number; maxPushPerStep?: number }
) {
  if(!collisionMesh.geometry || !collisionMesh.geometry.boundsTree) return;
  const bvh = collisionMesh.geometry.boundsTree;
  _origin.set(pos.x, yCenter, pos.z);
  const res = bvh.closestPointToPoint(_origin, _cpTarget);
  if(!res || res.distance >= radius - pad) return;
  let push = radius - pad - res.distance;
  if(push <= 0) return;
  /** 最近点在探测中心下方（台沿竖壁、裙边），强挤出易与水平位移对冲导致卡死 */
  const pointBelowCenter = yCenter - res.point.y;
  if(pointBelowCenter > 0.32) {
    push *= 0.26;
  } else if(pointBelowCenter > 0.16) {
    push *= 0.52;
  }
  const ps = opts && opts.pushScale != null ? opts.pushScale : 1;
  push *= ps;
  const cap = opts && opts.maxPushPerStep != null ? opts.maxPushPerStep : null;
  if(cap != null && cap > 0) {
    push = Math.min(push, cap);
  }
  if(push <= 1e-4) return;
  _dir.subVectors(_origin, res.point);
  _dir.y = 0;
  if(_dir.lengthSq() < 1e-8) return;
  _dir.normalize();
  pos.x += _dir.x * push;
  pos.z += _dir.z * push;
}

export type Dust2LoadResult = {
  visualRoot: THREE.Object3D;
  collisionMesh: THREE.Mesh;
  bounds: THREE.Box3;
};

export async function loadDust2GlbMap(
  scene: THREE.Scene,
  opts: {
    url: string;
    scale?: number;
    position?: [number, number, number];
    rotationY?: number;
    /** 在合并碰撞网格前，把模型整体上移/下移使包围盒底面落在 y=0 */
    alignMinYToZero?: boolean;
    /** ratio 0~1，phase 为当前阶段说明（用于 UI） */
    onProgress?: (ratio: number, phase: string) => void;
  }
): Promise<Dust2LoadResult> {
  ensureMeshBVHPrototypes();
  const scale = opts.scale != null ? opts.scale : 1;
  const pos = opts.position || [0, 0, 0];
  const rotationY = opts.rotationY != null ? opts.rotationY : 0;
  const alignMinYToZero = opts.alignMinYToZero !== false;

  const report = (ratio: number, phase: string) => {
    if(opts.onProgress) opts.onProgress(Math.min(1, Math.max(0, ratio)), phase);
  };

  const loader = new GLTFLoader();
  report(0.02, '连接资源…');
  const gltf = await loader.loadAsync(opts.url, (event) => {
    if(event.lengthComputable && event.total > 0) {
      const dl = event.loaded / event.total;
      report(0.05 + dl * 0.62, '下载地图…');
    } else {
      report(0.35, '下载地图…');
    }
  });
  report(0.7, '解析模型…');
  const visualRoot = gltf.scene;
  visualRoot.scale.setScalar(scale);
  visualRoot.position.set(pos[0], pos[1], pos[2]);
  visualRoot.rotation.y = rotationY;
  visualRoot.updateMatrixWorld(true);
  report(0.74, '对齐地形…');

  if(alignMinYToZero) {
    try {
      const pre = new THREE.Box3().setFromObject(visualRoot);
      if(Number.isFinite(pre.min.y)) {
        visualRoot.position.y -= pre.min.y;
        visualRoot.updateMatrixWorld(true);
      }
    } catch(e) {
      console.warn('[dust2] alignMinYToZero failed:', e);
    }
  }

  report(0.78, '提取碰撞几何…');
  const geoms = collectVisibleCollisionGeometries(visualRoot);

  if(geoms.length === 0) {
    throw new Error('[dust2] 无可见三角网格用于碰撞（检查 GLB 是否均为隐藏或仅含点/线）');
  }
  console.log('[dust2] 碰撞几何块数（含实例化展开）:', geoms.length);
  let totalTris = 0;
  for(const g of geoms) {
    totalTris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  }
  console.log('[dust2] 碰撞总面数:', totalTris);

  report(0.84, '合并碰撞网格…');
  const merged = mergeCollisionGeometries(geoms);
  merged.computeVertexNormals();

  const colMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    wireframe: false,
  });
  const collisionMesh = new THREE.Mesh(merged, colMat);
  collisionMesh.name = 'dust2_collision_bvh';
  collisionMesh.matrixAutoUpdate = false;
  collisionMesh.visible = false;
  collisionMesh.frustumCulled = false;

  report(0.9, '构建加速结构…');
  merged.computeBoundsTree({ maxLeafTris: 10, verbose: false });
  report(0.98, '完成场景…');

  const posAttr = merged.attributes.position;
  let boundsMin = new THREE.Vector3(Infinity, Infinity, Infinity);
  let boundsMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  if(posAttr) {
    for(let i = 0; i < posAttr.count; i++) {
      boundsMin.x = Math.min(boundsMin.x, posAttr.getX(i));
      boundsMin.y = Math.min(boundsMin.y, posAttr.getY(i));
      boundsMin.z = Math.min(boundsMin.z, posAttr.getZ(i));
      boundsMax.x = Math.max(boundsMax.x, posAttr.getX(i));
      boundsMax.y = Math.max(boundsMax.y, posAttr.getY(i));
      boundsMax.z = Math.max(boundsMax.z, posAttr.getZ(i));
    }
  }
  const bounds = new THREE.Box3(boundsMin, boundsMax);
  console.log('[dust2] visualRoot bounds:', bounds);
  console.log('[dust2] merged bounds:', bounds);

  collisionMesh.position.set(0, 0, 0);
  collisionMesh.updateMatrixWorld(true);
  console.log('[dust2] collisionMesh position:', collisionMesh.position);
  console.log('[dust2] collisionMesh matrixWorld:', collisionMesh.matrixWorld.elements.slice());

  for(let i = 0; i < geoms.length; i++) {
    if(geoms[i] !== merged) {
      geoms[i].dispose();
    }
  }

  report(1, '就绪');
  return { visualRoot, collisionMesh, bounds };
}
