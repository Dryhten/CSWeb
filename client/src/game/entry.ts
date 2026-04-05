// @ts-nocheck
/* eslint-disable */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SkeletonUtils } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  GAME,
  WEAPONS,
  RECOIL_PATTERNS,
  SPRAY_RESET_MS,
  VM_AMBIENT_MULT,
  VM_HEMI_MULT,
  VM_SUN_MULT,
  MAX_BULLET_DECALS,
  BULLET_DECAL_LIFE,
  BULLET_DECAL_FADE,
  SCOPE_ZOOM_DURATION,
  SCOPE_VM_HIDE_AT,
  CAM_FOV_HIP,
  CAM_FOV_SCOPED_1,
  CAM_FOV_SCOPED_2,
  VM_FOV_HIP,
  VM_FOV_AWP_HIP,
  VM_FOV_SCOPED_1,
  VM_FOV_SCOPED_2,
  SCOPE_SENS_MULT,
  SCOPE_SENS_MULT_2,
  THIRD_PERSON_WEAPON_Y_OFFSET,
} from './constants';
import * as Collision from './collision';
import * as Dust2Map from './dust2Map';
import { DUST2_SPAWN_UV, dust2SpawnXZ, dust2UvToXZExact } from './dust2Spawns';
import { applyThirdPersonCameraForRender, restoreThirdPersonCameraAfterRender, getThirdPersonShootRay } from './thirdPersonCamera';
import {
  ensureLocalPlayerAvatar,
  syncLocalPlayerAvatar,
  resetPlayerAvatarForQuit,
  cloneAvatarForRemotePlayer,
  setRemotePlayerAvatarTransform,
  setRemotePlayerCorpsePose,
  clearRemotePlayerCorpsePose,
  isLocalPlayerAvatarReady,
  updateLocalSpawnProtectHighlight,
} from './playerAvatar';

// ============================================================
// GAME STATE & CONFIGURATION
// ============================================================

// Multiplayer game data from parent window
let multiplayerData = null;

/** 地图（含 GLB/BVH）加载完毕后再 resolve，避免 iframe 过早 postMessage 时 startGame 在 mapWorldBounds 为空下用程序图出生点 */
let _resolveMapReady = null;
const mapReadyPromise = new Promise((resolve) => {
  _resolveMapReady = resolve;
});
function notifyMapReady() {
  if(_resolveMapReady) {
    _resolveMapReady();
    _resolveMapReady = null;
  }
}

/** 联机远端玩家 socketId → { group, curPos, targetPos, curYaw, targetYaw, spawnProtectUntil? } */
const remotePlayerMap = new Map();
let lastMpSyncSelfAt = 0;

const MP_SPAWN_PROTECT_MS = 5000;
const SPAWN_PROT_LIGHT_COLOR = 0xffe8a0;
/** 本机复活无敌结束时刻（performance.now），仅 PVP */
let localSpawnProtectUntil = 0;
const localSpawnProtectOrigin = new THREE.Vector3();

function isLocalSpawnProtected() {
  return !!(isPvpMultiplayerRoom() && performance.now() < localSpawnProtectUntil);
}

function isRemoteSpawnProtectedEntry(entry) {
  return entry && entry.spawnProtectUntil != null && performance.now() < entry.spawnProtectUntil;
}

function ensureRemoteSpawnProtectLight(group) {
  let lit = group.userData._spawnProtLight;
  if(!lit) {
    lit = new THREE.PointLight(SPAWN_PROT_LIGHT_COLOR, 0.5, 3.2, 2);
    lit.position.set(0, 1.08, 0);
    group.add(lit);
    group.userData._spawnProtLight = lit;
  }
  return lit;
}

function updateRemoteSpawnProtectLights(nowMs) {
  remotePlayerMap.forEach((entry) => {
    if(!entry.group) return;
    const lit = entry.group.userData._spawnProtLight;
    if(!isRemoteSpawnProtectedEntry(entry)) {
      if(lit) lit.intensity = 0;
      return;
    }
    const L = ensureRemoteSpawnProtectLight(entry.group);
    const t = nowMs * 0.012;
    L.intensity = 0.38 + Math.sin(t) * 0.16 + Math.sin(t * 2.35) * 0.055;
  });
}

function handleSpawnProtectEndMessage(data) {
  if(!data || data.socketId == null) return;
  const sid = String(data.socketId);
  const me = getLocalMultiplayerSocketId();
  if(me && sid === me) localSpawnProtectUntil = 0;
  const entry = remotePlayerMap.get(sid);
  if(entry) entry.spawnProtectUntil = 0;
}

function startLocalSpawnProtectAfterRespawn() {
  if(!isPvpMultiplayerRoom() || !camera) return;
  localSpawnProtectUntil = performance.now() + MP_SPAWN_PROTECT_MS;
  localSpawnProtectOrigin.copy(camera.position);
}

function notifySpawnProtectGunfireToServer() {
  if(!multiplayerData || !multiplayerData.roomId || !isPvpMultiplayerRoom()) return;
  if(performance.now() >= localSpawnProtectUntil) return;
  localSpawnProtectUntil = 0;
  window.parent.postMessage({
    type: 'mp-spawn-protect-shoot',
    roomId: multiplayerData.roomId,
  }, '*');
}

function yawFromRotationObj(r) {
  if(!r || r.w == null) return 0;
  const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  e.setFromQuaternion(q);
  return e.y;
}

function clearRemotePlayers() {
  if(!scene) {
    remotePlayerMap.clear();
    return;
  }
  /** 仅 scene.remove：SkeletonUtils.clone 与本地模型可能共享 geometry/material，不可 dispose */
  remotePlayerMap.forEach((entry) => {
    scene.remove(entry.group);
    if(entry.weaponSceneRoot) scene.remove(entry.weaponSceneRoot);
    if(entry.dropWeaponGroup) {
      scene.remove(entry.dropWeaponGroup);
      removeWorldWeaponDropFromList(entry.dropWeaponGroup);
    }
  });
  remotePlayerMap.clear();
}

function normalizeRemoteWeaponType(w) {
  const s = String(w || '').toLowerCase();
  if(s === 'rifle' || s === 'pistol' || s === 'sniper' || s === 'melee') return s;
  return 'rifle';
}

/** 同步用视觉类型 → 本地武器 key（与 buyWeapon / WEAPONS 一致） */
function weaponTypeToWeaponKey(visualType) {
  const t = String(visualType || '').toLowerCase();
  if(t === 'rifle') return 'ak';
  if(t === 'sniper') return 'awp';
  if(t === 'pistol') return 'usp';
  return null;
}

function weaponKeyToVisualType(weaponKey) {
  const k = String(weaponKey || '').toLowerCase();
  if(k === 'ak') return 'rifle';
  if(k === 'awp') return 'sniper';
  if(k === 'usp') return 'pistol';
  return 'rifle';
}

function weaponKeyToWeaponIndex(weaponKey) {
  const k = String(weaponKey || '').toLowerCase();
  if(k === 'ak') return 0;
  if(k === 'usp') return 1;
  if(k === 'awp') return 2;
  return -1;
}

function cacheAllWeaponBindMatrices() {
  if(!weaponGroup) return;
  const types = ['rifle', 'pistol', 'sniper', 'melee'];
  const savedIdx = currentWeaponIndex;
  for(let i = 0; i < types.length; i++) {
    const t = types[i];
    if(!weaponModels[t]) continue;
    setViewmodelWeapon(t);
    weaponGroup.updateMatrix();
    weaponBindMatrixByType[t] = weaponGroup.matrix.clone();
  }
  currentWeaponIndex = savedIdx;
  setViewmodelWeapon(WEAPONS[savedIdx].type);
}

function ensureRemotePlayerWeaponRoot(entry) {
  if(!entry || !scene || entry.weaponSceneRoot) return;
  const root = new THREE.Group();
  root.name = 'remotePlayerWeapon';
  root.matrixAutoUpdate = false;
  root.visible = false;
  scene.add(root);
  entry.weaponSceneRoot = root;
}

function applyRemoteWeaponMeshMaterials(clone, type) {
  if(type === 'rifle') {
    clone.traverse(function(ch) {
      if(!ch.isMesh || !ch.material) return;
      const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
      mats.forEach(function(m) {
        if(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
          m.envMapIntensity = (m.envMapIntensity != null ? m.envMapIntensity : 1) * 0.8;
          m.roughness = THREE.MathUtils.clamp((m.roughness != null ? m.roughness : 0.5) + 0.04, 0.24, 0.95);
        }
      });
    });
  }
  if(type === 'sniper') {
    clone.traverse(function(ch) {
      if(!ch.isMesh || !ch.material) return;
      const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
      mats.forEach(function(m) {
        if(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
          m.envMapIntensity = (m.envMapIntensity != null ? m.envMapIntensity : 1) * 0.78;
          m.roughness = THREE.MathUtils.clamp((m.roughness != null ? m.roughness : 0.5) + 0.08, 0.2, 0.95);
        }
      });
    });
  }
}

function rebuildRemotePlayerWeaponMesh(entry) {
  if(!entry.weaponSceneRoot) return;
  const type = normalizeRemoteWeaponType(entry.weaponType);
  const model = weaponModels[type];
  if(!model) return;
  const root = entry.weaponSceneRoot;
  while(root.children.length) root.remove(root.children[0]);
  const clone = SkeletonUtils.clone(model);
  applyViewmodelWeaponMaterials(clone);
  tintCsgoViewmodelColors(clone, type);
  applyRemoteWeaponMeshMaterials(clone, type);
  clone.traverse(function(ch) {
    if(ch.isMesh) {
      ch.castShadow = true;
      /** 与射击/近战射线一致：穿透手持武器模型命中身体（见 shoot / checkMeleeHit） */
      ch.userData.skipBulletRaycast = true;
    }
  });
  root.add(clone);
  entry._lastRemoteWeaponType = type;
}

/**
 * @param {THREE.Vector3} feetPos 脚底世界坐标
 * @param {number} yawRad
 * @param {{ weaponKey: string, mag: number, reserve: number, sourceSocketId?: string }} payload
 */
function spawnWorldWeaponDrop(feetPos, yawRad, payload) {
  if(!scene || !payload) return null;
  const weaponKey = String(payload.weaponKey || '').toLowerCase();
  const wi = weaponKeyToWeaponIndex(weaponKey);
  if(wi < 0) return null;
  const ww = WEAPONS[wi];
  const type = weaponKeyToVisualType(weaponKey);
  const model = weaponModels[type];
  if(!model) return null;
  const magMax = ww.magSize != null ? ww.magSize : 30;
  const resMax = ww.reserve != null ? ww.reserve : 90;
  let mag = Math.max(0, Math.min(magMax, Math.floor(Number(payload.mag) || 0)));
  let reserve = Math.max(0, Math.min(resMax, Math.floor(Number(payload.reserve) || 0)));
  if(mag === 0 && reserve === 0) {
    mag = magMax;
    reserve = resMax;
  }
  const group = new THREE.Group();
  group.name = 'worldWeaponDrop';
  const clone = SkeletonUtils.clone(model);
  applyViewmodelWeaponMaterials(clone);
  tintCsgoViewmodelColors(clone, type);
  applyRemoteWeaponMeshMaterials(clone, type);
  clone.traverse(function(ch) {
    if(ch.isMesh) {
      ch.castShadow = true;
      ch.userData.worldWeaponDropMesh = true;
    }
  });
  group.add(clone);
  const off = 0.42;
  group.position.set(
    feetPos.x + off * Math.cos(yawRad + 0.35),
    feetPos.y + 0.04,
    feetPos.z + off * Math.sin(yawRad + 0.35)
  );
  group.rotation.order = 'YXZ';
  group.rotation.y = yawRad + (Math.random() - 0.5) * 0.6;
  group.rotation.x = Math.PI * 0.5 + 0.12;
  group.rotation.z = (Math.random() - 0.5) * 0.25;
  const sc = type === 'sniper' ? 0.42 : type === 'pistol' ? 0.38 : 0.4;
  group.scale.setScalar(sc);
  group.userData.kind = 'worldWeaponDrop';
  group.userData.weaponKey = weaponKey;
  group.userData.mag = mag;
  group.userData.reserve = reserve;
  if(payload.sourceSocketId != null && payload.sourceSocketId !== '') {
    group.userData.sourceSocketId = String(payload.sourceSocketId);
  }
  if(!isMultiplayer1v1RoomMode()) {
    group.userData.dropExpiresAtMs = performance.now() + WORLD_WEAPON_DROP_LIFETIME_MS;
  }
  scene.add(group);
  worldWeaponDrops.push(group);
  return group;
}

function updateRemotePlayerWeaponMatrices() {
  if(!scene || !remotePlayerMap.size) return;
  remotePlayerMap.forEach((entry) => {
    if(entry.dead) {
      if(entry.weaponSceneRoot) entry.weaponSceneRoot.visible = false;
      return;
    }
    ensureRemotePlayerWeaponRoot(entry);
    const type = normalizeRemoteWeaponType(entry.weaponType);
    if(entry._lastRemoteWeaponType !== type) rebuildRemotePlayerWeaponMesh(entry);
    const bindM = weaponBindMatrixByType[type];
    if(!entry.weaponSceneRoot || !bindM || !weaponModels[type]) {
      if(entry.weaponSceneRoot) entry.weaponSceneRoot.visible = false;
      return;
    }
    if(!entry.curEyePos || !entry.curQuat) return;
    entry.weaponSceneRoot.visible = true;
    _remoteWpnEye.position.copy(entry.curEyePos);
    _remoteWpnEye.quaternion.copy(entry.curQuat);
    _remoteWpnEye.updateMatrixWorld(true);
    _tpWpnMatrix.multiplyMatrices(_remoteWpnEye.matrixWorld, bindM);
    _tpWpnWorldDown.makeTranslation(0, THIRD_PERSON_WEAPON_Y_OFFSET, 0);
    entry.weaponSceneRoot.matrix.multiplyMatrices(_tpWpnWorldDown, _tpWpnMatrix);
    entry.weaponSceneRoot.updateMatrixWorld(true);
  });
}

function handleMpSyncRemote(data) {
  const { socketId, position, rotation, weaponType } = data;
  const localId = multiplayerData && multiplayerData.localSocketId;
  if(!socketId || (localId && socketId === localId)) return;
  if(!scene) return;
  /** 联机 PVP：本地阵亡倒计时内 GAME.running 为 false，仍须接收他人位移，否则会永久落后 */
  const mpPvp = !!(multiplayerData && multiplayerData.roomId && isPvpMultiplayerRoom());
  if(!mpPvp && !GAME.running) return;
  if(!position || position.x == null) return;
  const feetY = position.y - GAME.playerHeight;
  const yaw = yawFromRotationObj(rotation);
  const rq = rotation && rotation.w != null
    ? new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w)
    : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  let entry = remotePlayerMap.get(socketId);
  if(!entry) {
    if(!isLocalPlayerAvatarReady()) return;
    const group = cloneAvatarForRemotePlayer(scene, socketId);
    if(!group) return;
    entry = {
      group,
      curPos: new THREE.Vector3(position.x, feetY, position.z),
      targetPos: new THREE.Vector3(position.x, feetY, position.z),
      curEyePos: new THREE.Vector3(position.x, position.y, position.z),
      targetEyePos: new THREE.Vector3(position.x, position.y, position.z),
      curQuat: rq.clone(),
      targetQuat: rq.clone(),
      curYaw: yaw,
      targetYaw: yaw,
      dead: false,
      weaponType: normalizeRemoteWeaponType(weaponType),
    };
    remotePlayerMap.set(socketId, entry);
  } else {
    /** 死亡期间仍写入 target：复活后位移包可能早于 game:playerRespawned */
    entry.targetPos.set(position.x, feetY, position.z);
    entry.targetYaw = yaw;
    if(entry.targetEyePos) entry.targetEyePos.set(position.x, position.y, position.z);
    if(entry.targetQuat && rotation && rotation.w != null) entry.targetQuat.copy(rq);
    if(weaponType != null && weaponType !== '') entry.weaponType = normalizeRemoteWeaponType(weaponType);
    if(entry.dead) {
      /** 尸体态下不 lerp target；仅靠 >7m 会在「复活点靠近尸体」时永远不 markAlive。用死亡时刻脚底 + 时间兜底（阵亡期不发位移包，首包多在倒计时结束后）。 */
      const ref = entry.deathFeetPos || entry.curPos;
      const sinceDead = performance.now() - (entry.mpMarkedDeadAt != null ? entry.mpMarkedDeadAt : 0);
      const dx = entry.targetPos.x - ref.x;
      const dz = entry.targetPos.z - ref.z;
      const dy = entry.targetPos.y - ref.y;
      const horizSq = dx * dx + dz * dz;
      if(sinceDead >= 3500 || horizSq > 2.25 || dy * dy > 0.0144) {
        markRemotePlayerAlive(socketId);
      }
    }
  }
}

function tryPostMultiplayerSelfSync() {
  if(!multiplayerData || !multiplayerData.roomId || !GAME.running || GAME.paused) return;
  if(!camera) return;
  const now = performance.now();
  if(now - lastMpSyncSelfAt < 50) return;
  lastMpSyncSelfAt = now;
  const q = camera.quaternion;
  window.parent.postMessage({
    type: 'mp-sync-self',
    roomId: multiplayerData.roomId,
    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
    weaponType: currentWeapon().type,
  }, '*');
}

function updateRemotePlayersLerp(dt) {
  if(!remotePlayerMap.size) return;
  const alpha = Math.min(1, dt * 14);
  remotePlayerMap.forEach((entry) => {
    if(entry.dead) {
      const y = entry.corpseYaw != null ? entry.corpseYaw : entry.curYaw;
      setRemotePlayerCorpsePose(entry.group, entry.curPos.x, entry.curPos.y, entry.curPos.z, y);
      return;
    }
    if(!entry.curEyePos) {
      entry.curEyePos = new THREE.Vector3(
        entry.curPos.x,
        entry.curPos.y + GAME.playerHeight,
        entry.curPos.z
      );
      entry.targetEyePos = entry.curEyePos.clone();
    }
    if(!entry.curQuat) {
      entry.curQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), entry.curYaw);
      entry.targetQuat = entry.curQuat.clone();
    }
    entry.curPos.lerp(entry.targetPos, alpha);
    entry.curEyePos.lerp(entry.targetEyePos, alpha);
    entry.curQuat.slerp(entry.targetQuat, alpha);
    let dy = entry.targetYaw - entry.curYaw;
    while(dy > Math.PI) dy -= Math.PI * 2;
    while(dy < -Math.PI) dy += Math.PI * 2;
    entry.curYaw += dy * alpha;
    setRemotePlayerAvatarTransform(entry.group, entry.curPos.x, entry.curPos.y, entry.curPos.z, entry.curYaw);
  });
}

// Listen for initialization data from parent window
let gameStarted = false;
window.addEventListener('message', (event) => {
  if(event.data && event.data.type === 'mp-sync-remote') {
    handleMpSyncRemote(event.data);
    return;
  }
  if(event.data && event.data.type === 'mp-player-hit') {
    handleMultiplayerPlayerHit(event.data);
    return;
  }
  if(event.data && event.data.type === 'mp-player-respawned') {
    handleMultiplayerRemoteRespawned(event.data);
    return;
  }
  if(event.data && event.data.type === 'mp-spawn-protect-end') {
    handleSpawnProtectEndMessage(event.data);
    return;
  }
  if(event.data && event.data.type === 'mp-1v1-overtime') {
    handle1v1OvertimeMessage();
    return;
  }
  if(event.data && event.data.type === 'mp-1v1-round-ended') {
    handle1v1RoundEndedMessage(event.data);
    return;
  }
  if(event.data && event.data.type === 'mp-1v1-match-ended') {
    handle1v1MatchEndedMessage(event.data);
    return;
  }
  if (event.data && event.data.type === 'init') {
    multiplayerData = event.data;

    const roomId = multiplayerData.roomId;
    const gs = multiplayerData.gameState;
    /** 仅在明确「仍在房间等待」时不开局；避免 gameState 缺 status / 非 playing 时永远卡住（地图已加载但 running=false） */
    const mpMustWait = !!(roomId && gs?.status === 'waiting');
    if(mpMustWait) {
      return;
    }

    document.getElementById('main-menu').style.display = 'none';

    if (multiplayerData.players) {
      const pid = String(multiplayerData.playerId || '');
      const myPlayer = multiplayerData.players.find(p =>
        (p.playerId != null && String(p.playerId) === pid) ||
        String(p.odId || '') === pid
      );
      if (myPlayer) {
        GAME.playerTeam = myPlayer.team || 'CT';
        GAME.playerIsHost = !!myPlayer.isHost;
      }
      normalizeMultiplayerRoomPlayersStats();
      if(isPvpMultiplayerRoom()) {
        syncLocalHudStatsFromMultiplayerData(false);
      }
    }

    updateMinimapLabelForMap();
    ensureMinimapThumbLoaded();

    if (roomId && !gameStarted) {
      gameStarted = true;
      mapReadyPromise.then(() => {
        startGame();
      });
    } else if(gameStarted && GAME.running && isPvpMultiplayerRoom() && gs?.status === 'playing' && !pvpMatchEnded) {
      applyPvpTimerAnchorsFromMultiplayerData();
    }
  }
});

let currentWeaponIndex = 0;
let ammo, reserveAmmo;
let weaponMag = [];
let weaponReserve = [];
let reloadTimeoutId = null;
let reloadStartTime = 0;
let reloadDurationMs = 0;
let reloadWeaponSlot = 0;
let reloadSfxSource = null;
let isReloading = false;
let isShooting = false;
let canShoot = true;
let isMeleeAttacking = false;
let meleeAttackType = null; // 'light' or 'heavy'
let meleeAttackStartTime = 0;
/** 左键按住：持刀时连续轻击 */
let meleeLightHeld = false;
let meleeLightHitDone = false;
/** 下次允许开始轻击的时刻（与 fireRate、动画总长取 max） */
let meleeLightNextAllowedAt = 0;
/** 连续轻击计数，用于左右交替 Y 轴（yaw） */
let meleeLightSwingIndex = 0;
/** 当前这一下轻击的 yaw 方向：+1 / -1 */
let meleeLightRySign = 1;
/** 连续轻击段间保留的姿态（避免回待机闪一下）；新段开头再淡出 */
let meleeLightResidual = { brx: 0, bry: 0, brz: 0, bx: 0, by: 0, bz: 0 };
/** 右键：蓄力+重刺；满蓄末判定，之后收回；左键取消 */
let meleeHeavySequenceActive = false;
let meleeHeavySequenceStart = 0;
/** 已触发重击伤害判定（防止重复） */
let meleeHeavyHitDone = false;
const MELEE_LIGHT_DAMAGE = 40;
/** 近战攻击距离（米），略长于旧版便于贴身挥砍 */
const MELEE_RANGE_LIGHT = 3.15;
const MELEE_RANGE_HEAVY = 3.85;
/** 相对准心额外扇形方向（弧度），多根射线合并判定，比单射线更容易打中 */
const MELEE_AIM_SPREAD_RAD = 0.07;
/** 近战 viewmodel：代码内默认值； weapons_manifest.json 的 meleeView 会覆盖 */
const DEFAULT_MELEE_VM = {
  lightHitMs: 250,
  lightRecoverMs: 140,
  lightRecoverCarryHeld: 0.44,
  /** 新一段轻击开头与上一段残留姿态的混合时长（ms） */
  lightResidualBlendMs: 140,
  /** 轻击刺出段内，前多少比例时间先平移到 meleeAttackAimBias，再与划刺动画叠加（0~1） */
  lightAimReachPortion: 0.28,
  heavyHitMs: 1000,
  heavyRecoverMs: 360,
  heavyChargeMs: 420,
  chargePullZ: 0.058,
  chargePullRx: -0.092,
  chargePullY: 0.03,
  thrustWindupZ: 0.042,
  thrustWindupRx: -0.07,
  thrustWindupBy: 0.025,
  thrustStabZ: -0.14,
  thrustStabRx: 0.52,
  thrustStabRy: 0.06,
  thrustStabBy: -0.1,
  thrustStabBx: -0.04,
  /** 左键轻击：斜握蓄力 → 向前砍划；Ry 符号左右交替；位移保持贴近准心 */
  lightWu: 0.26,
  lightWindupRx: 0.28,
  lightWindupRy: -0.28,
  lightWindupRz: -0.38,
  lightWindupBx: -0.01,
  lightWindupBy: 0.022,
  lightWindupZ: 0.04,
  lightSlashRx: -0.66,
  lightSlashRy: 0.22,
  lightSlashRz: 0.24,
  lightSlashBx: 0.014,
  lightSlashBy: -0.028,
  lightSlashZ: -0.21,
  /** 轻/重击进行时整体平移 view（相机前右手系 +X 偏右），使刀尖落点贴近准心略偏右 */
  meleeAttackAimBiasX: 0.024,
  meleeAttackAimBiasY: -0.008,
  /** 重击刺出段：前若干比例仅做 Z 轴逆时针 90°，之后仅向前刺（仅 bz） */
  heavyZRotateRad: -Math.PI / 2,
  heavyZRotatePortion: 0.42,
  thrustScale: 1,
  /** 重击：旋转段可略带回拉（可选） */
  heavyRotatePullZ: 0.2,
  /** 重击：向前刺（沿 view -Z） */
  heavyThrustStabZ: -0.26
};

function getMeleeVmParams(wg) {
  const o = { ...DEFAULT_MELEE_VM };
  if(wg && wg.userData && wg.userData.meleeView && typeof wg.userData.meleeView === 'object') {
    Object.assign(o, wg.userData.meleeView);
  }
  return o;
}

/** 时间轴与收回比例（均可在 manifest meleeView 中配置） */
function getMeleeTiming(mv) {
  const d = DEFAULT_MELEE_VM;
  const m = mv || d;
  const num = (k, def) => {
    const v = m[k];
    return v != null && v !== '' ? Number(v) : def;
  };
  return {
    lightHitMs: num('lightHitMs', d.lightHitMs),
    lightRecoverMs: num('lightRecoverMs', d.lightRecoverMs),
    lightRecoverCarryHeld: num('lightRecoverCarryHeld', d.lightRecoverCarryHeld),
    heavyHitMs: num('heavyHitMs', d.heavyHitMs),
    heavyRecoverMs: num('heavyRecoverMs', d.heavyRecoverMs),
    heavyChargeMs: num('heavyChargeMs', d.heavyChargeMs)
  };
}

function meleeLightFullMs(mv) {
  const t = getMeleeTiming(mv);
  return t.lightHitMs + t.lightRecoverMs;
}

function meleeHeavyFullMs(mv) {
  const t = getMeleeTiming(mv);
  return t.heavyHitMs + t.heavyRecoverMs;
}

function clearMeleeLightResidual() {
  meleeLightResidual.brx = 0;
  meleeLightResidual.bry = 0;
  meleeLightResidual.brz = 0;
  meleeLightResidual.bx = 0;
  meleeLightResidual.by = 0;
  meleeLightResidual.bz = 0;
}

function cancelMeleeHeavyCharge() {
  meleeHeavySequenceActive = false;
  meleeHeavyHitDone = false;
}

function updateMeleeHeavySequence() {
  if(!meleeHeavySequenceActive) return;
  const mv = weaponGroup ? getMeleeVmParams(weaponGroup) : null;
  const t = getMeleeTiming(mv);
  const fullMs = t.heavyHitMs + t.heavyRecoverMs;
  const elapsed = performance.now() - meleeHeavySequenceStart;
  if(elapsed >= t.heavyHitMs && !meleeHeavyHitDone) {
    checkMeleeHit('heavy');
    meleeHeavyHitDone = true;
  }
  if(elapsed < fullMs) return;
  meleeHeavySequenceActive = false;
  meleeHeavyHitDone = false;
}

/** 重击刺出段：tThrust∈[0,1] 对应蓄力结束到判定之间的位移/旋转增量 */
function getHeavyStrikeOffsets(mvParams, tThrust) {
  const ts = mvParams.thrustScale != null ? mvParams.thrustScale : 1;
  const zDelta = mvParams.heavyZRotateRad != null ? mvParams.heavyZRotateRad : DEFAULT_MELEE_VM.heavyZRotateRad;
  const rotPortion = Math.min(0.999, Math.max(0.05,
    mvParams.heavyZRotatePortion != null ? mvParams.heavyZRotatePortion : DEFAULT_MELEE_VM.heavyZRotatePortion));
  const hsZ = mvParams.heavyThrustStabZ != null ? mvParams.heavyThrustStabZ : DEFAULT_MELEE_VM.heavyThrustStabZ;
  const pullZ = mvParams.heavyRotatePullZ != null ? mvParams.heavyRotatePullZ : DEFAULT_MELEE_VM.heavyRotatePullZ;
  const tt = Math.min(1, Math.max(0, tThrust));
  let bz = mvParams.chargePullZ;
  let brx = mvParams.chargePullRx;
  let by = mvParams.chargePullY;
  let brz = 0;
  if(tt < rotPortion) {
    const p = rotPortion > 1e-6 ? tt / rotPortion : 1;
    const ease = 1 - Math.cos(p * Math.PI * 0.5);
    brz += ease * zDelta;
    bz += ease * pullZ * ts;
  } else {
    brz += zDelta;
    const u = (tt - rotPortion) / Math.max(1e-6, 1 - rotPortion);
    const thrust = 1 - Math.cos(u * Math.PI * 0.5);
    bz += thrust * hsZ * ts;
  }
  return { brx, by, bz, brz };
}

/** 轻击刺出段：tStrike∈[0,1]；rySign 仅翻转 yaw，实现左右交替 */
function getLightStrikeOffsets(mvParams, tStrike, rySign) {
  const rs = rySign != null && rySign < 0 ? -1 : 1;
  const ts = mvParams.thrustScale != null ? mvParams.thrustScale : 1;
  const wu = mvParams.lightWu != null ? mvParams.lightWu : DEFAULT_MELEE_VM.lightWu;
  const wuClamped = Math.min(0.999, Math.max(0.05, wu));
  const g = (k, def) => (mvParams[k] != null ? mvParams[k] : def);
  const wRx = g('lightWindupRx', DEFAULT_MELEE_VM.lightWindupRx);
  const wRy = g('lightWindupRy', DEFAULT_MELEE_VM.lightWindupRy) * rs;
  const wRz = g('lightWindupRz', DEFAULT_MELEE_VM.lightWindupRz);
  const wBx = g('lightWindupBx', DEFAULT_MELEE_VM.lightWindupBx);
  const wBy = g('lightWindupBy', DEFAULT_MELEE_VM.lightWindupBy);
  const wZ = g('lightWindupZ', DEFAULT_MELEE_VM.lightWindupZ);
  const sRx = g('lightSlashRx', DEFAULT_MELEE_VM.lightSlashRx);
  const sRy = g('lightSlashRy', DEFAULT_MELEE_VM.lightSlashRy) * rs;
  const sRz = g('lightSlashRz', DEFAULT_MELEE_VM.lightSlashRz);
  const sBx = g('lightSlashBx', DEFAULT_MELEE_VM.lightSlashBx);
  const sBy = g('lightSlashBy', DEFAULT_MELEE_VM.lightSlashBy);
  const sZ = g('lightSlashZ', DEFAULT_MELEE_VM.lightSlashZ);
  const tt = Math.min(1, Math.max(0, tStrike));
  if(tt < wuClamped) {
    const ease = 1 - Math.cos((tt / wuClamped) * Math.PI * 0.5);
    return {
      brx: ease * wRx * ts,
      bry: ease * wRy * ts,
      brz: ease * wRz * ts,
      bx: ease * wBx * ts,
      by: ease * wBy * ts,
      bz: ease * wZ * ts
    };
  }
  const u = (tt - wuClamped) / Math.max(1e-6, 1 - wuClamped);
  const thrust = 1 - Math.cos(u * Math.PI * 0.5);
  return {
    brx: (wRx + thrust * (sRx - wRx)) * ts,
    bry: (wRy + thrust * (sRy - wRy)) * ts,
    brz: (wRz + thrust * (sRz - wRz)) * ts,
    bx: (wBx + thrust * (sBx - wBx)) * ts,
    by: (wBy + thrust * (sBy - wBy)) * ts,
    bz: (wZ + thrust * (sZ - wZ)) * ts
  };
}

function updateMeleeLightSequence() {
  if(!isMeleeAttacking || meleeAttackType !== 'light') return;
  const mv = weaponGroup ? getMeleeVmParams(weaponGroup) : null;
  const t = getMeleeTiming(mv);
  const fullMs = t.lightHitMs + t.lightRecoverMs;
  const elapsed = performance.now() - meleeAttackStartTime;
  if(elapsed >= t.lightHitMs && !meleeLightHitDone) {
    checkMeleeHit('light');
    meleeLightHitDone = true;
  }
  if(elapsed >= fullMs) {
    if(meleeLightHeld && weaponGroup) {
      const mv = getMeleeVmParams(weaponGroup);
      const t = getMeleeTiming(mv);
      const peak = getLightStrikeOffsets(mv, 1, meleeLightRySign);
      const k = t.lightRecoverCarryHeld;
      meleeLightResidual.brx = peak.brx * k;
      meleeLightResidual.bry = peak.bry * k;
      meleeLightResidual.brz = peak.brz * k;
      meleeLightResidual.bx = peak.bx * k;
      meleeLightResidual.by = peak.by * k;
      meleeLightResidual.bz = peak.bz * k;
    } else {
      clearMeleeLightResidual();
    }
    isMeleeAttacking = false;
    meleeAttackType = null;
    meleeLightHitDone = false;
  }
}
let lastShotTime = 0;
let lastDryFireTime = 0;
let recoilOffset = { x:0, y:0 };
let sprayConsecutive = 0;
let lastSprayAt = 0;
let weaponBob = 0;
let weaponSwitchAnim = 0;

// Player physics
let velocity = new THREE.Vector3();
let onGround = false;
/** 上一帧有效的 BVH 脚底世界高度 fy（仅作诊断/连贯性；无效射线时不用于错误贴地） */
let lastValidGroundFeetY = null;
/** 按 J 切换：空格可无地起跳，便于探图记录出生点世界坐标 */
let devInfiniteJump = false;
let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false;
/** Shift：静步（低速）；CS:GO 中约为主速度的 1/3 量级 */
let isSprinting = false;
/** Ctrl：下蹲移动，再约为站立的 1/3（与静步叠乘） */
let isCrouching = false;

// Three.js globals
let scene, camera, renderer, clock;
let enemies = [];

function disposeClientPveEnemies() {
  for(let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if(e && e.dropWeaponGroup && scene) {
      scene.remove(e.dropWeaponGroup);
      removeWorldWeaponDropFromList(e.dropWeaponGroup);
      e.dropWeaponGroup = null;
    }
    if(e && e.group && e.group.parent) {
      e.group.parent.remove(e.group);
    }
  }
  enemies.length = 0;
}

/** 单机或联机 PVE：生成地图 NPC；联机 PVP/死斗等与房间模式一致，不生成这批本地 AI */
function shouldSpawnClientPveEnemies() {
  if(!multiplayerData || !multiplayerData.roomId) return true;
  const mode = multiplayerData.settings && multiplayerData.settings.mode;
  return mode === 'pve';
}

let bullets = [];
/** 地面可拾取武器 Group（userData.kind === 'worldWeaponDrop'） */
let worldWeaponDrops = [];

function removeWorldWeaponDropFromList(group) {
  if(!group) return;
  const ix = worldWeaponDrops.indexOf(group);
  if(ix >= 0) worldWeaponDrops.splice(ix, 1);
}

function clearAllWorldWeaponDrops() {
  if(!scene) {
    worldWeaponDrops.length = 0;
    return;
  }
  for(let i = 0; i < worldWeaponDrops.length; i++) {
    const g = worldWeaponDrops[i];
    if(g && g.parent) g.parent.remove(g);
  }
  worldWeaponDrops.length = 0;
  remotePlayerMap.forEach((entry) => {
    if(entry.dropWeaponGroup) entry.dropWeaponGroup = null;
  });
  for(let ei = 0; ei < enemies.length; ei++) {
    const e = enemies[ei];
    if(e) e.dropWeaponGroup = null;
  }
}

/** 联机 1v1 房间：地面枪永久；其余模式（含单机）30s 后移除 */
const WORLD_WEAPON_DROP_LIFETIME_MS = 30 * 1000;

function isMultiplayer1v1RoomMode() {
  return !!(multiplayerData && multiplayerData.settings && String(multiplayerData.settings.mode) === '1v1');
}

function despawnExpiredWorldWeaponDrops(nowMs) {
  if(!scene || !worldWeaponDrops.length) return;
  const now = nowMs != null ? nowMs : performance.now();
  for(let i = worldWeaponDrops.length - 1; i >= 0; i--) {
    const g = worldWeaponDrops[i];
    if(!g || !g.userData) {
      worldWeaponDrops.splice(i, 1);
      continue;
    }
    const exp = g.userData.dropExpiresAtMs;
    if(exp == null || exp > now) continue;
    remotePlayerMap.forEach((entry) => {
      if(entry.dropWeaponGroup === g) entry.dropWeaponGroup = null;
    });
    for(let ei = 0; ei < enemies.length; ei++) {
      const e = enemies[ei];
      if(e && e.dropWeaponGroup === g) e.dropWeaponGroup = null;
    }
    if(g.parent) g.parent.remove(g);
    worldWeaponDrops.splice(i, 1);
  }
}

let particles = [];
let headshotFx = [];
let muzzleFlashes = [];
let playerTracers = [];
let mapObjects = [];
/** de_dust2.glb 合并后的 BVH 碰撞体（不渲染） */
let mapBVHCollisionMesh = null;
let mapUseBVHCollision = false;
let mapWorldBounds = null;
let mapHalfBound = GAME.mapSize / 2;
let bulletDecalsGroup;
let bulletDecals = [];
// Player's owned weapons - slot 0: primary, slot 1: pistol, slot 2: melee (always knife)
let ownedWeapons = {
  primary: 'ak',  // 'ak', 'awp', or null
  pistol: 'usp'   // 'usp' or null
};
// Currently equipped weapon indices
let primaryWeaponIndex = 0;  // index into WEAPONS for primary
let pistolWeaponIndex = 1;   // index into WEAPONS for pistol
// 与主场景一致，用于每帧同步到 viewmodel 光照
let mapSunLight, mapAmbientLight, mapHemisphereLight;
let vmSunLight, vmAmbientLight, vmHemisphereLight;
const _vmLightPos = new THREE.Vector3();
const _vmLightTgt = new THREE.Vector3();
const _tpWpnMatrix = new THREE.Matrix4();
const _tpWpnWorldDown = new THREE.Matrix4();
/** 远端/第三人称：用「眼位+朝向」复现与本地第三人称相同的枪械世界矩阵 */
const _remoteWpnEye = new THREE.Object3D();
/** 各武器类型 viewmodel 绑定姿态矩阵（与 setViewmodelWeapon 初始姿态一致） */
let weaponBindMatrixByType = {};
let viewmodelEnvMap = null;
const bulletHoleTextureCache = {};
/** 刀砍墙刀痕贴图（按材质略变色） */
const knifeSlashTextureCache = {};

// Pointer lock
let yaw = 0, pitch = 0;
let pointerLocked = false;
/** AWP 右键循环：0 腰射 → 1 一倍镜 → 2 二倍镜 → 0 */
let awpScopeStage = 0;
let scopeBlend = 0;
/** 二倍变焦插值 0～1（仅 stage===2 时为 1） */
let doubleZoomBlend = 0;
/** AWP 开镜：线性 0.3s 拉满；抬枪动画用同一时间轴，0.2s 后隐藏模型 */
let scopeZoomElapsed = 0;

/** P 键：第三人称仅影响主场景渲染，逻辑位置仍为头部 */
let thirdPerson = false;

// Audio context
let audioCtx;
const _audioListenerFwd = new THREE.Vector3();

// Viewmodel (first-person weapon)
let viewmodelScene, viewmodelCamera;
let weaponGroup; // holds the current weapon mesh
/** 第三人称：主场景中的世界空间枪械（与 viewmodel 同步矩阵，非屏幕叠加） */
let thirdPersonWeaponRoot = null;
let weaponModels = {}; // { rifle, pistol, sniper }
/** CS:GO 式 view punch：每发叠加冲量，指数衰减回弹（不用相机晃） */
let vmPunch = { pitch: 0, yaw: 0, roll: 0, x: 0, y: 0, z: 0 };
/** 持续后坐位移（+Z＝枪身朝屏幕内/贴肩），连射中累加有上限；停火后再缓回，避免每发被 punch 衰减弹回原位 */
let vmRecoilBackZ = 0;
const VM_RECOIL_BACK_DECAY_AFTER_MS = 220;
let vmSwitchY = 0; // drops weapon down during switch
let vmReloadRot = 0; // rotation during reload
/** AWP 栓动：整段射击冷却内均视为拉栓（秒，剩余至可再开火）；拉栓动画仅占用前 AWP_BOLT_VISUAL_DURATION */
let awpBoltAnimRemaining = 0;
const AWP_BOLT_VISUAL_DURATION = 0.52;

// ============================================================
// INITIALIZATION
// ============================================================
async function init() {
  clock = new THREE.Clock();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  scene.fog = new THREE.FogExp2(0xc8b890, 0.008);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 200);
  camera.position.set(0, GAME.playerHeight, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  document.body.appendChild(renderer.domElement);

  bulletDecalsGroup = new THREE.Group();
  bulletDecalsGroup.name = 'bulletDecals';
  scene.add(bulletDecalsGroup);

  thirdPersonWeaponRoot = new THREE.Group();
  thirdPersonWeaponRoot.name = 'thirdPersonWeapon';
  thirdPersonWeaponRoot.matrixAutoUpdate = false;
  thirdPersonWeaponRoot.visible = false;
  scene.add(thirdPersonWeaponRoot);

  // Lighting
  setupLighting();
  // Viewmodel (first-person weapon overlay)
  setupViewmodel();
  // Map（GLB 为异步加载）
  await buildMap();
  // 本地 NPC 在 startGame() 中按房间 mode 生成（联机 PVP 不生成）
  ensureLocalPlayerAvatar(scene);
  // Events
  setupEvents();
  // Draw crosshair
  drawCrosshair();
  // Setup buy menu
  setupBuyMenu();

  // Improve ground with grid pattern
  addGroundDetails();

  /** 地图与 debris 就绪后再拍俯视快照，供小地图底图使用 */
  scheduleMinimapWorldCapture();

  // Start loop
  animate();
}

// ============================================================
// LIGHTING
// ============================================================
function setupLighting() {
  // Desert sun - warm bright light
  mapAmbientLight = new THREE.AmbientLight(0xd4c4a0, 0.6);
  scene.add(mapAmbientLight);

  mapSunLight = new THREE.DirectionalLight(0xfff0d0, 1.2);
  mapSunLight.position.set(25, 35, 15);
  mapSunLight.castShadow = true;
  mapSunLight.shadow.mapSize.set(2048, 2048);
  mapSunLight.shadow.camera.near = 0.5;
  mapSunLight.shadow.camera.far = 100;
  mapSunLight.shadow.camera.left = -40;
  mapSunLight.shadow.camera.right = 40;
  mapSunLight.shadow.camera.top = 40;
  mapSunLight.shadow.camera.bottom = -40;
  scene.add(mapSunLight);

  // Warm fill lights in key areas
  const warmPositions = [[0,4,0],[15,3,10],[-15,3,-10],[10,3,-15],[-10,3,15]];
  warmPositions.forEach(p => {
    const pl = new THREE.PointLight(0xffcc88, 0.4, 25);
    pl.position.set(...p);
    scene.add(pl);
  });

  // Interior lights (darker indoor areas)
  const interiorPositions = [[-12,3,12],[12,3,-12],[0,5,25],[0,5,-25],[-25,4,0],[25,4,0]];
  interiorPositions.forEach(p => {
    const pl = new THREE.PointLight(0xddbb88, 0.4, 25);
    pl.position.set(...p);
    scene.add(pl);
  });

  // Hemisphere: sky blue top, warm sand bottom
  mapHemisphereLight = new THREE.HemisphereLight(0x87CEEB, 0xc8a870, 0.5);
  scene.add(mapHemisphereLight);
}

/** 程序生成沙漠天空 IBL，供持枪 MeshStandard 反射与漫反射补光（避免纯黑金属） */
function setupViewmodelEnvironmentMap() {
  if(!renderer || !viewmodelScene || typeof THREE.PMREMGenerator === 'undefined') return;
  const w = 512, h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const grd = ctx.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, '#b8c4d4');
  grd.addColorStop(0.42, '#d8ccb0');
  grd.addColorStop(1, '#a89468');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);
  const envTex = new THREE.CanvasTexture(canvas);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  envTex.encoding = THREE.sRGBEncoding;
  envTex.needsUpdate = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromEquirectangular(envTex);
  viewmodelEnvMap = rt.texture;
  viewmodelScene.environment = viewmodelEnvMap;
  envTex.dispose();
  pmrem.dispose();
}

/** 持枪 PBR：CS:GO/Source 感 — 保留分件明暗差，避免整枪被提亮成一片浅灰蓝（克隆各 patch 一次） */
function applyViewmodelWeaponMaterials(root) {
  const env = viewmodelEnvMap || (viewmodelScene && viewmodelScene.environment);
  root.traverse(function(child) {
    if(!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach(function(m) {
      if(!m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial) return;
      if(env) m.envMap = env;
      if(m.userData.vmPatched) return;
      m.userData.vmPatched = true;
      m.envMapIntensity = (m.envMapIntensity != null ? m.envMapIntensity : 1) * 1.28;
      if(m.color) {
        const hsl = { h: 0, s: 0, l: 0 };
        m.color.getHSL(hsl);
        // 仅极暗部略提亮，不把整块 albedo 拉到同一明度
        if(hsl.l < 0.12) m.color.setHSL(hsl.h, THREE.MathUtils.clamp(hsl.s * 0.94, 0, 1), THREE.MathUtils.lerp(hsl.l, 0.11, 0.38));
        else if(hsl.l < 0.2) m.color.setHSL(hsl.h, hsl.s * 0.96, THREE.MathUtils.lerp(hsl.l, 0.17, 0.28));
      }
      m.metalness = THREE.MathUtils.clamp((m.metalness != null ? m.metalness : 0.5) * 0.9, 0.05, 0.82);
      m.roughness = THREE.MathUtils.clamp((m.roughness != null ? m.roughness : 0.55) * 1.04, 0.22, 0.94);
    });
  });
}

function _vmColorIsWoodish(c) {
  return c.r > c.g * 1.04 && c.r > c.b * 0.92 && c.r > 0.12;
}

/** CS:GO 向：步枪深灰黑铁 + 木纹；USP 哑光灰；AWP 绿（GLB 中灰整面材质也会压暗、去蓝） */
function tintCsgoViewmodelColors(root, weaponType) {
  const rifleSteel = new THREE.Color(0x2e3238);
  const rifleSteelHi = new THREE.Color(0x3d4249);
  const rifleMidFix = new THREE.Color(0x2a2d32);
  const rifleWood = new THREE.Color(0x7a4a26);
  const riflePoly = new THREE.Color(0x121418);
  const uspSlide = new THREE.Color(0x5c646e);
  const uspFrame = new THREE.Color(0x12161c);
  // CS:GO AWP：橄榄绿聚合物 + 哑光黑/炭灰金属（枪管、脚架、弹匣、镜环）
  const awpOlive = new THREE.Color(0x3f4d36);
  const awpOliveHi = new THREE.Color(0x4a5a40);
  const awpMetalBlack = new THREE.Color(0x0e1012);
  const awpMetal = new THREE.Color(0x1c2024);
  root.traverse(function(child) {
    if(!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach(function(m) {
      if(!m.color || (!m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial)) return;
      if(m.transparent && (m.opacity == null || m.opacity < 0.95)) return;
      const lum = m.color.r * 0.299 + m.color.g * 0.587 + m.color.b * 0.114;
      if(lum > 0.62) return;
      const c = m.color;
      if(weaponType === 'rifle') {
        if(lum < 0.17) {
          m.color.lerp(riflePoly, 0.42);
          m.color.lerp(rifleSteel, 0.08);
        } else if(lum < 0.36 && _vmColorIsWoodish(c)) {
          m.color.lerp(rifleWood, 0.4);
          m.roughness = THREE.MathUtils.clamp((m.roughness != null ? m.roughness : 0.5) + 0.06, 0.28, 0.92);
          m.metalness = THREE.MathUtils.clamp((m.metalness != null ? m.metalness : 0.5) * 0.62, 0.04, 0.35);
        } else if(lum > 0.38 && lum <= 0.58) {
          // GLB 常见：整枪单一浅灰材质 — 压暗并去冷色，避免「一片浅蓝灰」
          m.color.lerp(rifleMidFix, 0.38);
          m.color.lerp(rifleSteel, 0.14);
          m.metalness = THREE.MathUtils.clamp((m.metalness != null ? m.metalness : 0.5) * 0.92, 0.12, 0.78);
          m.roughness = THREE.MathUtils.clamp((m.roughness != null ? m.roughness : 0.5) + 0.05, 0.32, 0.92);
        } else {
          m.color.lerp(lum < 0.42 ? rifleSteel : rifleSteelHi, 0.2);
          m.metalness = THREE.MathUtils.clamp((m.metalness != null ? m.metalness : 0.5) + 0.04, 0.1, 0.82);
        }
      } else if(weaponType === 'pistol') {
        if(lum < 0.27) {
          m.color.lerp(uspFrame, 0.32);
          m.metalness = THREE.MathUtils.clamp((m.metalness != null ? m.metalness : 0.5) * 0.45, 0.04, 0.45);
        } else {
          m.color.lerp(uspSlide, 0.26);
        }
        m.roughness = THREE.MathUtils.clamp((m.roughness != null ? m.roughness : 0.45) + 0.08, 0.32, 0.9);
      } else if(weaponType === 'sniper') {
        const gish = c.g > c.r * 0.92 && c.g > c.b * 0.82;
        if(lum < 0.19) {
          m.color.lerp(awpMetalBlack, 0.38);
          m.color.lerp(awpMetal, 0.1);
        } else if(gish || (lum > 0.24 && lum < 0.52)) {
          m.color.lerp(awpOlive, lum < 0.35 ? 0.36 : 0.28);
          m.color.lerp(awpOliveHi, 0.06);
          m.metalness = THREE.MathUtils.clamp((m.metalness != null ? m.metalness : 0.5) * 0.38, 0.05, 0.42);
          m.roughness = THREE.MathUtils.clamp((m.roughness != null ? m.roughness : 0.5) + 0.14, 0.48, 0.94);
        } else {
          m.color.lerp(awpMetal, 0.26);
          m.metalness = THREE.MathUtils.clamp((m.metalness != null ? m.metalness : 0.5) * 0.88, 0.12, 0.78);
        }
      }
    });
  });
}

function _vmVec3(arr) {
  if(!arr || arr.length < 3) return new THREE.Vector3(0, 0, 0);
  return new THREE.Vector3(arr[0], arr[1], arr[2]);
}
function _vmEuler(arr) {
  if(!arr || arr.length < 3) return new THREE.Euler(0, Math.PI / 2, 0, 'XYZ');
  return new THREE.Euler(arr[0], arr[1], arr[2], 'XYZ');
}

// ============================================================
// VIEWMODEL (First-person weapon rendering)
// ============================================================
function setupViewmodel() {
  // 独立场景叠在画面上；太阳光/半球/环境光每帧从主场景同步（updateViewmodelLighting）
  viewmodelScene = new THREE.Scene();
  vmAmbientLight = new THREE.AmbientLight(0xd4c4a0, 0.6);
  viewmodelScene.add(vmAmbientLight);
  vmSunLight = new THREE.DirectionalLight(0xfff0d0, 1.2);
  vmSunLight.castShadow = false;
  vmSunLight.target.position.set(0, 0, 0);
  viewmodelScene.add(vmSunLight.target);
  viewmodelScene.add(vmSunLight);
  vmHemisphereLight = new THREE.HemisphereLight(0x87CEEB, 0xc8a870, 0.5);
  viewmodelScene.add(vmHemisphereLight);

  viewmodelCamera = new THREE.PerspectiveCamera(VM_FOV_HIP, window.innerWidth/window.innerHeight, 0.01, 10);
  viewmodelCamera.position.set(0, 0, 0);

  weaponGroup = new THREE.Group();
  viewmodelScene.add(weaponGroup);

  const loader = new GLTFLoader();
  const WEAPONS_MANIFEST_URL = 'assets/models/weapons_manifest.json';
  /** 与 weapons_manifest.json 同步；fetch 失败时使用 */
  const FALLBACK_MANIFEST = {"version":1,"defaults":{"meshAlignEuler":[0,90,0],"targetSize":0.6,"rollExtraDeg":2.87},"weapons":[{"id":"rifle","url":"assets/models/assault_rifle.glb","fallback":"procedural_ak","glbPos":[0.3,-0.15,-0.42],"glbRot":[5.73,-1.15,2.29],"targetSize":0.42,"vmScale":0.55},{"id":"pistol","url":"assets/models/pistol.glb","fallback":"procedural_usp","glbPos":[0.28,-0.1,-0.35],"glbRot":[2.86,1.15,1.72],"targetSize":0.5,"vmScale":0.8},{"id":"sniper","url":"assets/models/sniper_rifle.glb","fallback":"procedural_awp","glbPos":[0.34,-0.2,-0.48],"glbRot":[4.58,-1.72,1.72],"targetSize":0.65,"vmScale":1},{"id":"melee","url":"assets/models/m9_bayonet_knife.glb","fallback":"procedural_knife","meshAlignEuler":[90,-90,0],"rollExtraDeg":0,"glbPos":[0.26,-0.06,-0.38],"glbRot":[206,-5,96],"targetSize":0.55,"vmScale":0.5}]};

  /** glbRot、meshAlignEuler 在 JSON 中一律为角度（度），内部转为弧度 */
  function parseScopeView(entry) {
    const sv = entry.scopeView;
    if(!sv || typeof sv !== 'object') return null;
    const DEG = Math.PI / 180;
    const pos = Array.isArray(sv.offsetPos) && sv.offsetPos.length >= 3
      ? [Number(sv.offsetPos[0]) || 0, Number(sv.offsetPos[1]) || 0, Number(sv.offsetPos[2]) || 0]
      : [0, 0, 0];
    const rot = Array.isArray(sv.offsetRotDeg) && sv.offsetRotDeg.length >= 3
      ? [sv.offsetRotDeg[0] * DEG, sv.offsetRotDeg[1] * DEG, sv.offsetRotDeg[2] * DEG]
      : [0, 0, 0];
    return { pos, rot };
  }

  function mergeWeaponEntry(entry, defaults) {
    const d = defaults || {};
    const DEG = Math.PI / 180;
    function degToRad3(arr) {
      if(!arr || arr.length < 3) return [0, 0, 0];
      return [arr[0] * DEG, arr[1] * DEG, arr[2] * DEG];
    }
    const defaultMeshDeg = [0, 90, 0];
    const mSrc = entry.meshAlignEuler != null ? entry.meshAlignEuler : (d.meshAlignEuler != null ? d.meshAlignEuler : defaultMeshDeg);
    const meshAlign = degToRad3(mSrc);
    const rSrc = entry.glbRot != null ? entry.glbRot : [0, 0, 0];
    const glbRot = degToRad3(rSrc);
    var rollDeg = entry.rollExtraDeg != null ? entry.rollExtraDeg : (d.rollExtraDeg != null ? d.rollExtraDeg : 2.87);
    var rollExtraRad = rollDeg * DEG;
    const ts = entry.targetSize != null ? entry.targetSize : (d.targetSize != null ? d.targetSize : 0.6);
    const dMelee = d.meleeView && typeof d.meleeView === 'object' ? { ...d.meleeView } : {};
    const eMelee = entry.meleeView && typeof entry.meleeView === 'object' ? { ...entry.meleeView } : {};
    const mergedMelee = { ...dMelee, ...eMelee };
    const meleeView = Object.keys(mergedMelee).length ? mergedMelee : null;
    return {
      id: entry.id,
      url: entry.url,
      fallback: entry.fallback || 'procedural_ak',
      targetSize: ts,
      meshAlignEuler: meshAlign,
      glbPos: entry.glbPos || [0, 0, 0],
      glbRot: glbRot,
      vmScale: entry.vmScale,
      rollExtraRad: rollExtraRad,
      scopeView: parseScopeView(entry),
      meleeView
    };
  }

  function applyWeaponManifestUserData(model, merged, isGLB) {
    model.userData.glbPos = _vmVec3(merged.glbPos);
    model.userData.glbRot = _vmEuler(merged.glbRot);
    model.userData.meshAlignEuler = _vmEuler(merged.meshAlignEuler);
    model.userData.isGLB = !!isGLB;
    model.userData.useManifestView = true;
    if(merged.vmScale != null) model.userData.vmScale = merged.vmScale;
    else delete model.userData.vmScale;
    model.userData.rollExtraRad = merged.rollExtraRad != null ? merged.rollExtraRad : 0.05;
    if(merged.scopeView) model.userData.scopeView = merged.scopeView;
    else delete model.userData.scopeView;
    if(merged.meleeView) model.userData.meleeView = merged.meleeView;
    else delete model.userData.meleeView;
  }

  function tryLoadFromManifestEntry(entry, onDone) {
    const fbMap = {
      procedural_ak: buildProceduralAK,
      procedural_usp: buildProceduralUSP,
      procedural_awp: buildProceduralAWP,
      procedural_knife: buildProceduralKnife
    };
    const fallbackFn = fbMap[entry.fallback] || buildProceduralAK;
    const align = _vmEuler(entry.meshAlignEuler);
    const targetSize = entry.targetSize;

    loader.load(entry.url, function(gltf) {
      const model = gltf.scene;
      const bbox = new THREE.Box3().setFromObject(model);
      const size = bbox.getSize(new THREE.Vector3());
      const rawMax = Math.max(size.x, size.y, size.z);
      const maxDim = Math.max(rawMax, 1e-4);
      let autoScale = targetSize / maxDim;
      if(!isFinite(autoScale) || autoScale <= 0) autoScale = 0.05;
      autoScale = Math.min(autoScale, 12);
      model.scale.set(autoScale, autoScale, autoScale);
      model.rotation.copy(align);
      model.traverse(function(child) {
        if(child.isMesh) child.castShadow = true;
      });
      applyViewmodelWeaponMaterials(model);
      weaponModels[entry.id] = model;
      applyWeaponManifestUserData(weaponModels[entry.id], entry, true);
      console.log('GLB loaded:', entry.id, 'scale:', autoScale.toFixed(3), 'maxDim:', maxDim.toFixed(2));
      onDone();
    }, undefined, function(err) {
      console.warn('GLB load failed for', entry.id, '- using procedural model', err && err.message ? err.message : '');
      weaponModels[entry.id] = fallbackFn();
      applyWeaponManifestUserData(weaponModels[entry.id], entry, false);
      onDone();
    });
  }

  function runManifest(manifest) {
    const defaults = manifest.defaults || {};
    const weapons = manifest.weapons || [];
    const mergedList = weapons.map(function(w) { return mergeWeaponEntry(w, defaults); });
    let loadedCount = 0;
    const total = mergedList.length;
    function onOne() {
      loadedCount++;
      if(loadedCount >= total) {
        setViewmodelWeapon('rifle');
        cacheAllWeaponBindMatrices();
      }
    }
    mergedList.forEach(function(m) { tryLoadFromManifestEntry(m, onOne); });
  }

  fetch(WEAPONS_MANIFEST_URL + '?v=6')
    .then(function(r) { if(!r.ok) throw new Error('manifest'); return r.json(); })
    .catch(function() { console.warn('weapons_manifest.json 不可用，使用内嵌默认配置'); return FALLBACK_MANIFEST; })
    .then(runManifest);

  // Build procedural fallback models
  function buildProceduralAK() {
  const akGroup = new THREE.Group();
  const gunMetal = new THREE.MeshStandardMaterial({ color:0x323a44, roughness:0.42, metalness:0.76 });
  const gunWood = new THREE.MeshStandardMaterial({ color:0x7a4520, roughness:0.78, metalness:0.06 });
  const gunDark = new THREE.MeshStandardMaterial({ color:0x1c1f26, roughness:0.4, metalness:0.84 });
  // Receiver body
  const recv = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.055, 0.32), gunMetal);
  recv.position.set(0, 0, -0.08);
  akGroup.add(recv);
  // Barrel
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.35, 8), gunMetal);
  barrel.rotation.x = Math.PI/2;
  barrel.position.set(0, 0.005, -0.41);
  akGroup.add(barrel);
  // Barrel tip / muzzle brake
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.013, 0.05, 8), gunDark);
  muzzle.rotation.x = Math.PI/2;
  muzzle.position.set(0, 0.005, -0.59);
  akGroup.add(muzzle);
  // Gas tube above barrel
  const gasTube = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.18, 6), gunWood);
  gasTube.rotation.x = Math.PI/2;
  gasTube.position.set(0, 0.035, -0.32);
  akGroup.add(gasTube);
  // Magazine (curved)
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.14, 0.04), gunDark);
  mag.position.set(0, -0.08, -0.06);
  mag.rotation.x = 0.15;
  akGroup.add(mag);
  // Stock (wooden)
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.2), gunWood);
  stock.position.set(0, -0.01, 0.18);
  akGroup.add(stock);
  // Grip
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.03), gunWood);
  grip.position.set(0, -0.06, 0.06);
  grip.rotation.x = 0.2;
  akGroup.add(grip);
  // Hand (right, holding grip)
  const handMat = new THREE.MeshStandardMaterial({ color:0xc8a090, roughness:0.78, metalness:0.04 });
  const handR = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.04, 0.06), handMat);
  handR.position.set(0, -0.06, 0.05);
  akGroup.add(handR);
  // Hand (left, on foregrip area)
  const handL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.05), handMat);
  handL.position.set(0, -0.02, -0.22);
  akGroup.add(handL);
  // Sight post
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.02, 0.005), gunMetal);
  sight.position.set(0, 0.045, -0.5);
  akGroup.add(sight);
  const rearSight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.015, 0.005), gunMetal);
  rearSight.position.set(0, 0.04, 0.04);
  akGroup.add(rearSight);

  return akGroup;
  }

  // --- Build USP pistol model ---
  function buildProceduralUSP() {
  const uspGroup = new THREE.Group();
  const handMat = new THREE.MeshStandardMaterial({ color:0xc8a090, roughness:0.78, metalness:0.04 });
  const pistolMat = new THREE.MeshStandardMaterial({ color:0x5c646e, roughness:0.46, metalness:0.7 });
  const pistolGrip = new THREE.MeshStandardMaterial({ color:0x12161c, roughness:0.62, metalness:0.12 });
  // Slide
  const slide = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.035, 0.17), pistolMat);
  slide.position.set(0, 0.01, -0.02);
  uspGroup.add(slide);
  // Barrel
  const pBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.008, 0.06, 6), pistolMat);
  pBarrel.rotation.x = Math.PI/2;
  pBarrel.position.set(0, 0.005, -0.14);
  uspGroup.add(pBarrel);
  // Frame / grip
  const pGrip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, 0.04), pistolGrip);
  pGrip.position.set(0, -0.04, 0.03);
  pGrip.rotation.x = 0.15;
  uspGroup.add(pGrip);
  // Trigger guard
  const tGuard = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.005, 0.03), pistolMat);
  tGuard.position.set(0, -0.015, 0.0);
  uspGroup.add(tGuard);
  // Hand holding pistol
  const pHandR = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.045, 0.065), handMat);
  pHandR.position.set(0, -0.05, 0.02);
  uspGroup.add(pHandR);
  // Left hand support
  const pHandL = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.04, 0.055), handMat);
  pHandL.position.set(-0.015, -0.04, 0.01);
  uspGroup.add(pHandL);

  return uspGroup;
  }

  // --- Build Knife model ---
  function buildProceduralKnife() {
    const knifeGroup = new THREE.Group();
    const bladeMat = new THREE.MeshStandardMaterial({ color:0xc0c0c0, roughness:0.3, metalness:0.8 });
    const handleMat = new THREE.MeshStandardMaterial({ color:0x2a2a2a, roughness:0.7, metalness:0.1 });
    // Blade
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.04, 0.005), bladeMat);
    blade.position.set(0, 0.02, -0.15);
    knifeGroup.add(blade);
    // Blade tip
    const bladeTip = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.015, 0.004), bladeMat);
    bladeTip.position.set(0, 0.02, -0.19);
    bladeTip.rotation.x = 0.3;
    knifeGroup.add(bladeTip);
    // Handle
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.06, 0.015), handleMat);
    handle.position.set(0, -0.02, 0);
    knifeGroup.add(handle);
    return knifeGroup;
  }

  // --- Build AWP sniper model ---
  function buildProceduralAWP() {
  const awpGroup = new THREE.Group();
  const handMat = new THREE.MeshStandardMaterial({ color:0x2a2e35, roughness:0.82, metalness:0.06 });
  const sniperMat = new THREE.MeshStandardMaterial({ color:0x3f4d38, roughness:0.82, metalness:0.12 });
  const sniperDark = new THREE.MeshStandardMaterial({ color:0x101214, roughness:0.44, metalness:0.72 });
  // Long receiver
  const sRecv = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.4), sniperMat);
  sRecv.position.set(0, 0, -0.05);
  awpGroup.add(sRecv);
  // Long barrel
  const sBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.018, 0.5, 8), sniperDark);
  sBarrel.rotation.x = Math.PI/2;
  sBarrel.position.set(0, 0.005, -0.5);
  awpGroup.add(sBarrel);
  // Muzzle brake
  const sMuzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.018, 0.06, 8), sniperDark);
  sMuzzle.rotation.x = Math.PI/2;
  sMuzzle.position.set(0, 0.005, -0.76);
  awpGroup.add(sMuzzle);
  // 瞄准镜外管：与 CS:GO 一致为橄榄绿聚合物；物镜偏青绿反光
  const scopeBody = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 8), sniperMat);
  scopeBody.rotation.x = Math.PI/2;
  scopeBody.position.set(0, 0.055, -0.06);
  awpGroup.add(scopeBody);
  const scopeLens = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.005, 8),
    new THREE.MeshStandardMaterial({ color:0x2a3d42, roughness:0.06, metalness:0.2, transparent:true, opacity:0.58 }));
  scopeLens.rotation.x = Math.PI/2;
  scopeLens.position.set(0, 0.055, -0.14);
  awpGroup.add(scopeLens);
  // Scope mounts
  const mount1 = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.02, 0.015), sniperDark);
  mount1.position.set(0, 0.035, -0.02);
  awpGroup.add(mount1);
  const mount2 = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.02, 0.015), sniperDark);
  mount2.position.set(0, 0.035, -0.1);
  awpGroup.add(mount2);
  // Stock
  const sStock = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.22), sniperMat);
  sStock.position.set(0, -0.005, 0.22);
  awpGroup.add(sStock);
  // Cheek rest
  const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.015, 0.08), sniperMat);
  cheek.position.set(0, 0.03, 0.22);
  awpGroup.add(cheek);
  // Mag
  const sMag = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.1, 0.04), sniperDark);
  sMag.position.set(0, -0.06, -0.02);
  awpGroup.add(sMag);
  // Grip
  const sGrip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.065, 0.03), sniperMat);
  sGrip.position.set(0, -0.05, 0.08);
  sGrip.rotation.x = 0.15;
  awpGroup.add(sGrip);
  // Bipod legs (folded)
  const bipod1 = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.1, 4), sniperDark);
  bipod1.position.set(0.015, -0.04, -0.3);
  bipod1.rotation.x = 0.3;
  awpGroup.add(bipod1);
  const bipod2 = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.1, 4), sniperDark);
  bipod2.position.set(-0.015, -0.04, -0.3);
  bipod2.rotation.x = 0.3;
  awpGroup.add(bipod2);
  // Hands
  const sHandR = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.04, 0.06), handMat);
  sHandR.position.set(0, -0.05, 0.07);
  awpGroup.add(sHandR);
  const sHandL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.05), handMat);
  sHandL.position.set(0, -0.02, -0.22);
  awpGroup.add(sHandL);

  return awpGroup;
  }

  // Fallback: GLB 长时间未返回时用程序枪模（极少触发）
  setTimeout(function() {
    function ensureProcedural(id, buildFn) {
      if(weaponModels[id]) return;
      const raw = (FALLBACK_MANIFEST.weapons || []).find(function(w) { return w.id === id; });
      if(!raw) return;
      weaponModels[id] = buildFn();
      applyWeaponManifestUserData(weaponModels[id], mergeWeaponEntry(raw, FALLBACK_MANIFEST.defaults), false);
    }
    ensureProcedural('rifle', buildProceduralAK);
    ensureProcedural('pistol', buildProceduralUSP);
    ensureProcedural('sniper', buildProceduralAWP);
    ensureProcedural('melee', buildProceduralKnife);
    if(!weaponGroup.children.length) setViewmodelWeapon('rifle');
  }, 3000);

  setupViewmodelEnvironmentMap();
}

function setViewmodelWeapon(type) {
  // Remove all children
  while(weaponGroup.children.length) weaponGroup.remove(weaponGroup.children[0]);
  const model = weaponModels[type];
  if(!model) return;

  // 含 SkinnedMesh 的 GLB（如 ak47）必须用 SkeletonUtils.clone，否则骨骼错误导致第一/三人称枪体不可见
  const clone = SkeletonUtils.clone(model);
  applyViewmodelWeaponMaterials(clone);
  tintCsgoViewmodelColors(clone, type);
  if(type === 'rifle') {
    clone.traverse(function(ch) {
      if(!ch.isMesh || !ch.material) return;
      const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
      mats.forEach(function(m) {
        if(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
          m.envMapIntensity = (m.envMapIntensity != null ? m.envMapIntensity : 1) * 0.8;
          m.roughness = THREE.MathUtils.clamp((m.roughness != null ? m.roughness : 0.5) + 0.04, 0.24, 0.95);
        }
      });
    });
  }
  if(type === 'sniper') {
    clone.traverse(function(ch) {
      if(!ch.isMesh || !ch.material) return;
      const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
      mats.forEach(function(m) {
        if(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
          m.envMapIntensity = (m.envMapIntensity != null ? m.envMapIntensity : 1) * 0.78;
          m.roughness = THREE.MathUtils.clamp((m.roughness != null ? m.roughness : 0.5) + 0.08, 0.2, 0.95);
        }
      });
    });
  }
  // GLB 已在加载时做过 meshAlign，勿再叠程序圆柱手臂（与枪旋转不一致会像悬浮枪管）
  weaponGroup.add(clone);

  /** 小刀：蒙皮模型 clone 后局部旋转易丢，用四元数合并 meshAlign * glbRot 到父节点，子节点归零，与加载时 R_group*R_mesh 一致 */
  let meleeMergedQuat = false;
  if(type === 'melee' && model.userData && model.userData.meshAlignEuler && model.userData.glbRot) {
    clone.rotation.set(0, 0, 0);
    clone.quaternion.identity();
    const qM = new THREE.Quaternion().setFromEuler(model.userData.meshAlignEuler);
    const qG = new THREE.Quaternion().setFromEuler(model.userData.glbRot);
    weaponGroup.quaternion.multiplyQuaternions(qG, qM);
    meleeMergedQuat = true;
  } else if(type === 'melee' && model.userData && model.userData.meshAlignEuler) {
    clone.rotation.copy(model.userData.meshAlignEuler);
  }

  // 标准FPS枪械位置 - 枪在相机前方（weapons_manifest.json 驱动时走 useManifestView）
  if(model.userData && model.userData.useManifestView && model.userData.glbPos) {
    weaponGroup.position.copy(model.userData.glbPos);
    if(!meleeMergedQuat) weaponGroup.rotation.copy(model.userData.glbRot);
  } else if(model.userData && model.userData.isGLB) {
    const pos = model.userData.glbPos;
    const rot = model.userData.glbRot;
    weaponGroup.position.copy(pos);
    weaponGroup.rotation.set(rot.x, rot.y, rot.z);
  } else {
    if(type === 'rifle') {
      weaponGroup.position.set(0.32, -0.16, -0.42);
      weaponGroup.rotation.set(0.10, -0.02, 0.04);
    } else if(type === 'pistol') {
      weaponGroup.position.set(0.28, -0.10, -0.35);
      weaponGroup.rotation.set(0.05, 0.02, 0.03);
    } else if(type === 'sniper') {
      weaponGroup.position.set(0.34, -0.20, -0.48);
      weaponGroup.rotation.set(0.08, -0.03, 0.03);
    } else {
      weaponGroup.position.set(0.38, -0.14, -0.32);
      weaponGroup.rotation.set(0.12, 0.20, 0.06);
    }
  }
  const rollExtra = model.userData && model.userData.rollExtraRad != null ? model.userData.rollExtraRad : 0.05;
  if(meleeMergedQuat && rollExtra !== 0) {
    weaponGroup.rotation.setFromQuaternion(weaponGroup.quaternion, 'XYZ');
    weaponGroup.rotation.z += rollExtra;
  } else if(meleeMergedQuat) {
    weaponGroup.rotation.setFromQuaternion(weaponGroup.quaternion, 'XYZ');
  } else {
    weaponGroup.rotation.z += rollExtra;
  }
  let vmSc;
  if(model.userData && model.userData.vmScale != null) vmSc = model.userData.vmScale;
  else vmSc = type === 'pistol' ? 0.8 : type === 'sniper' ? 1.0 : type === 'melee' ? 0.5 : 0.85;
  weaponGroup.scale.set(vmSc, vmSc, vmSc);
  weaponGroup.userData.vmBaseScale = vmSc;
  weaponGroup.userData.basePos = weaponGroup.position.clone();
  weaponGroup.userData.baseRot = weaponGroup.rotation.clone();
  weaponGroup.userData.scopeView = model.userData.scopeView || null;
  weaponGroup.userData.meleeView = model.userData.meleeView || null;
  rebuildThirdPersonWeaponClone();
  weaponGroup.updateMatrix();
  weaponBindMatrixByType[type] = weaponGroup.matrix.clone();
}

function rebuildThirdPersonWeaponClone() {
  if(!thirdPersonWeaponRoot || !weaponGroup) return;
  while(thirdPersonWeaponRoot.children.length) {
    thirdPersonWeaponRoot.remove(thirdPersonWeaponRoot.children[0]);
  }
  if(!weaponGroup.children.length) return;
  const src = weaponGroup.children[0];
  // assault_rifle.glb 等常含 SkinnedMesh：普通 clone(true) 不会重映射 skeleton.bones，蒙皮会画在世界原点（地图中央）
  const clone = SkeletonUtils.clone(src);
  clone.traverse(function(ch) {
    if(ch.isMesh) ch.castShadow = true;
  });
  thirdPersonWeaponRoot.add(clone);
}

function updateThirdPersonWeaponMatrix() {
  if(!thirdPersonWeaponRoot || !weaponGroup || !camera) return;
  const show = thirdPerson && GAME.running && !GAME.paused && weaponGroup.children.length > 0 && weaponGroup.visible;
  thirdPersonWeaponRoot.visible = !!show;
  if(!show) return;
  camera.updateMatrixWorld(true);
  weaponGroup.updateMatrix();
  weaponGroup.updateMatrixWorld(true);
  // 使用与相机同一视空间下的局部矩阵；parent 为 viewmodelScene（单位变换）时与 matrixWorld 一致
  _tpWpnMatrix.multiplyMatrices(camera.matrixWorld, weaponGroup.matrix);
  _tpWpnWorldDown.makeTranslation(0, THIRD_PERSON_WEAPON_Y_OFFSET, 0);
  thirdPersonWeaponRoot.matrix.multiplyMatrices(_tpWpnWorldDown, _tpWpnMatrix);
  // matrixAutoUpdate=false 时必须更新世界矩阵，否则子网格仍按单位矩阵绘制在世界原点（地图中央会凭空出现一把枪）
  thirdPersonWeaponRoot.updateMatrixWorld(true);
}

/** 将地图太阳与天空环境变换到主相机视角空间，使枪械高光随视角/朝向与场景一致 */
function updateViewmodelLighting() {
  if(!mapSunLight || !vmSunLight || !camera) return;
  camera.updateMatrixWorld(true);
  mapSunLight.updateMatrixWorld(true);
  mapSunLight.target.updateMatrixWorld(true);
  _vmLightPos.copy(mapSunLight.position).applyMatrix4(camera.matrixWorldInverse);
  _vmLightTgt.copy(mapSunLight.target.position).applyMatrix4(camera.matrixWorldInverse);
  vmSunLight.position.copy(_vmLightPos);
  vmSunLight.target.position.copy(_vmLightTgt);
  vmSunLight.color.copy(mapSunLight.color);
  vmSunLight.intensity = mapSunLight.intensity * VM_SUN_MULT;
  if(mapAmbientLight && vmAmbientLight) {
    vmAmbientLight.color.copy(mapAmbientLight.color);
    vmAmbientLight.intensity = mapAmbientLight.intensity * VM_AMBIENT_MULT;
  }
  if(mapHemisphereLight && vmHemisphereLight) {
    vmHemisphereLight.color.copy(mapHemisphereLight.color);
    vmHemisphereLight.groundColor.copy(mapHemisphereLight.groundColor);
    vmHemisphereLight.intensity = mapHemisphereLight.intensity * VM_HEMI_MULT;
  }
}

function updateViewmodel(dt) {
  if(!weaponGroup || !weaponGroup.userData.basePos) return;
  const base = weaponGroup.userData.basePos;
  const baseRot = weaponGroup.userData.baseRot;
  const sniperVm = currentWeapon().type === 'sniper';
  const scopeAnimProgress = sniperVm && scopeZoomElapsed > 0
    ? Math.min(1, scopeZoomElapsed / SCOPE_ZOOM_DURATION)
    : 0;
  const scopeT = sniperVm ? Math.min(1, scopeAnimProgress / 0.92) : 0;
  const scopeEase = scopeT * scopeT * (3 - 2 * scopeT);
  let bx = base.x;
  let by = base.y;
  let bz = base.z;
  let brx = baseRot.x;
  let bry = baseRot.y;
  let brz = baseRot.z;
  if(sniperVm && scopeZoomElapsed > 0) {
    // 在上版幅度上：整体 ×0.7；往左（负 X）再 ×1.6；往上再 ×0.5×0.5
    const kAll = 0.7;
    const kLeft = 1.6;
    const kUp = 0.25;
    const ax = -0.165 * 0.9 * 1.4;
    bx += THREE.MathUtils.lerp(0, ax * kAll * kLeft, scopeEase);
    by += THREE.MathUtils.lerp(0, 0.132 * 0.9 * kAll * kUp, scopeEase);
    bz += THREE.MathUtils.lerp(0, 0.099 * 0.9 * kAll, scopeEase);
    brx += THREE.MathUtils.lerp(0, 0.0605 * 0.9 * kAll, scopeEase);
    bry += THREE.MathUtils.lerp(0, 0.055 * 0.9 * kAll, scopeEase);
    brz += THREE.MathUtils.lerp(0, -0.0385 * 0.9 * kAll, scopeEase);
    // 开镜末段：枪口/镜轴对准准星（削弱腰射 yaw+roll 带来的歪扭，略抬 pitch）
    const aimW = scopeEase * scopeEase;
    const aimEnd = Math.max(0, (scopeEase - 0.5) / 0.5);
    const aimE = aimEnd * aimEnd * aimW;
    bry -= aimE * 0.078;
    brz += aimE * 0.095;
    brx += aimE * 0.022;
    // 最终姿态：略往右、往下（与 aimE 同步，末段最明显）
    bx += aimE * 0.055;
    by -= aimE * 0.10;
  }
  const scopeUser = weaponGroup.userData.scopeView;
  if(sniperVm && scopeZoomElapsed > 0 && scopeUser && scopeUser.pos && scopeUser.rot) {
    const se = scopeEase;
    bx += scopeUser.pos[0] * se;
    by += scopeUser.pos[1] * se;
    bz += scopeUser.pos[2] * se;
    brx += scopeUser.rot[0] * se;
    bry += scopeUser.rot[1] * se;
    brz += scopeUser.rot[2] * se;
  }
  weaponGroup.visible = !(sniperVm && scopeZoomElapsed >= SCOPE_VM_HIDE_AT);

  // Bob
  const isMoving = moveForward||moveBackward||moveLeft||moveRight;
  const bobSpeed = isSprinting ? 10 : 7;
  const bobAmount = isSprinting ? 0.022 : 0.016;
  const bobX = isMoving ? Math.sin(weaponBob * bobSpeed / 8) * bobAmount : 0;
  const bobY = isMoving ? Math.abs(Math.cos(weaponBob * bobSpeed / 8)) * bobAmount * 0.75 : 0;

  // CS:GO 式 view punch：连射时略慢；停火后明显加快回中（与弹道恢复一致）
  const idleVm = (performance.now() - lastSprayAt) > 95;
  const ep = Math.exp(-dt * (idleVm ? 21 : 13));
  const ey = Math.exp(-dt * (idleVm ? 25 : 16));
  const er = Math.exp(-dt * (idleVm ? 24 : 15.5));
  const epos = Math.exp(-dt * (idleVm ? 26 : 17.5));
  vmPunch.pitch *= ep;
  vmPunch.yaw *= ey;
  vmPunch.roll *= er;
  vmPunch.x *= epos;
  vmPunch.y *= epos;
  vmPunch.z *= epos;
  vmPunch.pitch = THREE.MathUtils.clamp(vmPunch.pitch, -0.28, 0.28);
  vmPunch.yaw = THREE.MathUtils.clamp(vmPunch.yaw, -0.2, 0.2);
  vmPunch.roll = THREE.MathUtils.clamp(vmPunch.roll, -0.07, 0.07);
  vmPunch.x = THREE.MathUtils.clamp(vmPunch.x, -0.018, 0.018);
  vmPunch.y = THREE.MathUtils.clamp(vmPunch.y, -0.022, 0.022);
  vmPunch.z = THREE.MathUtils.clamp(vmPunch.z, -0.045, 0.045);
  if(Math.abs(vmPunch.pitch) < 0.0005) vmPunch.pitch = 0;
  if(Math.abs(vmPunch.yaw) < 0.0005) vmPunch.yaw = 0;
  if(Math.abs(vmPunch.roll) < 0.00025) vmPunch.roll = 0;
  if(Math.abs(vmPunch.x) < 0.00006) vmPunch.x = 0;
  if(Math.abs(vmPunch.y) < 0.00006) vmPunch.y = 0;
  if(Math.abs(vmPunch.z) < 0.00012) vmPunch.z = 0;
  const sinceLastShotVm = performance.now() - lastSprayAt;
  if(sinceLastShotVm > VM_RECOIL_BACK_DECAY_AFTER_MS) {
    vmRecoilBackZ *= Math.exp(-dt * 4.6);
    if(Math.abs(vmRecoilBackZ) < 0.00015) vmRecoilBackZ = 0;
  }
  const wVm = currentWeapon();
  const backMax = wVm.vmRecoilBackMax != null ? wVm.vmRecoilBackMax : 0.1;
  vmRecoilBackZ = THREE.MathUtils.clamp(vmRecoilBackZ, 0, backMax);
  const sprayBoost = 1 + Math.min(0.22, sprayConsecutive * 0.015 + Math.hypot(recoilOffset.x, recoilOffset.y) * 9);
  const rifleVm = wVm.type === 'rifle';
  // 步枪：模型以后坐（+Z）为主，压低 pitch 上抬与连射放大
  const pbMul = rifleVm ? 0.42 : 1;
  const pbCap = rifleVm ? 0.085 : 0.24;
  const pb = THREE.MathUtils.clamp(vmPunch.pitch * sprayBoost * pbMul, -pbCap, pbCap);
  const yb = THREE.MathUtils.clamp(vmPunch.yaw * sprayBoost * (rifleVm ? 0.55 : 1), -0.18, 0.18);
  const rb = THREE.MathUtils.clamp(vmPunch.roll * sprayBoost * (rifleVm ? 0.5 : 1), -0.065, 0.065);

  // Switch animation (drop and raise)
  if(vmSwitchY > 0.01) {
    vmSwitchY *= 0.88;
  } else {
    vmSwitchY = 0;
  }

  let reloadDip = 0;
  let reloadPitch = 0;
  let reloadYaw = 0;
  if(isReloading && reloadStartTime > 0 && reloadDurationMs > 0) {
    const t = Math.min(1, (performance.now() - reloadStartTime) / reloadDurationMs);
    const wave = Math.sin(t * Math.PI);
    reloadDip = wave * 0.11;
    reloadPitch = wave * 0.42;
    reloadYaw = Math.sin(t * Math.PI * 2) * 0.06 * wave;
    vmReloadRot = t;
  } else {
    vmReloadRot *= 0.82;
  }

  let vmBoltPitch = 0;
  let vmBoltZ = 0;
  if(sniperVm && awpBoltAnimRemaining > 0) {
    awpBoltAnimRemaining -= dt;
    const totalCd = wVm.fireRate / 1000;
    const elapsed = totalCd - Math.max(0, awpBoltAnimRemaining);
    const p = Math.min(1, elapsed / AWP_BOLT_VISUAL_DURATION);
    vmBoltPitch = Math.sin(p * Math.PI) * 0.17;
    vmBoltZ = Math.sin(p * Math.PI) * 0.034;
  }

  // 小刀：左键轻击；右键蓄力/刺击/收回时间由 manifest meleeView 控制
  const mvParams = wVm.type === 'melee' ? getMeleeVmParams(weaponGroup) : null;
  const mt = getMeleeTiming(mvParams);
  const heavyFullMs = mt.heavyHitMs + mt.heavyRecoverMs;
  const aimAbx = mvParams
    ? (mvParams.meleeAttackAimBiasX != null ? mvParams.meleeAttackAimBiasX : DEFAULT_MELEE_VM.meleeAttackAimBiasX)
    : 0;
  const aimAby = mvParams
    ? (mvParams.meleeAttackAimBiasY != null ? mvParams.meleeAttackAimBiasY : DEFAULT_MELEE_VM.meleeAttackAimBiasY)
    : 0;
  if(mvParams && wVm.type === 'melee' && !meleeLightHeld) {
    const k = Math.exp(-dt * 20);
    meleeLightResidual.brx *= k;
    meleeLightResidual.bry *= k;
    meleeLightResidual.brz *= k;
    meleeLightResidual.bx *= k;
    meleeLightResidual.by *= k;
    meleeLightResidual.bz *= k;
  }
  const rawSeqElapsed = meleeHeavySequenceActive && wVm.type === 'melee' ? (performance.now() - meleeHeavySequenceStart) : -1;
  const seqElapsed = rawSeqElapsed >= 0 ? Math.min(rawSeqElapsed, heavyFullMs) : -1;
  if(mvParams && rawSeqElapsed >= 0 && rawSeqElapsed < mt.heavyChargeMs) {
    const p = Math.min(1, rawSeqElapsed / mt.heavyChargeMs);
    const ease = p * p;
    bz += ease * mvParams.chargePullZ;
    brx += ease * mvParams.chargePullRx;
    by += ease * mvParams.chargePullY;
  }
  if(mvParams && meleeHeavySequenceActive && seqElapsed >= mt.heavyChargeMs) {
    const strikeDur = mt.heavyHitMs - mt.heavyChargeMs;
    const tThrust = strikeDur > 1e-6
      ? Math.min(1, Math.max(0, (Math.min(seqElapsed, mt.heavyHitMs) - mt.heavyChargeMs) / strikeDur))
      : 1;
    let off;
    if(seqElapsed < mt.heavyHitMs) {
      off = getHeavyStrikeOffsets(mvParams, tThrust);
      // 准心平移仅在刺出段：0→满，与刺出同步（蓄力段不平移）
      const aimMul = 1 - Math.cos(tThrust * Math.PI * 0.5);
      bx += aimAbx * aimMul;
      by += aimAby * aimMul;
    } else {
      const peak = getHeavyStrikeOffsets(mvParams, 1);
      const recDur = heavyFullMs - mt.heavyHitMs;
      const recT = recDur > 1e-6 ? Math.min(1, (seqElapsed - mt.heavyHitMs) / recDur) : 1;
      const fade = Math.cos(recT * Math.PI * 0.5);
      off = {
        brx: peak.brx * fade,
        by: peak.by * fade,
        bz: peak.bz * fade,
        brz: peak.brz * fade
      };
      bx += aimAbx * fade;
      by += aimAby * fade;
    }
    brx += off.brx;
    by += off.by;
    bz += off.bz;
    brz += off.brz;
  }
  if(mvParams && wVm.type === 'melee' && meleeLightHeld && !isMeleeAttacking && !meleeHeavySequenceActive) {
    brx += meleeLightResidual.brx;
    bry += meleeLightResidual.bry;
    brz += meleeLightResidual.brz;
    bx += meleeLightResidual.bx;
    by += meleeLightResidual.by;
    bz += meleeLightResidual.bz;
  }
  if(isMeleeAttacking && meleeAttackType === 'light' && wVm.type === 'melee' && mvParams) {
    const lightFullMs = mt.lightHitMs + mt.lightRecoverMs;
    const elapsed = performance.now() - meleeAttackStartTime;
    const cap = Math.min(elapsed, lightFullMs);
    const blendMs = mvParams.lightResidualBlendMs != null ? mvParams.lightResidualBlendMs : DEFAULT_MELEE_VM.lightResidualBlendMs;
    const rMul = elapsed < blendMs
      ? Math.cos(Math.min(1, elapsed / Math.max(1e-6, blendMs)) * Math.PI * 0.5)
      : 0;
    const rx = meleeLightResidual;
    if(cap < mt.lightHitMs) {
      const tStrike = mt.lightHitMs > 1e-6 ? cap / mt.lightHitMs : 1;
      const off = getLightStrikeOffsets(mvParams, tStrike, meleeLightRySign);
      const reach = mvParams.lightAimReachPortion != null ? mvParams.lightAimReachPortion : DEFAULT_MELEE_VM.lightAimReachPortion;
      const reachClamped = Math.min(0.95, Math.max(0.06, reach));
      const aimMul = tStrike < reachClamped
        ? 1 - Math.cos((tStrike / reachClamped) * Math.PI * 0.5)
        : 1;
      brx += off.brx + rx.brx * rMul;
      bry += off.bry + rx.bry * rMul;
      brz += off.brz + rx.brz * rMul;
      bx += off.bx + rx.bx * rMul + aimAbx * aimMul;
      by += off.by + rx.by * rMul + aimAby * aimMul;
      bz += off.bz + rx.bz * rMul;
    } else {
      const peak = getLightStrikeOffsets(mvParams, 1, meleeLightRySign);
      const recDur = lightFullMs - mt.lightHitMs;
      const recT = recDur > 1e-6 ? Math.min(1, (cap - mt.lightHitMs) / recDur) : 1;
      const carry = meleeLightHeld ? mt.lightRecoverCarryHeld : 0;
      const fade = THREE.MathUtils.lerp(carry, 1, Math.cos(recT * Math.PI * 0.5));
      brx += peak.brx * fade + rx.brx * rMul;
      bry += peak.bry * fade + rx.bry * rMul;
      brz += peak.brz * fade + rx.brz * rMul;
      bx += peak.bx * fade + rx.bx * rMul + aimAbx * fade;
      by += peak.by * fade + rx.by * rMul + aimAby * fade;
      bz += peak.bz * fade + rx.bz * rMul;
    }
    if(elapsed >= blendMs) {
      clearMeleeLightResidual();
    }
  }
  weaponGroup.position.set(
    bx + bobX + vmPunch.x,
    by + bobY - vmSwitchY + vmPunch.y - reloadDip,
    bz + vmPunch.z + vmRecoilBackZ + vmBoltZ
  );
  // 步枪：以后坐位移为主，不因后坐再额外大幅抬头；手枪/狙保留稍多「绕腕」感
  const wTypeVm = wVm.type;
  const backTilt = wTypeVm === 'rifle' ? vmRecoilBackZ * 0.04
    : wTypeVm === 'sniper' ? vmRecoilBackZ * 0.36
    : vmRecoilBackZ * 0.28;
  weaponGroup.rotation.set(
    brx - vmReloadRot * 0.28 + pb + reloadPitch + backTilt + vmBoltPitch,
    bry + reloadYaw + yb,
    brz + vmReloadRot * 0.22 + rb
  );

  const baseS = weaponGroup.userData.vmBaseScale != null ? weaponGroup.userData.vmBaseScale : 0.7;
  let sc = baseS;
  if(sniperVm && scopeZoomElapsed > 0) {
    sc = baseS * THREE.MathUtils.lerp(1, 2, scopeEase);
  }
  weaponGroup.scale.set(sc, sc, sc);

  updateThirdPersonWeaponMatrix();
}

// ============================================================
// GROUND DETAILS (visual improvement)
// ============================================================
function addGroundDetails() {
  // Sand-colored debris
  const debrisMat = new THREE.MeshStandardMaterial({ color:0xa09070, roughness:0.95 });
  for(let i = 0; i < 30; i++) {
    const s = 0.05 + Math.random() * 0.12;
    const geo = new THREE.BoxGeometry(s, s*0.3, s);
    const mesh = new THREE.Mesh(geo, debrisMat);
    mesh.position.set(
      (Math.random()-0.5) * GAME.mapSize * 0.8,
      s*0.15,
      (Math.random()-0.5) * GAME.mapSize * 0.8
    );
    mesh.rotation.y = Math.random() * Math.PI;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // Atmospheric desert dust particles
  const dustGeo = new THREE.BufferGeometry();
  const dustCount = 150;
  const dustPositions = new Float32Array(dustCount * 3);
  for(let i = 0; i < dustCount; i++) {
    dustPositions[i*3] = (Math.random()-0.5) * GAME.mapSize;
    dustPositions[i*3+1] = Math.random() * 5;
    dustPositions[i*3+2] = (Math.random()-0.5) * GAME.mapSize;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  const dustMat = new THREE.PointsMaterial({ color:0xc8b890, size:0.06, transparent:true, opacity:0.35 });
  const dustPoints = new THREE.Points(dustGeo, dustMat);
  scene.add(dustPoints);
  GAME.dustPoints = dustPoints;
}

// ============================================================
// MAP BUILDING
// ============================================================
function buildProceduralMap() {
  // === DE_DUST2 FAITHFUL RECREATION ===
  // Scale: ~1 Source unit = 0.026m, map ~105m = mapSize 60
  // Layout follows the real dust2 figure-eight with A/B sites, Mid, Long, Tunnels

  const W = 4.5; // standard wall height
  const T = 0.4; // wall thickness

  // Ground - sandy desert with texture
  const groundCanvas = document.createElement('canvas');
  groundCanvas.width = 256; groundCanvas.height = 256;
  const gCtx = groundCanvas.getContext('2d');
  gCtx.fillStyle = '#c8a870'; gCtx.fillRect(0,0,256,256);
  for(let i = 0; i < 4000; i++) {
    const v = 150+Math.floor(Math.random()*60);
    gCtx.fillStyle = `rgba(${v},${v-20},${v-50},0.05)`;
    gCtx.fillRect(Math.random()*256, Math.random()*256, 1+Math.random()*4, 1+Math.random()*4);
  }
  const groundTex = new THREE.CanvasTexture(groundCanvas);
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
  groundTex.repeat.set(8, 8);
  // Ground - sandy desert with texture (also use as collision floor)
  const groundGeo = new THREE.PlaneGeometry(GAME.mapSize, GAME.mapSize, 1, 1);
  const groundMat = new THREE.MeshStandardMaterial({ color:0xc8a870, roughness:0.92, metalness:0.02, map: groundTex });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI/2;
  ground.receiveShadow = true;
  scene.add(ground);
  // Add ground collision box for proper floor detection
  const groundBox = new THREE.Box3(
    new THREE.Vector3(-GAME.mapSize/2, -0.1, -GAME.mapSize/2),
    new THREE.Vector3(GAME.mapSize/2, 0, GAME.mapSize/2)
  );
  mapObjects.push({ mesh: ground, box: groundBox, materialType: 'ground' });

  // Road surfaces (darker paving)
  const roadMat = new THREE.MeshStandardMaterial({ color:0x9a8a6a, roughness:0.85, map: makeConcreteTex() });
  function addRoad(w,d,x,z) {
    const geo = new THREE.PlaneGeometry(w, d);
    const mesh = new THREE.Mesh(geo, roadMat);
    mesh.rotation.x = -Math.PI/2;
    mesh.position.set(x, 0.02, z);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // Materials - desert sandstone palette with procedural textures
  function makeWallTex(base, lineClr, bW, bH) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const x2 = c.getContext('2d');
    x2.fillStyle = base; x2.fillRect(0,0,256,256);
    // Noise
    for(let i = 0; i < 2500; i++) {
      const v = Math.floor(Math.random()*70);
      x2.fillStyle = `rgba(${v+80},${v+60},${v+30},0.06)`;
      x2.fillRect(Math.random()*256, Math.random()*256, 2+Math.random()*3, 2+Math.random()*3);
    }
    // Block lines
    if(bW > 0) {
      x2.strokeStyle = lineClr; x2.lineWidth = 1.2;
      let row = 0;
      for(let y = 0; y < 256; y += bH) {
        x2.beginPath(); x2.moveTo(0,y); x2.lineTo(256,y); x2.stroke();
        const off = (row%2) * bW/2;
        for(let xx = off; xx < 256; xx += bW) {
          x2.beginPath(); x2.moveTo(xx,y); x2.lineTo(xx,y+bH); x2.stroke();
        }
        row++;
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2,2);
    return t;
  }
  function makeConcreteTex() {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const x2 = c.getContext('2d');
    x2.fillStyle = '#b0a080'; x2.fillRect(0,0,128,128);
    for(let i = 0; i < 1500; i++) {
      const v = 100+Math.floor(Math.random()*80);
      x2.fillStyle = `rgba(${v},${v-10},${v-20},0.07)`;
      x2.fillRect(Math.random()*128, Math.random()*128, 3, 3);
    }
    x2.strokeStyle = 'rgba(80,60,40,0.12)'; x2.lineWidth = 0.5;
    for(let i = 0; i < 4; i++) {
      x2.beginPath();
      let px = Math.random()*128, py = Math.random()*128;
      x2.moveTo(px,py);
      for(let j = 0; j < 3; j++) { px += (Math.random()-0.5)*25; py += (Math.random()-0.5)*25; x2.lineTo(px,py); }
      x2.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }
  function makeMetalTex() {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const x2 = c.getContext('2d');
    x2.fillStyle = '#7a7a70'; x2.fillRect(0,0,128,128);
    for(let i = 0; i < 800; i++) {
      const v = 90+Math.floor(Math.random()*50);
      x2.fillStyle = `rgba(${v},${v},${v},0.1)`;
      x2.fillRect(Math.random()*128, Math.random()*128, 2, 2);
    }
    x2.strokeStyle = 'rgba(160,160,160,0.2)'; x2.lineWidth = 0.8;
    for(let i = 0; i < 12; i++) {
      x2.beginPath(); x2.moveTo(Math.random()*128, Math.random()*128);
      x2.lineTo(Math.random()*128, Math.random()*128); x2.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(2, 2);
    return t;
  }
  function makeDarkFloorTex() {
    const c = document.createElement('canvas'); c.width = 128; c.height = 128;
    const x2 = c.getContext('2d');
    x2.fillStyle = '#605040'; x2.fillRect(0,0,128,128);
    for(let i = 0; i < 1000; i++) {
      const v = 40+Math.floor(Math.random()*50);
      x2.fillStyle = `rgba(${v},${v-5},${v-10},0.08)`;
      x2.fillRect(Math.random()*128, Math.random()*128, 2, 2);
    }
    // Tile pattern
    x2.strokeStyle = 'rgba(40,30,20,0.2)'; x2.lineWidth = 1;
    for(let y = 0; y < 128; y += 32) { x2.beginPath(); x2.moveTo(0,y); x2.lineTo(128,y); x2.stroke(); }
    for(let xx = 0; xx < 128; xx += 32) { x2.beginPath(); x2.moveTo(xx,0); x2.lineTo(xx,128); x2.stroke(); }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }

  const sandWall = new THREE.MeshStandardMaterial({ color:0xd4b880, roughness:0.8, metalness:0.05, map: makeWallTex('#d4b880','rgba(160,130,80,0.25)',64,32) });
  const darkWall = new THREE.MeshStandardMaterial({ color:0xb09050, roughness:0.75, metalness:0.08, map: makeWallTex('#b09050','rgba(120,100,60,0.3)',48,24) });
  const stoneWall = new THREE.MeshStandardMaterial({ color:0xa88850, roughness:0.7, metalness:0.1, map: makeWallTex('#a88850','rgba(100,80,50,0.35)',40,20) });
  // Wood crate material with procedural wood grain texture
  const woodCanvas = document.createElement('canvas');
  woodCanvas.width = 128; woodCanvas.height = 128;
  const wCtx = woodCanvas.getContext('2d');
  wCtx.fillStyle = '#8a6a35';
  wCtx.fillRect(0,0,128,128);
  for(let i = 0; i < 40; i++) {
    const y = Math.random() * 128;
    wCtx.strokeStyle = `rgba(${60+Math.random()*40},${40+Math.random()*30},${15+Math.random()*15},${0.15+Math.random()*0.25})`;
    wCtx.lineWidth = 1 + Math.random()*2;
    wCtx.beginPath(); wCtx.moveTo(0, y); wCtx.lineTo(128, y + (Math.random()-0.5)*8); wCtx.stroke();
  }
  // Plank lines
  for(let x = 0; x < 128; x += 32) {
    wCtx.strokeStyle = 'rgba(40,25,10,0.3)'; wCtx.lineWidth = 2;
    wCtx.beginPath(); wCtx.moveTo(x, 0); wCtx.lineTo(x, 128); wCtx.stroke();
  }
  const woodTex = new THREE.CanvasTexture(woodCanvas);
  woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping;
  const crateMat = new THREE.MeshStandardMaterial({ color:0x9a7a45, roughness:0.85, map: woodTex });
  const metalMat = new THREE.MeshStandardMaterial({ color:0x8a8a80, roughness:0.4, metalness:0.65, map: makeMetalTex() });
  const concreteMat = new THREE.MeshStandardMaterial({ color:0xb8a878, roughness:0.85, map: makeConcreteTex() });
  const trimMat = new THREE.MeshStandardMaterial({ color:0x8a7848, roughness:0.6, metalness:0.15, map: makeConcreteTex() });
  const darkFloor = new THREE.MeshStandardMaterial({ color:0x706048, roughness:0.9, map: makeDarkFloorTex() });

  function addBox(w,h,d,x,y,z,mat,matType) {
    const geo = new THREE.BoxGeometry(w,h,d);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x,y,z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const box = new THREE.Box3().setFromObject(mesh);
    const obj = { mesh, box, materialType: matType || 'stone' };
    mapObjects.push(obj);
    return mesh;
  }

  function addCylinder(r, h, x, y, z, mat, segs, matType) {
    const geo = new THREE.CylinderGeometry(r, r, h, segs||8);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
    const box = new THREE.Box3().setFromObject(mesh);
    mapObjects.push({ mesh, box, materialType: matType || 'metal' });
  }

  const hs = GAME.mapSize/2;

  // === OUTER BOUNDARY ===
  addBox(GAME.mapSize, W+2, 1, 0, (W+2)/2, -hs, sandWall);
  addBox(GAME.mapSize, W+2, 1, 0, (W+2)/2, hs, sandWall);
  addBox(1, W+2, GAME.mapSize, -hs, (W+2)/2, 0, sandWall);
  addBox(1, W+2, GAME.mapSize, hs, (W+2)/2, 0, sandWall);

  // Roads
  addRoad(4, 30, 0, -5);   // Mid road
  addRoad(30, 4, 5, -20);  // Long A road
  addRoad(4, 20, -10, 10); // Tunnels road

  // =============================================
  // T SPAWN (south, z ~ +20 to +28)
  // =============================================
  addBox(14, W, T, 0, W/2, 24, sandWall);     // back wall
  addBox(T, W, 10, -7, W/2, 19, sandWall);    // left
  addBox(T, W, 10, 7, W/2, 19, sandWall);     // right
  // Opening north to map
  addBox(T, W, 4, -7, W/2, 13, sandWall);
  addBox(T, W, 4, 7, W/2, 13, sandWall);

  // =============================================
  // CT SPAWN (north, z ~ -24 to -28)
  // =============================================
  addBox(14, W, T, 0, W/2, -26, sandWall);
  addBox(T, W, 8, -7, W/2, -22, sandWall);
  addBox(T, W, 8, 7, W/2, -22, sandWall);

  // =============================================
  // MID (central corridor, x ~ -2 to 2, z ~ -10 to 10)
  // =============================================
  // West mid wall - split into sections to create proper gaps
  addBox(T, W, 8, -3, W/2, -10, stoneWall);
  addBox(T, W, 8, -3, W/2, 2, stoneWall);
  addBox(T, W, 2, -3, W/2, -2, stoneWall);
  // East mid wall - split into sections
  addBox(T, W, 10, 3, W/2, -8, stoneWall);
  addBox(T, W, 6, 3, W/2, 6, stoneWall);

  // Mid doors (iconic narrow gap at south end of mid)
  addBox(1.5, W, T, -1.5, W/2, 11, darkWall);
  addBox(1.5, W, T, 2, W/2, 11, darkWall);

  // Mid boxes (cover)
  addBox(1.2, 1.2, 1.2, 0, 0.6, 2, crateMat, 'wood');
  addBox(1.0, 0.8, 1.0, -1.5, 0.4, -4, crateMat, 'wood');

  // Mid to B connector (window room, x ~ -3 to -8, z ~ -4 to -8)
  addBox(T, W, 5, -3, W/2, -6, darkWall); // east wall
  addBox(6, W, T, -6, W/2, -8.5, darkWall); // south wall
  addBox(T, W, 5, -9, W/2, -6, darkWall); // west wall
  // Window opening (gap in south wall)
  addBox(6, W, T, -6, W/2, -3.5, darkWall); // north wall with drop to B
  // Floor in window room (elevated)
  addBox(6, 0.3, 5, -6, 2.0, -6, concreteMat);

  // =============================================
  // LONG A (east side, long sightline)
  // x ~ 8 to 12, z ~ -8 to -26
  // =============================================
  // Long A corridor walls
  addBox(T, W, 20, 8, W/2, -16, sandWall);   // west wall
  addBox(T, W, 20, 14, W/2, -16, sandWall);  // east wall

  // Long doors (two doors creating a narrow chokepoint)
  addBox(2, W, T, 9, W/2, -6, darkWall);
  addBox(2, W, T, 13, W/2, -6, darkWall);
  // Gap between doors (~2m wide at x=11)

  // Long A corner (bend from Long to A site)
  addBox(8, W, T, 14, W/2, -26, sandWall);   // end wall
  addBox(T, W, 6, 18, W/2, -23, sandWall);   // corner turn

  // Cover in Long A
  addBox(2.5, 1.2, 0.4, 11, 0.6, -12, metalMat, 'metal'); // metal barrier
  addBox(1.3, 1.3, 1.3, 9.5, 0.65, -18, crateMat, 'wood');
  addBox(1.0, 1.0, 1.0, 12.5, 0.5, -22, crateMat, 'wood');

  // The Pit (lowered area at end of Long, before A site)
  // Simulated with low walls around a gap
  addBox(4, 0.8, T, 16, 0.4, -20, stoneWall);

  // =============================================
  // BOMBSITE A (northeast, x ~ 14 to 24, z ~ -8 to -18)
  // =============================================
  // A site enclosure walls
  addBox(12, W, T, 19, W/2, -8, sandWall);    // south wall
  addBox(12, W, T, 19, W/2, -18, sandWall);   // north wall (partial)
  addBox(T, W, 10, 25, W/2, -13, sandWall);   // east wall
  // West wall with opening from catwalk
  addBox(T, W, 4, 14, W/2, -10, sandWall);
  addBox(T, W, 4, 14, W/2, -16, sandWall);

  // A site raised platform
  addBox(8, 0.5, 6, 20, 0.5, -13, concreteMat);

  // A site crates (iconic stacked boxes)
  addBox(1.6, 1.6, 1.6, 17, 1.3, -13, crateMat, 'wood');  // "default" box
  addBox(1.3, 1.3, 1.3, 22, 1.15, -11, crateMat, 'wood');  // site box
  addBox(1.0, 1.8, 1.0, 22, 1.4, -15, crateMat, 'wood');   // tall box
  addBox(1.3, 0.8, 1.3, 19, 0.9, -10, crateMat, 'wood');   // short box

  // Goose (small wall near A)
  addBox(2, 1.5, T, 16, 0.75, -9, sandWall);

  // =============================================
  // SHORT A / CATWALK (from Mid to A, elevated path)
  // x ~ 3 to 14, z ~ -8 to -12
  // =============================================
  // Catwalk elevated floor
  addBox(10, 0.4, 4, 8, 1.2, -10, concreteMat);
  // Catwalk railing (low wall)
  addBox(10, 0.9, T, 8, 1.85, -8, metalMat, 'metal');
  addBox(T, 0.9, 4, 3, 1.85, -10, metalMat, 'metal');
  // Stairs from mid up to catwalk
  addBox(3, 0.2, 1.5, 4, 0.3, -9, concreteMat);
  addBox(3, 0.2, 1.5, 4, 0.6, -10, concreteMat);
  addBox(3, 0.2, 1.5, 4, 0.9, -11, concreteMat);

  // =============================================
  // B TUNNELS (west approach to B site) - simplified for competitive play
  // x ~ -8 to -14, z ~ 4 to 20
  // =============================================
  // Upper tunnel - single corridor with walls
  addBox(6, 3.5, 18, -11, 1.75, 11, darkWall);
  // Tunnel ceiling
  addBox(6, 0.3, 18, -11, 3.5, 11, darkWall);
  // Dark floor in tunnel
  addBox(6, 0.05, 18, -11, 0.03, 11, darkFloor);

  // Tunnel connector to B
  addBox(6, 3.5, 6, -11, 1.75, 1, darkWall);
  addBox(6, 0.3, 6, -11, 3.5, 1, darkWall);
  addBox(6, 0.05, 6, -11, 0.03, 1, darkFloor);

  // =============================================
  // BOMBSITE B (northwest, x ~ -16 to -26, z ~ -4 to -14)
  // =============================================
  // B site building walls
  addBox(12, W, T, -20, W/2, -4, darkWall);   // south wall
  addBox(12, W, T, -20, W/2, -16, darkWall);  // north wall
  addBox(T, W, 12, -26, W/2, -10, darkWall);  // west wall
  addBox(T, W, 4, -14, W/2, -6, darkWall);    // east wall partial
  addBox(T, W, 4, -14, W/2, -14, darkWall);   // east wall partial
  // Gap in east wall (entrance from tunnels)

  // B site platform
  addBox(8, 0.4, 8, -20, 0.4, -10, concreteMat);

  // B site crates
  addBox(1.6, 1.8, 1.6, -22, 1.3, -10, crateMat, 'wood');  // big box
  addBox(1.3, 1.3, 1.3, -18, 1.05, -8, crateMat, 'wood');
  addBox(1.0, 1.0, 1.0, -24, 0.9, -13, crateMat, 'wood');
  addBox(1.0, 1.6, 1.0, -18, 1.2, -14, crateMat, 'wood');   // tall box

  // B doors (double door from CT spawn)
  addBox(2, W, T, -16, W/2, -16, darkWall);
  addBox(2, W, T, -24, W/2, -16, darkWall);

  // =============================================
  // CONNECTING AREAS
  // =============================================

  // CT to A ramp
  addBox(T, W, 8, 7, W/2, -18, sandWall);
  addBox(4, W, T, 9, W/2, -22, sandWall);

  // CT to B path
  addBox(T, W, 6, -7, W/2, -19, sandWall);
  addBox(6, W, T, -10, W/2, -16, sandWall);

  // T spawn to Long doors path
  addBox(T, W, 6, 7, W/2, 8, sandWall);
  addBox(6, W, T, 10, W/2, 5, sandWall);

  // =============================================
  // DECORATIVE DETAILS
  // =============================================

  // Barrels
  const barrelMat = new THREE.MeshStandardMaterial({ color:0x6a5a3a, roughness:0.7, metalness:0.3 });
  addCylinder(0.35, 1.0, -6, 0.5, 17, barrelMat);
  addCylinder(0.35, 1.0, -5.5, 0.5, 17.8, barrelMat);
  addCylinder(0.35, 1.0, 20, 0.5, -3, barrelMat);
  addCylinder(0.35, 1.0, -22, 0.5, -5, barrelMat);

  // Pillars in A site area
  addCylinder(0.35, W, 16, W/2, -14, stoneWall);
  addCylinder(0.35, W, 22, W/2, -9, stoneWall);

  // Sandbag walls
  const sandbagMat = new THREE.MeshStandardMaterial({ color:0xb8a068, roughness:0.95 });
  addBox(3, 0.8, 0.8, 10, 0.4, -3, sandbagMat);
  addBox(0.8, 0.8, 2.5, -5, 0.4, 6, sandbagMat);
  addBox(3, 0.8, 0.8, -16, 0.4, 20, sandbagMat);

  // Trim details on main walls
  addBox(12, 0.12, 0.5, 19, W*0.55, -7.7, trimMat);
  addBox(12, 0.12, 0.5, 19, W*0.55, -18.3, trimMat);
  addBox(12, 0.12, 0.5, -20, W*0.55, -3.7, trimMat);
  addBox(12, 0.12, 0.5, -20, W*0.55, -16.3, trimMat);

  // Half-walls for peek cover in open areas
  addBox(3, 1.4, T, 0, 0.7, -20, sandWall);
  addBox(T, 1.4, 3, 5, 0.7, -14, sandWall);
  addBox(3, 1.4, T, -22, 0.7, 5, sandWall);
}

function setMapLoadingVisible(visible) {
  const el = document.getElementById('map-loading-overlay');
  if(!el) return;
  el.style.display = visible ? 'flex' : 'none';
  el.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function setMapLoadingProgress(ratio01, label) {
  const fill = document.getElementById('map-loading-bar-fill');
  const pct = document.getElementById('map-loading-pct');
  const text = document.getElementById('map-loading-label');
  const r = Math.round(Math.min(100, Math.max(0, ratio01 * 100)));
  if(fill) fill.style.width = r + '%';
  if(pct) pct.textContent = r + '%';
  if(text && label) text.textContent = label;
}

async function buildMap() {
  mapHalfBound = GAME.mapSize / 2;
  setMapLoadingVisible(true);
  setMapLoadingProgress(0, GAME.useDust2GlbMap ? '准备加载地图…' : '生成场景…');
  try {
    if(GAME.useDust2GlbMap) {
      try {
        Dust2Map.ensureMeshBVHPrototypes();
        const { visualRoot, collisionMesh, bounds } = await Dust2Map.loadDust2GlbMap(scene, {
          url: GAME.dust2GlbUrl,
          scale: GAME.dust2MapScale,
          position: GAME.dust2MapPosition,
          rotationY: GAME.dust2MapRotationY,
          alignMinYToZero: GAME.dust2AlignMinYToZero,
          onProgress: (ratio, phase) => setMapLoadingProgress(ratio, phase),
        });
        visualRoot.name = 'dust2_visual';
        scene.add(visualRoot);
        mapBVHCollisionMesh = collisionMesh;
        mapUseBVHCollision = true;
        mapWorldBounds = bounds;
        lastValidGroundFeetY = null;
        const ex = Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x));
        const ez = Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z));
        mapHalfBound = Math.max(ex, ez, GAME.mapSize / 2) + 2;
        camera.far = Math.max(800, mapHalfBound * 5);
        camera.updateProjectionMatrix();
        if(mapSunLight && mapSunLight.shadow && mapSunLight.shadow.camera) {
          const s = mapHalfBound * 1.2;
          mapSunLight.shadow.camera.left = -s;
          mapSunLight.shadow.camera.right = s;
          mapSunLight.shadow.camera.top = s;
          mapSunLight.shadow.camera.bottom = -s;
          mapSunLight.shadow.camera.far = mapHalfBound * 4;
          mapSunLight.shadow.camera.updateProjectionMatrix();
        }
        mapObjects.push({
          mesh: collisionMesh,
          box: null,
          mapBVH: true,
          materialType: 'stone',
        });
        {
          const sp = getRandomSpawnPos();
          dust2ApplySpawnCameraToWalkableGround(sp.x, sp.z);
        }
        console.log('[dust2] GLB + BVH 碰撞已就绪', bounds, 'scale=', GAME.dust2MapScale);
      } catch(err) {
        console.error('[dust2] 加载失败，使用程序生成地图', err);
        mapBVHCollisionMesh = null;
        mapUseBVHCollision = false;
        mapWorldBounds = null;
        lastValidGroundFeetY = null;
        setMapLoadingProgress(0.2, '加载失败，使用备用场景…');
        buildProceduralMap();
        setMapLoadingProgress(1, '就绪');
      }
    } else {
      setMapLoadingProgress(0.4, '生成程序场景…');
      buildProceduralMap();
      setMapLoadingProgress(1, '就绪');
    }
  } finally {
    notifyMapReady();
    setMapLoadingVisible(false);
  }
}

// ============================================================
// ENEMY SYSTEM
// ============================================================
const ENEMY_TYPES = {
  normal: { health:100, speed:2.15, color:0xcc3333, size:1.0, score:100, name:'突击兵' },
  elite: { health:150, speed:2.95, color:0xff6600, size:1.0, score:250, name:'精英兵' },
};

function createEnemy(type, position, team) {
  const cfg = ENEMY_TYPES[type];
  const enemyTeam = team || opponentTeamOfPlayer();

  // Body group - head top at ~1.72m (player eye level 1.7)
  const group = new THREE.Group();

  // === MATERIALS ===
  const skinMat = new THREE.MeshStandardMaterial({ color:0xc89e78, roughness:0.75, metalness:0.05 });
  const bootMat = new THREE.MeshStandardMaterial({ color:0x1a1a1a, roughness:0.8, metalness:0.2 });
  const pantsMat = new THREE.MeshStandardMaterial({ color: type==='elite' ? 0x2a3a2a : 0x33333a, roughness:0.85 });
  const vestColor = type==='elite' ? 0x4a5a3a : 0x3e3e48;
  const vestMat = new THREE.MeshStandardMaterial({ color: vestColor, roughness:0.7, metalness:0.15 });
  const armorMat = new THREE.MeshStandardMaterial({ color: type==='elite' ? 0x556b2f : 0x4a4a55, roughness:0.5, metalness:0.4 });
  const helmetMat = new THREE.MeshStandardMaterial({ color: type==='elite' ? 0x3a4a2a : 0x35353e, roughness:0.4, metalness:0.5 });
  const strapMat = new THREE.MeshStandardMaterial({ color:0x2a2a2a, roughness:0.8 });
  const gunMetalMat = new THREE.MeshStandardMaterial({ color:0x1a1a1e, roughness:0.3, metalness:0.85 });

  // Body part tags for hit detection
  // Tag meshes: 'head', 'torso', 'limb'

  // === BOOTS (cylinders) ===
  const bootGeo = new THREE.CylinderGeometry(0.08, 0.09, 0.16, 8);
  const bootL = new THREE.Mesh(bootGeo, bootMat);
  bootL.position.set(-0.1, 0.08, 0.01);
  bootL.userData.bodyPart = 'limb';
  group.add(bootL);
  const bootR = bootL.clone();
  bootR.position.set(0.1, 0.08, 0.01);
  group.add(bootR);

  // === LEGS (cylinders for rounder shape) ===
  const legGeo = new THREE.CylinderGeometry(0.07, 0.08, 0.48, 8);
  const legL = new THREE.Mesh(legGeo, pantsMat);
  legL.position.set(-0.1, 0.40, 0);
  legL.userData.bodyPart = 'limb';
  group.add(legL);
  const legR = new THREE.Mesh(legGeo, pantsMat);
  legR.position.set(0.1, 0.40, 0);
  legR.userData.bodyPart = 'limb';
  group.add(legR);

  // Knee pads (small cylinders)
  const kneePadGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.06, 6);
  const kneePadL = new THREE.Mesh(kneePadGeo, armorMat);
  kneePadL.position.set(-0.1, 0.38, 0.08);
  kneePadL.userData.bodyPart = 'limb';
  group.add(kneePadL);
  const kneePadR = kneePadL.clone();
  kneePadR.position.set(0.1, 0.38, 0.08);
  group.add(kneePadR);

  // === UPPER LEGS / THIGHS (wider cylinders) ===
  const thighGeo = new THREE.CylinderGeometry(0.08, 0.07, 0.28, 8);
  const thighL = new THREE.Mesh(thighGeo, pantsMat);
  thighL.position.set(-0.1, 0.68, 0);
  thighL.userData.bodyPart = 'limb';
  group.add(thighL);
  const thighR = new THREE.Mesh(thighGeo, pantsMat);
  thighR.position.set(0.1, 0.68, 0);
  thighR.userData.bodyPart = 'limb';
  group.add(thighR);

  // === TORSO (cylinder + tapered) ===
  const torsoGeo = new THREE.CylinderGeometry(0.2, 0.18, 0.5, 10);
  const torso = new THREE.Mesh(torsoGeo, vestMat);
  torso.position.y = 1.08;
  torso.userData.bodyPart = 'torso';
  group.add(torso);

  // Body armor plate (front - box on cylinder)
  const armorPlateGeo = new THREE.BoxGeometry(0.3, 0.3, 0.05);
  const armorFront = new THREE.Mesh(armorPlateGeo, armorMat);
  armorFront.position.set(0, 1.1, 0.17);
  armorFront.userData.bodyPart = 'torso';
  group.add(armorFront);
  // Body armor plate (back)
  const armorBack = armorFront.clone();
  armorBack.position.set(0, 1.1, -0.17);
  group.add(armorBack);

  // Shoulder pads (spheres for roundness)
  const shoulderGeo = new THREE.SphereGeometry(0.08, 8, 6);
  const shoulderL = new THREE.Mesh(shoulderGeo, armorMat);
  shoulderL.position.set(-0.26, 1.28, 0);
  shoulderL.userData.bodyPart = 'limb';
  group.add(shoulderL);
  const shoulderR = new THREE.Mesh(shoulderGeo, armorMat);
  shoulderR.position.set(0.26, 1.28, 0);
  shoulderR.userData.bodyPart = 'limb';
  group.add(shoulderR);

  // Belt (torus-like using cylinder)
  const beltGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.05, 10);
  const belt = new THREE.Mesh(beltGeo, strapMat);
  belt.position.y = 0.84;
  belt.userData.bodyPart = 'torso';
  group.add(belt);
  // Belt pouches
  for(let i=-1; i<=1; i+=2) {
    const pouchGeo = new THREE.BoxGeometry(0.06, 0.08, 0.05);
    const pouch = new THREE.Mesh(pouchGeo, strapMat);
    pouch.position.set(i*0.18, 0.84, 0.16);
    pouch.userData.bodyPart = 'torso';
    group.add(pouch);
  }

  // === ARMS (cylinders for human shape) ===
  const upperArmGeo = new THREE.CylinderGeometry(0.05, 0.055, 0.28, 8);
  const foreArmGeo = new THREE.CylinderGeometry(0.04, 0.05, 0.24, 8);

  // Left upper arm (reaching toward weapon)
  const armLU = new THREE.Mesh(upperArmGeo, vestMat);
  armLU.position.set(-0.24, 1.15, 0.1);
  armLU.rotation.x = -0.6;
  armLU.rotation.z = 0.4;
  armLU.userData.bodyPart = 'limb';
  group.add(armLU);
  // Left forearm (angled toward gun foregrip)
  const armLF = new THREE.Mesh(foreArmGeo, vestMat);
  armLF.position.set(-0.05, 0.92, 0.30);
  armLF.rotation.x = -0.8;
  armLF.rotation.z = 0.2;
  armLF.userData.bodyPart = 'limb';
  group.add(armLF);
  // Left hand (on foregrip of weapon)
  const handGeo = new THREE.SphereGeometry(0.04, 6, 6);
  const handL = new THREE.Mesh(handGeo, skinMat);
  handL.position.set(0.15, 0.82, 0.42);
  handL.userData.bodyPart = 'limb';
  group.add(handL);

  // Right upper arm (on trigger/grip side)
  const armRU = new THREE.Mesh(upperArmGeo, vestMat);
  armRU.position.set(0.26, 1.15, 0.08);
  armRU.rotation.x = -0.4;
  armRU.rotation.z = -0.2;
  armRU.userData.bodyPart = 'limb';
  group.add(armRU);
  // Right forearm (toward weapon grip)
  const armRF = new THREE.Mesh(foreArmGeo, vestMat);
  armRF.position.set(0.24, 0.92, 0.18);
  armRF.rotation.x = -0.6;
  armRF.rotation.z = -0.15;
  armRF.userData.bodyPart = 'limb';
  group.add(armRF);
  // Right hand (on weapon grip/trigger)
  const handR = new THREE.Mesh(handGeo, skinMat);
  handR.position.set(0.22, 0.84, 0.24);
  handR.userData.bodyPart = 'limb';
  group.add(handR);

  // === NECK (cylinder) ===
  const neckGeo = new THREE.CylinderGeometry(0.06, 0.08, 0.1, 8);
  const neck = new THREE.Mesh(neckGeo, skinMat);
  neck.position.y = 1.38;
  neck.userData.bodyPart = 'torso';
  group.add(neck);

  // === HEAD (sphere for human shape) ===
  const headGeo = new THREE.SphereGeometry(0.13, 12, 10);
  const head = new THREE.Mesh(headGeo, skinMat);
  head.position.y = 1.54;
  head.userData.bodyPart = 'head';
  group.add(head);

  // Jaw/chin (slight box to shape face)
  const jawGeo = new THREE.BoxGeometry(0.16, 0.06, 0.1);
  const jaw = new THREE.Mesh(jawGeo, skinMat);
  jaw.position.set(0, 1.44, 0.04);
  jaw.userData.bodyPart = 'head';
  group.add(jaw);

  // === HELMET (sphere-based) ===
  const helmetGeo = new THREE.SphereGeometry(0.15, 12, 8, 0, Math.PI*2, 0, Math.PI*0.6);
  const helmet = new THREE.Mesh(helmetGeo, helmetMat);
  helmet.position.y = 1.56;
  helmet.userData.bodyPart = 'head';
  group.add(helmet);
  // Helmet rim (torus)
  const rimGeo = new THREE.CylinderGeometry(0.155, 0.16, 0.03, 12);
  const rim = new THREE.Mesh(rimGeo, helmetMat);
  rim.position.y = 1.52;
  rim.userData.bodyPart = 'head';
  group.add(rim);

  // Face details - visor/goggles for elite
  if(type === 'elite') {
    const visorGeo = new THREE.BoxGeometry(0.22, 0.06, 0.03);
    const visorMat = new THREE.MeshStandardMaterial({ color:0x112211, roughness:0.2, metalness:0.6, transparent:true, opacity:0.8 });
    const visor = new THREE.Mesh(visorGeo, visorMat);
    visor.position.set(0, 1.56, 0.13);
    visor.userData.bodyPart = 'head';
    group.add(visor);
  }
  // Eyes (dark spheres)
  const eyeGeo = new THREE.SphereGeometry(0.02, 6, 6);
  const eyeMat = new THREE.MeshStandardMaterial({ color:0x1a1a1a });
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.045, 1.56, 0.12);
  eyeL.userData.bodyPart = 'head';
  group.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(0.045, 1.56, 0.12);
  eyeR.userData.bodyPart = 'head';
  group.add(eyeR);

  // Nose (small cone)
  const noseGeo = new THREE.ConeGeometry(0.02, 0.04, 4);
  const nose = new THREE.Mesh(noseGeo, skinMat);
  nose.position.set(0, 1.51, 0.13);
  nose.rotation.x = Math.PI/2;
  nose.userData.bodyPart = 'head';
  group.add(nose);

  // 近战射线：头盔为部分球体时可能穿缝；枪械在脸前会最先被击中。此球仅作碰撞，射击逻辑会跳过（见 shoot / checkMeleeHit）
  const headMeleeHitMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const headMeleeHitbox = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), headMeleeHitMat);
  headMeleeHitbox.position.y = 1.52;
  headMeleeHitbox.userData.bodyPart = 'head';
  headMeleeHitbox.userData.meleeHeadHitbox = true;
  group.add(headMeleeHitbox);

  // === WEAPON - varies by enemy type ===
  const gunWoodMat = new THREE.MeshStandardMaterial({ color:0x6b4226, roughness:0.75, metalness:0.1 });
  if(type === 'elite') {
    // Elite carries an AK-style rifle - larger, with wooden parts
    const gunRecv = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 0.32), gunMetalMat);
    gunRecv.position.set(0.22, 0.95, 0.28);
    gunRecv.userData.skipMeleeRaycast = true;
    group.add(gunRecv);
    const gunBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.30, 6), gunMetalMat);
    gunBarrel.rotation.x = Math.PI/2;
    gunBarrel.position.set(0.22, 0.97, 0.58);
    gunBarrel.userData.skipMeleeRaycast = true;
    group.add(gunBarrel);
    // Muzzle brake
    const gunMuzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.015, 0.05, 6), gunMetalMat);
    gunMuzzle.rotation.x = Math.PI/2;
    gunMuzzle.position.set(0.22, 0.97, 0.74);
    gunMuzzle.userData.skipMeleeRaycast = true;
    group.add(gunMuzzle);
    // Magazine (curved AK-style)
    const gunMag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.03),
      new THREE.MeshStandardMaterial({ color:0x111115, metalness:0.7, roughness:0.3 }));
    gunMag.position.set(0.22, 0.86, 0.26);
    gunMag.rotation.x = 0.15;
    gunMag.userData.skipMeleeRaycast = true;
    group.add(gunMag);
    // Wooden stock
    const gunStock = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.18), gunWoodMat);
    gunStock.position.set(0.22, 0.94, 0.06);
    gunStock.userData.skipMeleeRaycast = true;
    group.add(gunStock);
    // Gas tube (wooden)
    const gasTube = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.15, 6), gunWoodMat);
    gasTube.rotation.x = Math.PI/2;
    gasTube.position.set(0.22, 1.0, 0.45);
    gasTube.userData.skipMeleeRaycast = true;
    group.add(gasTube);
    // Front sight
    const fSight = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.02, 0.005), gunMetalMat);
    fSight.position.set(0.22, 1.01, 0.68);
    fSight.userData.skipMeleeRaycast = true;
    group.add(fSight);
  } else {
    // Normal carries an M4-style rifle
    const gunRecv = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.28), gunMetalMat);
    gunRecv.position.set(0.2, 0.95, 0.3);
    gunRecv.userData.skipMeleeRaycast = true;
    group.add(gunRecv);
    const gunBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.25, 6), gunMetalMat);
    gunBarrel.rotation.x = Math.PI/2;
    gunBarrel.position.set(0.2, 0.97, 0.56);
    gunBarrel.userData.skipMeleeRaycast = true;
    group.add(gunBarrel);
    // Handguard with rails
    const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.14), gunMetalMat);
    handguard.position.set(0.2, 0.96, 0.48);
    handguard.userData.skipMeleeRaycast = true;
    group.add(handguard);
    // Top rail
    const topRail = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.008, 0.28), gunMetalMat);
    topRail.position.set(0.2, 0.985, 0.32);
    topRail.userData.skipMeleeRaycast = true;
    group.add(topRail);
    const gunMag = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.09, 0.025),
      new THREE.MeshStandardMaterial({ color:0x111115, metalness:0.7, roughness:0.3 }));
    gunMag.position.set(0.2, 0.88, 0.28);
    gunMag.rotation.x = 0.1;
    gunMag.userData.skipMeleeRaycast = true;
    group.add(gunMag);
    // Telescoping stock
    const gunStock = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.045, 0.14), gunMetalMat);
    gunStock.position.set(0.2, 0.94, 0.1);
    gunStock.userData.skipMeleeRaycast = true;
    group.add(gunStock);
    // Carry handle / rear sight
    const rearSight = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.04), gunMetalMat);
    rearSight.position.set(0.2, 1.0, 0.2);
    rearSight.userData.skipMeleeRaycast = true;
    group.add(rearSight);
  }

  // Backpack for elite
  if(type === 'elite') {
    const bpGeo = new THREE.CylinderGeometry(0.12, 0.1, 0.28, 8);
    const bpMat = new THREE.MeshStandardMaterial({ color:0x3a4a2a, roughness:0.85 });
    const bp = new THREE.Mesh(bpGeo, bpMat);
    bp.position.set(0, 1.05, -0.22);
    bp.userData.bodyPart = 'torso';
    group.add(bp);
  }

  // Scale model up so face center is at player eye level (1.7m)
  // Face was at 1.56m, 1.56 * 1.09 ≈ 1.70m
  group.scale.set(1.09, 1.09, 1.09);

  // Enable shadows on all meshes
  group.traverse(child => {
    if(child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  group.position.copy(position);
  scene.add(group);

  // Patrol points
  const patrolPoints = [];
  for(let i=0; i<3; i++){
    patrolPoints.push(new THREE.Vector3(
      position.x + (Math.random()-0.5)*20,
      0,
      position.z + (Math.random()-0.5)*20
    ));
  }

  return {
    group, type, cfg,
    team: enemyTeam,
    health: cfg.health, maxHealth: cfg.health,
    state: 'patrol', // patrol, chase, hold, attack
    patrolPoints, patrolIndex: 0,
    lastShot: 0, shotInterval: type==='elite' ? 600 : 900,
    detectionRange: 22, attackRange: 18,
    velocity: new THREE.Vector3(),
    dead: false, respawnTimer: 0,
    legL, legR, walkPhase: Math.random()*Math.PI*2,
    // CS-style AI parameters
    alertTimer: 0,
    alertThreshold: 1.5,      // reaction time before first shot
    burstCount: 0,
    burstMax: type==='elite' ? 4 : 3,
    burstCooldown: 0,
    burstCooldownMax: type==='elite' ? 2.5 : 4.0,
    burstInterval: type==='elite' ? 0.25 : 0.35,
    burstTimer: 0,
    // Hold/reposition logic (CS-style: stop to shoot, occasionally reposition)
    holdTimer: 0,             // how long bot has been holding position
    holdDuration: 0.65 + Math.random() * 1.05,  // 交火时站桩多久后横向位移（短一点更爱动）
    repositioning: false,     // currently doing a short reposition move
    repositionTarget: null,   // target position for reposition
    repositionTimer: 0,       // time left for reposition move
    aimOffsetX: 0,            // simulated aim wobble
    aimOffsetZ: 0,
  };
}

function actorIntersectsWallBox(x, z, radius, yMin, yMax) {
  if(mapUseBVHCollision && mapBVHCollisionMesh) {
    return Dust2Map.cylinderTooCloseToMesh(mapBVHCollisionMesh, x, z, radius, yMin, yMax);
  }
  return Collision.actorIntersectsWallBox(mapObjects, x, z, radius, yMin, yMax);
}
function isInsideWall(x, z, radius) {
  if(mapUseBVHCollision && mapBVHCollisionMesh) {
    const r = radius != null ? radius : 0.55;
    const feet = camera && camera.position ? camera.position.y - GAME.playerHeight : 0;
    return Dust2Map.cylinderTooCloseToMesh(mapBVHCollisionMesh, x, z, r, feet + 0.05, feet + 1.95);
  }
  return Collision.isInsideWall(mapObjects, x, z, radius);
}
function getFeetSurfaceY(x, z, footR, refY, probeFeetY) {
  const fr = footR != null ? footR : 0.42;
  if(mapUseBVHCollision && mapBVHCollisionMesh) {
    const ry = refY != null ? refY : (camera && camera.position ? camera.position.y + 25 : 120);
    const feet = probeFeetY != null && Number.isFinite(probeFeetY)
      ? probeFeetY
      : (camera && camera.position ? camera.position.y - GAME.playerHeight : undefined);
    const y = Dust2Map.getFeetYFromBVH(mapBVHCollisionMesh, x, z, fr, ry, mapWorldBounds || undefined, feet);
    if(Number.isFinite(y)) return y;
    if(mapWorldBounds) return mapWorldBounds.min.y;
    return 0;
  }
  return Collision.getFeetSurfaceY(mapObjects, x, z, fr);
}
function enemyPositionBlocked(x, z, feetWorldY) {
  if(mapUseBVHCollision && mapBVHCollisionMesh) {
    const fy = feetWorldY != null && Number.isFinite(feetWorldY) ? feetWorldY : 0;
    return Dust2Map.cylinderTooCloseToMesh(
      mapBVHCollisionMesh, x, z, Collision.ENEMY_WALL_R,
      fy + Collision.ENEMY_WALL_Y0, fy + Collision.ENEMY_WALL_Y1
    );
  }
  return Collision.enemyPositionBlocked(mapObjects, x, z);
}

/** GLB 地图：射线脚底 + 略抬高，再换算眼睛高度（出生/拉回用）。probeFeetY 为当前脚底世界 y 时室内不误判楼顶 */
function dust2SpawnFeetYAt(x, z, probeFeetY) {
  if(!mapUseBVHCollision || !mapBVHCollisionMesh || !mapWorldBounds) return 0;
  const refY = mapWorldBounds.max.y + 200;
  const fy = Dust2Map.getFeetYFromBVH(
    mapBVHCollisionMesh, x, z, GAME.playerRadius, refY, mapWorldBounds, probeFeetY
  );
  if(!Number.isFinite(fy)) return 0;
  if(fy <= mapWorldBounds.min.y - 900) return 0;
  const lift = GAME.dust2SpawnFeetLift != null ? GAME.dust2SpawnFeetLift : 0.12;
  return fy + lift;
}

/** 脚底（含 lift 的 dust2SpawnFeetYAt 结果）是否在地图包围盒底面之上，禁止出生在「地图底下」 */
function dust2SpawnGroundNotBelowMapMin(feetWithLift) {
  const b = mapWorldBounds;
  if(!b || !Number.isFinite(feetWithLift) || feetWithLift <= 0) return false;
  const lift = GAME.dust2SpawnFeetLift != null ? GAME.dust2SpawnFeetLift : 0.12;
  const ground = feetWithLift - lift;
  const slack = GAME.dust2SpawnForbiddenBelowMinY != null ? GAME.dust2SpawnForbiddenBelowMinY : 0.12;
  return ground >= b.min.y - slack;
}

/** BVH 原始地面 y（不含 lift）：可走、且不在包围盒「底伪影」之下、也不太离谱高 */
function dust2IsAcceptableRawGroundY(g) {
  const b = mapWorldBounds;
  if(!b || !Number.isFinite(g)) return false;
  const slack = GAME.dust2SpawnForbiddenBelowMinY != null ? GAME.dust2SpawnForbiddenBelowMinY : 0.12;
  if(g < b.min.y - slack) return false;
  if(g > b.max.y - 0.45) return false;
  const maxH = GAME.dust2SpawnMaxAbsHeightAboveMin != null ? GAME.dust2SpawnMaxAbsHeightAboveMin : 14;
  if(g > b.min.y + maxH + 4) return false;
  return true;
}

/**
 * 出生/拉回后强制把相机放到可走地面上方：先扫偏好 XZ 附近，再全图随机，再 emergency XZ；
 * 避免仅靠 getEyeYForWorldXZ 在「虚空/模型下」用 min.y 兜底仍压在真实地面之下。
 */
function dust2ApplySpawnCameraToWalkableGround(preferredX, preferredZ) {
  if(!mapUseBVHCollision || !mapBVHCollisionMesh || !mapWorldBounds) {
    camera.position.set(preferredX, GAME.playerHeight, preferredZ);
    return;
  }
  const b = mapWorldBounds;
  const mesh = mapBVHCollisionMesh;
  const lift = GAME.dust2SpawnFeetLift != null ? GAME.dust2SpawnFeetLift : 0.12;
  const refY = b.max.y + 320;

  function rawAt(px, pz) {
    return Dust2Map.getFeetYFromBVH(mesh, px, pz, GAME.playerRadius, refY, b);
  }

  function eyeFromGround(g) {
    return g + lift + GAME.playerHeight;
  }

  const offsets = [
    [0, 0], [1.0, 0], [-1.0, 0], [0, 1.0], [0, -1.0],
    [2.2, 0], [-2.2, 0], [0, 2.2], [0, -2.2],
    [1.7, 1.7], [-1.7, 1.7], [1.7, -1.7], [-1.7, -1.7],
    [4, 0], [-4, 0], [0, 4], [0, -4],
    [3.2, 3.2], [-3.2, 3.2], [3.2, -3.2], [-3.2, -3.2],
    [6, 0], [-6, 0], [0, 6], [0, -6],
  ];

  for(let i = 0; i < offsets.length; i++) {
    const px = preferredX + offsets[i][0];
    const pz = preferredZ + offsets[i][1];
    const g = rawAt(px, pz);
    if(dust2IsAcceptableRawGroundY(g)) {
      camera.position.set(px, eyeFromGround(g), pz);
      return;
    }
  }

  const margin = 0.06;
  for(let t = 0; t < 140; t++) {
    const u = margin + Math.random() * (1 - 2 * margin);
    const v = margin + Math.random() * (1 - 2 * margin);
    let uu = u;
    let vv = v;
    if(GAME.dust2SpawnUvFlipU) uu = 1 - uu;
    if(GAME.dust2SpawnUvFlipV) vv = 1 - vv;
    const px = b.min.x + uu * (b.max.x - b.min.x);
    const pz = b.min.z + vv * (b.max.z - b.min.z);
    const g = rawAt(px, pz);
    if(dust2IsAcceptableRawGroundY(g)) {
      camera.position.set(px, eyeFromGround(g), pz);
      return;
    }
  }

  const ep = pickDust2SpawnXZEmergencySafe();
  const g2 = rawAt(ep.x, ep.z);
  if(dust2IsAcceptableRawGroundY(g2)) {
    camera.position.set(ep.x, eyeFromGround(g2), ep.z);
    return;
  }

  for(let t = 0; t < 100; t++) {
    const u = margin + Math.random() * (1 - 2 * margin);
    const v = margin + Math.random() * (1 - 2 * margin);
    let uu = u;
    let vv = v;
    if(GAME.dust2SpawnUvFlipU) uu = 1 - uu;
    if(GAME.dust2SpawnUvFlipV) vv = 1 - vv;
    const px = b.min.x + uu * (b.max.x - b.min.x);
    const pz = b.min.z + vv * (b.max.z - b.min.z);
    const g = rawAt(px, pz);
    if(dust2IsAcceptableRawGroundY(g)) {
      camera.position.set(px, eyeFromGround(g), pz);
      return;
    }
  }

  const cx = (b.min.x + b.max.x) * 0.5;
  const cz = (b.min.z + b.max.z) * 0.5;
  const gc = rawAt(cx, cz);
  if(dust2IsAcceptableRawGroundY(gc)) {
    camera.position.set(cx, eyeFromGround(gc), cz);
    return;
  }

  const span = Math.max(1, b.max.y - b.min.y);
  const yEye = b.min.y + Math.min(span * 0.42, 22) + GAME.playerHeight;
  camera.position.set(preferredX, yEye, preferredZ);
  console.warn('[dust2] 未在 BVH 上找到可走地面，已抬到包围盒中下高度（请检查固定出生 u,v）');
}

/**
 * PVP 复活：只在偏好 XZ 邻域找合法地面，不把相机甩到全图随机 UV（避免随机点被 dust2Apply 吸附回同一块区域）。
 * 邻域与偏好点均失败时再调用完整 dust2ApplySpawnCameraToWalkableGround。
 */
function dust2SnapCameraToGroundNearPreferred(preferredX, preferredZ) {
  if(!mapUseBVHCollision || !mapBVHCollisionMesh || !mapWorldBounds) {
    camera.position.set(preferredX, GAME.playerHeight, preferredZ);
    return;
  }
  const b = mapWorldBounds;
  const mesh = mapBVHCollisionMesh;
  const lift = GAME.dust2SpawnFeetLift != null ? GAME.dust2SpawnFeetLift : 0.12;
  const refY = b.max.y + 320;
  function rawAt(px, pz) {
    return Dust2Map.getFeetYFromBVH(mesh, px, pz, GAME.playerRadius, refY, b);
  }
  function eyeFromGround(g) {
    return g + lift + GAME.playerHeight;
  }
  const offsets = [
    [0, 0], [1.0, 0], [-1.0, 0], [0, 1.0], [0, -1.0],
    [2.2, 0], [-2.2, 0], [0, 2.2], [0, -2.2],
    [1.7, 1.7], [-1.7, 1.7], [1.7, -1.7], [-1.7, -1.7],
    [4, 0], [-4, 0], [0, 4], [0, -4],
    [3.2, 3.2], [-3.2, 3.2], [3.2, -3.2], [-3.2, -3.2],
    [6, 0], [-6, 0], [0, 6], [0, -6],
  ];
  for(let i = 0; i < offsets.length; i++) {
    const px = preferredX + offsets[i][0];
    const pz = preferredZ + offsets[i][1];
    const g = rawAt(px, pz);
    if(dust2IsAcceptableRawGroundY(g)) {
      camera.position.set(px, eyeFromGround(g), pz);
      return;
    }
  }
  const g0 = rawAt(preferredX, preferredZ);
  if(dust2IsAcceptableRawGroundY(g0)) {
    camera.position.set(preferredX, eyeFromGround(g0), preferredZ);
    return;
  }
  dust2ApplySpawnCameraToWalkableGround(preferredX, preferredZ);
}

function getEyeYForWorldXZ(x, z) {
  if(!mapUseBVHCollision || !mapBVHCollisionMesh || !mapWorldBounds) {
    return GAME.playerHeight;
  }
  const b = mapWorldBounds;
  const feet = dust2SpawnFeetYAt(x, z);
  const safeEyeOnFloor = b.min.y + GAME.playerHeight + 0.15;
  if(!Number.isFinite(feet) || feet <= 0) {
    return Math.max(GAME.playerHeight, safeEyeOnFloor);
  }
  if(!dust2SpawnGroundNotBelowMapMin(feet)) {
    return safeEyeOnFloor;
  }
  return feet + GAME.playerHeight;
}

function findSafeSpawnPos(baseX, baseZ) {
  // Try the base position first
  if(!isInsideWall(baseX, baseZ)) return new THREE.Vector3(baseX, 0, baseZ);
  // Spiral outward to find a safe spot
  for(let r = 2; r <= 10; r += 2) {
    for(let a = 0; a < 8; a++) {
      const angle = (a / 8) * Math.PI * 2;
      const tx = baseX + Math.cos(angle) * r;
      const tz = baseZ + Math.sin(angle) * r;
      if(!isInsideWall(tx, tz)) return new THREE.Vector3(tx, 0, tz);
    }
  }
  return new THREE.Vector3(baseX, 0, baseZ); // fallback
}

function getMergedSpawnUvs() {
  const o = GAME.dust2SpawnUvOverrides;
  if(!o || typeof o !== 'object') return DUST2_SPAWN_UV;
  return DUST2_SPAWN_UV.map((e) => {
    const t = o[e.id];
    return t && typeof t.u === 'number' && typeof t.v === 'number'
      ? { ...e, u: t.u, v: t.v }
      : e;
  });
}

function applyUvFlip(u, v) {
  let uu = u;
  let vv = v;
  if(GAME.dust2SpawnUvFlipU) uu = 1 - uu;
  if(GAME.dust2SpawnUvFlipV) vv = 1 - vv;
  return { u: uu, v: vv };
}

function dust2UvWorldXZ(bounds, uv, jitter) {
  const { u, v } = applyUvFlip(uv.u, uv.v);
  const uv2 = { id: uv.id, u, v };
  const em = GAME.dust2SpawnEdgeMargin != null ? GAME.dust2SpawnEdgeMargin : 0.07;
  return dust2SpawnXZ(bounds, uv2, jitter, em);
}

function dust2SpawnGroundSlopeOk(x, z) {
  const b = mapWorldBounds;
  if(!b) return false;
  const lift = GAME.dust2SpawnFeetLift != null ? GAME.dust2SpawnFeetLift : 0.12;
  const d = 0.34;
  const r0 = dust2SpawnFeetYAt(x, z);
  const rxp = dust2SpawnFeetYAt(x + d, z);
  const rxm = dust2SpawnFeetYAt(x - d, z);
  const rzp = dust2SpawnFeetYAt(x, z + d);
  const rzm = dust2SpawnFeetYAt(x, z - d);
  if(r0 <= 0 || rxp <= 0 || rxm <= 0 || rzp <= 0 || rzm <= 0) return false;
  const samples = [r0 - lift, rxp - lift, rxm - lift, rzp - lift, rzm - lift].filter(
    (g) => g > b.min.y - 200 && g < b.max.y + 200
  );
  if(samples.length < 5) return false;
  const minG = Math.min(...samples);
  const maxG = Math.max(...samples);
  const maxSlope = GAME.dust2SpawnMaxGroundSlope != null ? GAME.dust2SpawnMaxGroundSlope : 1.15;
  return (maxG - minG) <= maxSlope;
}

/** 相对周围采样点不过高：排除屋顶、箱顶等（开阔地面应接近局部最低可走面） */
function dust2SpawnIsLowPlane(x, z, feetY) {
  const b = mapWorldBounds;
  if(!b) return false;
  const lift = GAME.dust2SpawnFeetLift != null ? GAME.dust2SpawnFeetLift : 0.12;
  const ground = feetY - lift;
  const maxAbs = GAME.dust2SpawnMaxAbsHeightAboveMin != null ? GAME.dust2SpawnMaxAbsHeightAboveMin : 14;
  if(ground > b.min.y + maxAbs) return false;
  const r = GAME.dust2SpawnLocalGroundSampleRadius != null ? GAME.dust2SpawnLocalGroundSampleRadius : 1.85;
  const offs = [
    [0, 0], [r, 0], [-r, 0], [0, r], [0, -r],
    [r * 0.72, r * 0.72], [-r * 0.72, r * 0.72], [r * 0.72, -r * 0.72], [-r * 0.72, -r * 0.72],
  ];
  let gmin = Infinity;
  for(let i = 0; i < offs.length; i++) {
    const fy = dust2SpawnFeetYAt(x + offs[i][0], z + offs[i][1]);
    if(fy > 0) gmin = Math.min(gmin, fy - lift);
  }
  if(gmin === Infinity) return false;
  const maxAbove = GAME.dust2SpawnMaxAboveLocalGround != null ? GAME.dust2SpawnMaxAboveLocalGround : 1.05;
  return ground <= gmin + maxAbove;
}

/** 水平方向近似半径内无墙，视为开阔（非窄缝、非室内死角） */
function dust2SpawnIsOpenEnough(x, z, feetY) {
  if(!mapBVHCollisionMesh) return false;
  const ys = [feetY + 0.55, feetY + 1.0, feetY + 1.52];
  const rad = GAME.dust2SpawnMinOpenRadius != null ? GAME.dust2SpawnMinOpenRadius : 1.85;
  const sec = GAME.dust2WallSectorCount != null ? Math.min(20, GAME.dust2WallSectorCount + 4) : 18;
  const o = {
    walkableMinNy: GAME.dust2WallWalkableMinNy != null ? GAME.dust2WallWalkableMinNy : 0.44,
    rayInset: GAME.dust2WallRayInset != null ? GAME.dust2WallRayInset : 0.14,
    microGapMaxDist: GAME.dust2WallMicroGapMaxDist != null ? GAME.dust2WallMicroGapMaxDist : 0.14,
    castExtra: GAME.dust2WallCastExtra != null ? GAME.dust2WallCastExtra : 0.3,
  };
  return !Dust2Map.horizontalMoveBlocked(mapBVHCollisionMesh, x, z, ys, rad, sec, o);
}

function dust2PlayerSpawnValid(x, z) {
  const b = mapWorldBounds;
  if(!b || !mapBVHCollisionMesh) return false;
  const fy = dust2SpawnFeetYAt(x, z);
  if(!(fy > 0 && fy <= b.max.y + 80)) return false;
  if(!dust2SpawnGroundNotBelowMapMin(fy)) return false;
  if(!dust2SpawnGroundSlopeOk(x, z)) return false;
  if(!dust2SpawnIsLowPlane(x, z, fy)) return false;
  if(!dust2SpawnIsOpenEnough(x, z, fy)) return false;
  const minClear = GAME.dust2SpawnTorsoMinClear != null ? GAME.dust2SpawnTorsoMinClear : 0.13;
  if(!Dust2Map.isSpawnTorsoClear(mapBVHCollisionMesh, x, z, fy, minClear)) return false;
  return true;
}

function isFriendlyFireEnabled() {
  return !!(multiplayerData && multiplayerData.settings && multiplayerData.settings.friendlyFire);
}

/** 与本地玩家敌对的阵营（NPC 默认出生在此阵营） */
function opponentTeamOfPlayer() {
  const t = GAME.playerTeam || 'CT';
  return t === 'CT' ? 'T' : 'CT';
}

/** 是否把该单位当作战场敌对目标（受友伤开关影响） */
function shouldTreatEnemyAsHostile(enemy) {
  if(!enemy || enemy.dead) return false;
  const et = enemy.team;
  if(et == null || et === '') return true;
  if(et !== GAME.playerTeam) return true;
  return isFriendlyFireEnabled();
}

function getRemotePlayerTeam(socketId) {
  if(!multiplayerData || !multiplayerData.players || socketId == null) return null;
  const sid = String(socketId);
  const p = multiplayerData.players.find(x => String(x.odId || '') === sid);
  if(p && p.team) return p.team;
  /** 1v1：唯一真人对手的 odId 可能与位移包 socketId 短暂不一致时，仍按对手阵营解析 */
  if(isMultiplayer1v1RoomMode()) {
    const pid = String(multiplayerData.playerId || '');
    const humans = (multiplayerData.players || []).filter(x => !x.isBot);
    if(humans.length === 2) {
      const other = humans.find(h => String(h.playerId || '') !== pid);
      if(other && other.team) return other.team;
    }
  }
  return null;
}

/** 联机远端玩家是否可作为射击/近战目标（阵营 + 友伤） */
function shouldTreatRemotePlayerAsHostile(socketId) {
  if(socketId == null || socketId === '') return false;
  const entry = remotePlayerMap.get(socketId);
  if(entry && entry.dead) return false;
  const rt = getRemotePlayerTeam(socketId);
  if(!rt || rt === 'spectator') return false;
  if(rt !== GAME.playerTeam) return true;
  return isFriendlyFireEnabled();
}

function getMpPlayerNickname(socketId) {
  if(!multiplayerData || !multiplayerData.players || socketId == null) return '';
  const p = multiplayerData.players.find(x => String(x.odId || '') === String(socketId));
  if(!p || !p.nickname) return '';
  return String(p.nickname).replace(/^_bot_/, '') || '玩家';
}

function markRemotePlayerDead(socketId) {
  const entry = remotePlayerMap.get(socketId);
  if(!entry || entry.dead) return;
  entry.dead = true;
  entry.corpseYaw = entry.curYaw;
  entry.mpMarkedDeadAt = performance.now();
  if(!entry.deathFeetPos) entry.deathFeetPos = new THREE.Vector3();
  entry.deathFeetPos.copy(entry.curPos);
  if(entry.weaponSceneRoot) entry.weaponSceneRoot.visible = false;
  if(entry.dropWeaponGroup && scene) {
    scene.remove(entry.dropWeaponGroup);
    removeWorldWeaponDropFromList(entry.dropWeaponGroup);
    entry.dropWeaponGroup = null;
  }
  const vis = normalizeRemoteWeaponType(entry.weaponType);
  const wKey = weaponTypeToWeaponKey(vis);
  if(wKey) {
    const wi = weaponKeyToWeaponIndex(wKey);
    const ww = WEAPONS[wi];
    entry.dropWeaponGroup = spawnWorldWeaponDrop(
      entry.deathFeetPos,
      entry.corpseYaw != null ? entry.corpseYaw : entry.curYaw,
      {
        weaponKey: wKey,
        mag: ww.magSize,
        reserve: ww.reserve,
        sourceSocketId: socketId,
      }
    );
  }
  entry.group.traverse((ch) => {
    if(ch.isMesh) ch.userData.mpCorpseNoHit = true;
  });
}

function markRemotePlayerAlive(socketId) {
  const entry = remotePlayerMap.get(socketId);
  if(!entry) return;
  entry.dead = false;
  entry.corpseYaw = undefined;
  entry.mpMarkedDeadAt = undefined;
  entry.deathFeetPos = undefined;
  /** 世界掉落物留在场景与 worldWeaponDrops 中，勿随复活从场景移除 */
  entry.dropWeaponGroup = null;
  clearRemotePlayerCorpsePose(entry.group);
  entry.curPos.copy(entry.targetPos);
  entry.curYaw = entry.targetYaw;
  if(entry.curEyePos && entry.targetEyePos) entry.curEyePos.copy(entry.targetEyePos);
  if(entry.curQuat && entry.targetQuat) entry.curQuat.copy(entry.targetQuat);
  setRemotePlayerAvatarTransform(entry.group, entry.curPos.x, entry.curPos.y, entry.curPos.z, entry.curYaw);
  if(entry.group) entry.group.visible = true;
  entry.group.traverse((ch) => {
    if(ch.isMesh) delete ch.userData.mpCorpseNoHit;
  });
}

function handleMultiplayerRemoteRespawned(data) {
  if(!data || data.socketId == null) return;
  const sid = String(data.socketId);
  const localId = multiplayerData && multiplayerData.localSocketId;
  if(localId && sid === localId) return;
  const pos = data.position;
  const rot = data.rotation;
  const prot = data.spawnProtect !== false;
  if(pos && pos.x != null && scene) {
    const feetY = pos.y - GAME.playerHeight;
    const yaw = yawFromRotationObj(rot);
    let entry = remotePlayerMap.get(sid);
    if(!entry) {
      if(!isLocalPlayerAvatarReady()) return;
      const group = cloneAvatarForRemotePlayer(scene, sid);
      if(!group) return;
      const rq = rot && rot.w != null
        ? new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w)
        : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      entry = {
        group,
        curPos: new THREE.Vector3(pos.x, feetY, pos.z),
        targetPos: new THREE.Vector3(pos.x, feetY, pos.z),
        curEyePos: new THREE.Vector3(pos.x, pos.y, pos.z),
        targetEyePos: new THREE.Vector3(pos.x, pos.y, pos.z),
        curQuat: rq.clone(),
        targetQuat: rq.clone(),
        curYaw: yaw,
        targetYaw: yaw,
        dead: false,
        weaponType: 'rifle',
        spawnProtectUntil: prot ? performance.now() + MP_SPAWN_PROTECT_MS : 0,
      };
      remotePlayerMap.set(sid, entry);
      setRemotePlayerAvatarTransform(group, pos.x, feetY, pos.z, yaw);
      group.visible = true;
      return;
    }
    entry.targetPos.set(pos.x, feetY, pos.z);
    entry.targetYaw = yaw;
    if(entry.targetEyePos) entry.targetEyePos.set(pos.x, pos.y, pos.z);
    if(entry.targetQuat && rot && rot.w != null) entry.targetQuat.set(rot.x, rot.y, rot.z, rot.w);
    if(prot) entry.spawnProtectUntil = performance.now() + MP_SPAWN_PROTECT_MS;
  }
  markRemotePlayerAlive(sid);
}

/** 上报枪械命中参数，伤害由服务端计算 */
function postMultiplayerGunHit(targetId, weaponName, bodyPart, distanceMeters, throughWood) {
  if(!multiplayerData || !multiplayerData.roomId || targetId == null) return;
  window.parent.postMessage({
    type: 'mp-send-hit',
    roomId: multiplayerData.roomId,
    targetId: String(targetId),
    weapon: String(weaponName || ''),
    hitType: 'gun',
    bodyPart: String(bodyPart || 'torso'),
    distanceMeters: Number(distanceMeters) || 0,
    throughWood: !!throughWood,
  }, '*');
}

function postMultiplayerMeleeHit(targetId, meleeKind) {
  if(!multiplayerData || !multiplayerData.roomId || targetId == null) return;
  window.parent.postMessage({
    type: 'mp-send-hit',
    roomId: multiplayerData.roomId,
    targetId: String(targetId),
    weapon: 'Knife',
    hitType: 'melee',
    meleeKind: meleeKind === 'heavy' ? 'heavy' : 'light',
  }, '*');
}

function postMultiplayerRespawnSync() {
  if(!multiplayerData || !multiplayerData.roomId || !camera) return;
  const q = camera.quaternion;
  window.parent.postMessage({
    type: 'mp-respawn-self',
    roomId: multiplayerData.roomId,
    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
  }, '*');
}

/** 本机 socket id：优先 init 的 localSocketId，否则用 players 里自己的 odId（与 room:join 写入 DB 一致） */
function getLocalMultiplayerSocketId() {
  if(!multiplayerData) return '';
  if(multiplayerData.localSocketId != null && multiplayerData.localSocketId !== '') {
    return String(multiplayerData.localSocketId);
  }
  const pid = String(multiplayerData.playerId || '');
  const me = (multiplayerData.players || []).find(p =>
    p.playerId != null && String(p.playerId) === pid
  );
  if(me && me.odId != null && me.odId !== '') return String(me.odId);
  return '';
}

function normalizeMultiplayerRoomPlayersStats() {
  if(!multiplayerData || !multiplayerData.players) return;
  for(let i = 0; i < multiplayerData.players.length; i++) {
    const p = multiplayerData.players[i];
    if(!p.stats) p.stats = {};
    p.stats.kills = Number(p.stats.kills) || 0;
    p.stats.deaths = Number(p.stats.deaths) || 0;
    p.stats.score = Number(p.stats.score) || 0;
    p.stats.mvps = Number(p.stats.mvps) || 0;
    p.stats.damage = Math.round(Number(p.stats.damage) || 0);
    p.stats.headshots = Number(p.stats.headshots) || 0;
  }
}

/** 联机 PVP：击杀/爆头 HUD 与本地缓存均以服务端 stats 为准 */
function syncLocalHudStatsFromMultiplayerData(lastKillWasHeadshot) {
  if(!isPvpMultiplayerRoom() || !multiplayerData || !multiplayerData.players) return;
  const pid = String(multiplayerData.playerId || '');
  const sock = getLocalMultiplayerSocketId();
  const me = multiplayerData.players.find(p => {
    const matchPid = p.playerId != null && String(p.playerId) === pid;
    const matchSock = !!sock && String(p.odId || '') === sock;
    return matchPid || matchSock;
  });
  if(!me || !me.stats) return;
  GAME.kills = Number(me.stats.kills) || 0;
  GAME.headshots = Number(me.stats.headshots) || 0;
  updateScoreUI();
  updateKillCounter(!!lastKillWasHeadshot);
}

/** 用服务端 game:playerHit 中的 stats 更新本地房间战绩缓存（供 Tab 战绩板） */
function mergeRoomStatsFromPlayerHitPayload(payload) {
  if(!payload || !multiplayerData || !multiplayerData.players) return;
  const applyStats = (socketId, playerIdStr, statsObj) => {
    if(!statsObj) return;
    const sid = String(socketId || '');
    const pid = String(playerIdStr || '');
    let p = multiplayerData.players.find(x => String(x.odId || '') === sid);
    if(!p && pid) {
      p = multiplayerData.players.find(x => {
        const xid = x.playerId;
        const xs = xid != null && xid !== '' ? String(xid) : '';
        return xs === pid;
      });
    }
    if(!p) return;
    if(!p.stats) p.stats = {};
    p.stats.kills = Number(statsObj.kills) || 0;
    p.stats.deaths = Number(statsObj.deaths) || 0;
    p.stats.score = Number(statsObj.score) || 0;
    p.stats.mvps = Number(statsObj.mvps) || 0;
    p.stats.damage = Math.round(Number(statsObj.damage) || 0);
    p.stats.headshots = Number(statsObj.headshots) || 0;
    /** init 时 odId 可能滞后于当前 socket，命中包更准，便于后续事件继续匹配 */
    if(sid && String(p.odId || '') !== sid) {
      p.odId = sid;
    }
  };
  /** 服务端已在广播前写入击杀/死亡/得分，此处只同步快照，不可再 +1（否则会重复计数） */
  applyStats(payload.attackerId, payload.attackerPlayerId, payload.attackerStats);
  applyStats(payload.targetId, payload.targetPlayerId, payload.targetStats);
}

/**
 * game:playerHit 广播：本地受害者扣血；全员同步远端尸体与击杀播报。
 */
function handleMultiplayerPlayerHit(payload) {
  if(!payload || !multiplayerData) return;
  mergeRoomStatsFromPlayerHitPayload(payload);
  const myId = getLocalMultiplayerSocketId();
  const tid = String(payload.targetId || '');
  const aid = String(payload.attackerId || '');
  const isHeadshotKill = String(payload.hitType || '') === 'headshot';

  if(myId && tid && tid === myId) {
    const skipDmg = isPvpMultiplayerRoom() && performance.now() < localSpawnProtectUntil;
    if(!skipDmg) {
      if(payload.remainingHealth != null) {
        GAME.health = Math.max(0, Number(payload.remainingHealth));
      } else {
        const d = Math.max(0, Math.floor(Number(payload.damage) || 0));
        GAME.health = Math.max(0, GAME.health - d);
      }
      updateHealthUI();
      showDamageOverlay();
      if(GAME.health <= 0) {
        if(isPvpMultiplayerRoom()) {
          if(isMultiplayer1v1RoomMode()) begin1v1RoundDeath();
          else beginRespawnCountdown();
        } else gameOver();
      }
    }
  }

  if(payload.killed && tid) {
    markRemotePlayerDead(tid);
  }

  if(payload.killed && myId && aid && aid === myId && tid && tid !== myId) {
    showKillFeed(getMpPlayerNickname(tid), isHeadshotKill);
  }
  if(isPvpMultiplayerRoom()) {
    const localGotKill = !!(payload.killed && myId && aid === myId && tid && tid !== myId);
    syncLocalHudStatsFromMultiplayerData(localGotKill && isHeadshotKill);
  }

  if(tabScoreboardHeld) refreshTabScoreboardTable();
}

function getTeamSpawnUvList() {
  const team = GAME.playerTeam || 'CT';
  if(team === 'T' && GAME.dust2TSpawnPoints && GAME.dust2TSpawnPoints.length) return GAME.dust2TSpawnPoints;
  if(team === 'CT' && GAME.dust2CtSpawnPoints && GAME.dust2CtSpawnPoints.length) return GAME.dust2CtSpawnPoints;
  return GAME.dust2FixedSpawnPoints || [];
}

/** 同队真人按 odId 排序后的序号，用于轮换不同出生 UV */
function computeSpawnSlotIndex() {
  const team = GAME.playerTeam || 'CT';
  if(!multiplayerData || !multiplayerData.players || !multiplayerData.playerId) return 0;
  const pid = String(multiplayerData.playerId);
  const humans = multiplayerData.players.filter(p => p.team === team && !p.isBot);
  const sorted = humans.slice().sort((a, b) => {
    const sa = String(a.odId || a.nickname || '');
    const sb = String(b.odId || b.nickname || '');
    return sa.localeCompare(sb);
  });
  const ix = sorted.findIndex(p =>
    (p.playerId != null && String(p.playerId) === pid) ||
    String(p.odId || '') === pid
  );
  return ix >= 0 ? ix : 0;
}

function minDistToAnyNpcAt(x, z) {
  let m = Infinity;
  for(let ei = 0; ei < enemies.length; ei++) {
    const e = enemies[ei];
    if(e.dead) continue;
    m = Math.min(m, Math.hypot(x - e.group.position.x, z - e.group.position.z));
  }
  return m;
}

function minDistToRemoteHumansAt(x, z) {
  let m = Infinity;
  remotePlayerMap.forEach((entry) => {
    if(entry.dead) return;
    m = Math.min(m, Math.hypot(x - entry.curPos.x, z - entry.curPos.z));
  });
  return m;
}

/** 1v1：与存活对手水平距离须大于此值（米），禁止出生/复活叠在同一标定点 */
const PVP_1V1_MIN_SPAWN_SEPARATION = 5;

function pvp1v1RemoteSpawnClearanceMin(baseNpcOrRemote) {
  const b = Number(baseNpcOrRemote) || 0;
  if(isMultiplayer1v1RoomMode() && isPvpMultiplayerRoom())
    return Math.max(b, PVP_1V1_MIN_SPAWN_SEPARATION);
  return b;
}

/**
 * PVP：在本队所有合法 UV 出生区中随机顺序尝试（避免固定两个点轮换）。
 */
function tryPickFromTeamSpawnListRandom(minNpcDist) {
  const b = mapWorldBounds;
  const list = getTeamSpawnUvList();
  if(!b || !list || !list.length) return null;
  const em = GAME.dust2SpawnEdgeMargin != null ? GAME.dust2SpawnEdgeMargin : 0.07;
  const n = list.length;
  const order = list.map((_, i) => i).sort(() => Math.random() - 0.5);
  const jitter = (GAME.dust2SpawnJitter != null ? GAME.dust2SpawnJitter : 0.011) * 1.35;
  for(let oi = 0; oi < order.length; oi++) {
    const fp = list[order[oi]];
    const { u, v } = applyUvFlip(fp.u, fp.v);
    for(let t = 0; t < 14; t++) {
      const ju = jitter * (1 + t * 0.06);
      const uu = THREE.MathUtils.clamp(u + (Math.random() - 0.5) * ju * 2, em, 1 - em);
      const vv = THREE.MathUtils.clamp(v + (Math.random() - 0.5) * ju * 2, em, 1 - em);
      const { u: uuu, v: vvv } = applyUvFlip(uu, vv);
      const p = dust2UvToXZExact(b, uuu, vvv, em);
      const x = p.x;
      const z = p.z;
      if(!dust2PlayerSpawnValid(x, z)) continue;
      const npcMin = minNpcDist;
      const remoteMin = pvp1v1RemoteSpawnClearanceMin(minNpcDist);
      if(npcMin > 0 && minDistToAnyNpcAt(x, z) <= npcMin) continue;
      if(remoteMin > 0 && minDistToRemoteHumansAt(x, z) <= remoteMin) continue;
      return new THREE.Vector3(x, 0, z);
    }
  }
  return null;
}

/**
 * 按阵营从多个 UV 出生点中选取；优先本队序号对应的点，再轮换尝试。
 */
function tryPickFromTeamSpawnList(minNpcDist) {
  const b = mapWorldBounds;
  const list = getTeamSpawnUvList();
  if(!b || !list || !list.length) return null;
  const em = GAME.dust2SpawnEdgeMargin != null ? GAME.dust2SpawnEdgeMargin : 0.07;
  const slot = computeSpawnSlotIndex();
  const n = list.length;
  const order = [];
  for(let k = 0; k < n; k++) order.push((slot + k) % n);
  const jitter = (GAME.dust2SpawnJitter != null ? GAME.dust2SpawnJitter : 0.011) * 1.35;
  for(let oi = 0; oi < order.length; oi++) {
    const fp = list[order[oi]];
    const { u, v } = applyUvFlip(fp.u, fp.v);
    for(let t = 0; t < 14; t++) {
      const ju = jitter * (1 + t * 0.06);
      const uu = THREE.MathUtils.clamp(u + (Math.random() - 0.5) * ju * 2, em, 1 - em);
      const vv = THREE.MathUtils.clamp(v + (Math.random() - 0.5) * ju * 2, em, 1 - em);
      const { u: uuu, v: vvv } = applyUvFlip(uu, vv);
      const p = dust2UvToXZExact(b, uuu, vvv, em);
      const x = p.x;
      const z = p.z;
      if(!dust2PlayerSpawnValid(x, z)) continue;
      if(minNpcDist > 0 && minDistToAnyNpcAt(x, z) <= minNpcDist) continue;
      const remoteMinTs = pvp1v1RemoteSpawnClearanceMin(minNpcDist);
      if(remoteMinTs > 0 && minDistToRemoteHumansAt(x, z) <= remoteMinTs) continue;
      return new THREE.Vector3(x, 0, z);
    }
  }
  return null;
}

/** 固定 u,v 点（无抖动）里挑一个满足校验与离敌人距离 */
function tryPickFromFixedSpawnPoints(minEnemyDist) {
  const b = mapWorldBounds;
  const fixedList = GAME.dust2FixedSpawnPoints;
  if(!b || !fixedList || !fixedList.length) return null;
  const em = GAME.dust2SpawnEdgeMargin != null ? GAME.dust2SpawnEdgeMargin : 0.07;
  const order = fixedList.map((_, i) => i).sort(() => Math.random() - 0.5);
  for(let k = 0; k < order.length; k++) {
    const fp = fixedList[order[k]];
    const { u, v } = applyUvFlip(fp.u, fp.v);
    const { x, z } = dust2UvToXZExact(b, u, v, em);
    if(!dust2PlayerSpawnValid(x, z)) continue;
    if(minEnemyDist > 0) {
      let md = 1000;
      for(const enemy of enemies) {
        md = Math.min(md, Math.hypot(x - enemy.group.position.x, z - enemy.group.position.z));
      }
      if(md <= minEnemyDist) continue;
    }
    const remoteMinFx = pvp1v1RemoteSpawnClearanceMin(0);
    if(remoteMinFx > 0 && minDistToRemoteHumansAt(x, z) <= remoteMinFx) continue;
    return new THREE.Vector3(x, 0, z);
  }
  return null;
}

/** 兜底：只保证脚底不在包围盒底面以下，避免出生在地图底下 */
function pickDust2SpawnXZEmergencySafe() {
  const b = mapWorldBounds;
  if(!b) return new THREE.Vector3(0, 0, 0);
  const margin = GAME.dust2SpawnEdgeMargin != null ? GAME.dust2SpawnEdgeMargin : 0.07;
  for(let t = 0; t < 160; t++) {
    const u = margin + Math.random() * (1 - 2 * margin);
    const v = margin + Math.random() * (1 - 2 * margin);
    const { u: uu, v: vv } = applyUvFlip(u, v);
    const x = b.min.x + uu * (b.max.x - b.min.x);
    const z = b.min.z + vv * (b.max.z - b.min.z);
    const fy = dust2SpawnFeetYAt(x, z);
    if(fy > 0 && dust2SpawnGroundNotBelowMapMin(fy)) {
      return new THREE.Vector3(x, 0, z);
    }
  }
  const cx = (b.min.x + b.max.x) * 0.5;
  const cz = (b.min.z + b.max.z) * 0.5;
  const fyc = dust2SpawnFeetYAt(cx, cz);
  if(fyc > 0 && dust2SpawnGroundNotBelowMapMin(fyc)) return new THREE.Vector3(cx, 0, cz);
  console.warn('[dust2] 未找到脚底在地图底面之上的出生 XZ，使用中心（高度由 getEyeY 兜底）');
  return new THREE.Vector3(cx, 0, cz);
}

function getDust2WorldSpawnPointList() {
  const w = GAME.dust2WorldSpawnPoints;
  if(w && w.length) return w;
  const legacy = GAME.dust2WorldRespawnPoints;
  return legacy && legacy.length ? legacy : [];
}

/** 脚底射线能落在地图可走面上（不强制开阔/坡度等完整校验） */
function dust2WorldSpawnFeetPlausible(x, z) {
  const fy = dust2SpawnFeetYAt(x, z);
  return fy > 0 && dust2SpawnGroundNotBelowMapMin(fy);
}

/**
 * 沙漠2：从用户标定的世界坐标 XZ 随机抽取；开局与复活共用同一套点。
 * 优先满足与 NPC/远端的最小距离；再放宽为仅脚底合理；最后仍返回随机标定点（由 dust2Apply 吸附地面）。
 */
function pickRandomDust2WorldSpawnXZ() {
  const list = getDust2WorldSpawnPointList();
  if(!mapUseBVHCollision || !mapWorldBounds || !list.length) return null;
  const tryWith = (minEnemy, minRemote, requirePlausibleFeet) => {
    const order = list.map((_, i) => i).sort(() => Math.random() - 0.5);
    for(let oi = 0; oi < order.length; oi++) {
      const { x, z } = list[order[oi]];
      if(requirePlausibleFeet && !dust2WorldSpawnFeetPlausible(x, z)) continue;
      if(minEnemy > 0) {
        let md = 1000;
        for(let ei = 0; ei < enemies.length; ei++) {
          const e = enemies[ei];
          if(e.dead) continue;
          md = Math.min(md, Math.hypot(x - e.group.position.x, z - e.group.position.z));
        }
        if(md <= minEnemy) continue;
      }
      const effRemote = pvp1v1RemoteSpawnClearanceMin(minRemote);
      if(effRemote > 0 && minDistToRemoteHumansAt(x, z) <= effRemote) continue;
      return new THREE.Vector3(x, 0, z);
    }
    return null;
  };
  let p = tryWith(5, 5, true);
  if(!p) p = tryWith(3, 3, true);
  if(!p) p = tryWith(0, 0, true);
  if(!p) p = tryWith(5, 5, false);
  if(!p) p = tryWith(0, 0, false);
  if(!p) {
    if(isMultiplayer1v1RoomMode() && isPvpMultiplayerRoom()) {
      let best = null;
      let bestD = -1;
      for(let i = 0; i < list.length; i++) {
        const { x, z } = list[i];
        const d = minDistToRemoteHumansAt(x, z);
        if(d <= PVP_1V1_MIN_SPAWN_SEPARATION) continue;
        if(d > bestD) {
          bestD = d;
          best = { x, z };
        }
      }
      if(best) return new THREE.Vector3(best.x, 0, best.z);
    }
    const k = Math.floor(Math.random() * list.length);
    const { x, z } = list[k];
    return new THREE.Vector3(x, 0, z);
  }
  return p;
}

function pickDust2SpawnXZForPlayer() {
  const b = mapWorldBounds;
  if(mapUseBVHCollision && b && getDust2WorldSpawnPointList().length) {
    const wp = pickRandomDust2WorldSpawnXZ();
    if(wp) return wp;
  }
  if(getTeamSpawnUvList().length) {
    const pickTeamSpawn = isPvpMultiplayerRoom() ? tryPickFromTeamSpawnListRandom : tryPickFromTeamSpawnList;
    let pos = pickTeamSpawn(5);
    if(pos) return pos;
    pos = pickTeamSpawn(3);
    if(pos) return pos;
    pos = pickTeamSpawn(0);
    if(pos) return pos;
  }
  if(GAME.dust2UseFixedSpawnPointsOnly && GAME.dust2FixedSpawnPoints && GAME.dust2FixedSpawnPoints.length) {
    let pos = tryPickFromFixedSpawnPoints(5);
    if(pos) return pos;
    pos = tryPickFromFixedSpawnPoints(3);
    if(pos) return pos;
    pos = tryPickFromFixedSpawnPoints(0);
    if(pos) return pos;
    if(!GAME.dust2SpawnFallbackToRandom) {
      const em = GAME.dust2SpawnEdgeMargin != null ? GAME.dust2SpawnEdgeMargin : 0.07;
      const fixedList = GAME.dust2FixedSpawnPoints;
      for(let i = 0; i < fixedList.length; i++) {
        const fp = fixedList[i];
        const { u, v } = applyUvFlip(fp.u, fp.v);
        const p = dust2UvToXZExact(b, u, v, em);
        const fy = dust2SpawnFeetYAt(p.x, p.z);
        if(fy > 0 && dust2SpawnGroundNotBelowMapMin(fy)) {
          return new THREE.Vector3(p.x, 0, p.z);
        }
      }
      return pickDust2SpawnXZEmergencySafe();
    }
  }

  const uvs = getMergedSpawnUvs();
  const jitter = GAME.dust2SpawnJitter != null ? GAME.dust2SpawnJitter : 0.011;
  const perUv = GAME.dust2SpawnPerUvTries != null ? GAME.dust2SpawnPerUvTries : 16;
  const order = uvs.map((_, i) => i).sort(() => Math.random() - 0.5);
  const margin = GAME.dust2SpawnEdgeMargin != null ? GAME.dust2SpawnEdgeMargin : 0.07;

  for(let k = 0; k < order.length; k++) {
    const uv = uvs[order[k]];
    for(let t = 0; t < perUv; t++) {
      const { x, z } = dust2UvWorldXZ(b, uv, jitter);
      if(!dust2PlayerSpawnValid(x, z)) continue;
      let minDist = 1000;
      for(const enemy of enemies) {
        const dist = Math.hypot(x - enemy.group.position.x, z - enemy.group.position.z);
        minDist = Math.min(minDist, dist);
      }
      {
        const rr = pvp1v1RemoteSpawnClearanceMin(0);
        if(rr > 0 && minDistToRemoteHumansAt(x, z) <= rr) continue;
      }
      if(minDist > 5) return new THREE.Vector3(x, 0, z);
    }
  }

  for(let i = 0; i < uvs.length; i++) {
    const uv = uvs[i];
    for(let t = 0; t < perUv; t++) {
      const { x, z } = dust2UvWorldXZ(b, uv, jitter * 0.7);
      if(!dust2PlayerSpawnValid(x, z)) continue;
      let minDist = 1000;
      for(const enemy of enemies) {
        minDist = Math.min(minDist, Math.hypot(x - enemy.group.position.x, z - enemy.group.position.z));
      }
      {
        const rr = pvp1v1RemoteSpawnClearanceMin(0);
        if(rr > 0 && minDistToRemoteHumansAt(x, z) <= rr) continue;
      }
      if(minDist > 3.5) return new THREE.Vector3(x, 0, z);
    }
  }

  for(let i = 0; i < uvs.length; i++) {
    const uv = uvs[i];
    for(let t = 0; t < perUv; t++) {
      const { x, z } = dust2UvWorldXZ(b, uv, jitter * 0.55);
      if(!dust2PlayerSpawnValid(x, z)) continue;
      {
        const rr = pvp1v1RemoteSpawnClearanceMin(0);
        if(rr > 0 && minDistToRemoteHumansAt(x, z) <= rr) continue;
      }
      return new THREE.Vector3(x, 0, z);
    }
  }

  const mc = GAME.dust2SpawnMonteCarloTries != null ? GAME.dust2SpawnMonteCarloTries : 80;
  for(let t = 0; t < mc; t++) {
    const u = margin + Math.random() * (1 - 2 * margin);
    const v = margin + Math.random() * (1 - 2 * margin);
    const { u: uu, v: vv } = applyUvFlip(u, v);
    const x = b.min.x + uu * (b.max.x - b.min.x);
    const z = b.min.z + vv * (b.max.z - b.min.z);
    if(!dust2PlayerSpawnValid(x, z)) continue;
    let minDist = 1000;
    for(const enemy of enemies) {
      minDist = Math.min(minDist, Math.hypot(x - enemy.group.position.x, z - enemy.group.position.z));
    }
    {
      const rr = pvp1v1RemoteSpawnClearanceMin(0);
      if(rr > 0 && minDistToRemoteHumansAt(x, z) <= rr) continue;
    }
    if(minDist > 4) return new THREE.Vector3(x, 0, z);
  }

  for(let t = 0; t < 50; t++) {
    const u = margin + Math.random() * (1 - 2 * margin);
    const v = margin + Math.random() * (1 - 2 * margin);
    const { u: uu, v: vv } = applyUvFlip(u, v);
    const x = b.min.x + uu * (b.max.x - b.min.x);
    const z = b.min.z + vv * (b.max.z - b.min.z);
    if(!dust2PlayerSpawnValid(x, z)) continue;
    {
      const rr = pvp1v1RemoteSpawnClearanceMin(0);
      if(rr > 0 && minDistToRemoteHumansAt(x, z) <= rr) continue;
    }
    return new THREE.Vector3(x, 0, z);
  }

  return pickDust2SpawnXZEmergencySafe();
}

function pickDust2BotSpawnXZ() {
  const b = mapWorldBounds;
  const wl = getDust2WorldSpawnPointList();
  if(mapUseBVHCollision && b && wl.length) {
    const order = wl.map((_, i) => i).sort(() => Math.random() - 0.5);
    for(let k = 0; k < order.length; k++) {
      const { x, z } = wl[order[k]];
      if(dust2WorldSpawnFeetPlausible(x, z) && dust2PlayerSpawnValid(x, z)) return { x, z };
    }
    for(let k = 0; k < order.length; k++) {
      const { x, z } = wl[order[k]];
      if(dust2WorldSpawnFeetPlausible(x, z)) return { x, z };
    }
    const k = Math.floor(Math.random() * wl.length);
    return { x: wl[k].x, z: wl[k].z };
  }
  if(GAME.dust2UseFixedSpawnPointsOnly && GAME.dust2FixedSpawnPoints && GAME.dust2FixedSpawnPoints.length) {
    const em = GAME.dust2SpawnEdgeMargin != null ? GAME.dust2SpawnEdgeMargin : 0.07;
    const fixedList = GAME.dust2FixedSpawnPoints;
    const order = fixedList.map((_, i) => i).sort(() => Math.random() - 0.5);
    for(let k = 0; k < order.length; k++) {
      const fp = fixedList[order[k]];
      const { u, v } = applyUvFlip(fp.u, fp.v);
      const { x, z } = dust2UvToXZExact(b, u, v, em);
      if(dust2PlayerSpawnValid(x, z)) return { x, z };
    }
    if(!GAME.dust2SpawnFallbackToRandom) {
      for(let i = 0; i < fixedList.length; i++) {
        const fp = fixedList[i];
        const { u, v } = applyUvFlip(fp.u, fp.v);
        const p = dust2UvToXZExact(b, u, v, em);
        const fy = dust2SpawnFeetYAt(p.x, p.z);
        if(fy > 0 && dust2SpawnGroundNotBelowMapMin(fy)) return p;
      }
      const ep = pickDust2SpawnXZEmergencySafe();
      return { x: ep.x, z: ep.z };
    }
  }

  const uvs = getMergedSpawnUvs();
  const jitter = GAME.dust2SpawnJitter != null ? GAME.dust2SpawnJitter : 0.011;
  const margin = GAME.dust2SpawnEdgeMargin != null ? GAME.dust2SpawnEdgeMargin : 0.07;
  for(let attempt = 0; attempt < 4; attempt++) {
    const uv = uvs[Math.floor(Math.random() * uvs.length)];
    for(let t = 0; t < 18; t++) {
      const { x, z } = dust2UvWorldXZ(b, uv, jitter);
      if(dust2PlayerSpawnValid(x, z)) return { x, z };
    }
  }
  for(let t = 0; t < 52; t++) {
    const u = margin + Math.random() * (1 - 2 * margin);
    const v = margin + Math.random() * (1 - 2 * margin);
    const { u: uu, v: vv } = applyUvFlip(u, v);
    const x = b.min.x + uu * (b.max.x - b.min.x);
    const z = b.min.z + vv * (b.max.z - b.min.z);
    if(dust2PlayerSpawnValid(x, z)) return { x, z };
  }
  const uv = uvs[0];
  const last = dust2UvWorldXZ(b, uv, jitter * 0.35);
  const fy = dust2SpawnFeetYAt(last.x, last.z);
  if(fy > 0 && dust2SpawnGroundNotBelowMapMin(fy)) return last;
  const ep = pickDust2SpawnXZEmergencySafe();
  return { x: ep.x, z: ep.z };
}

/** 与已有 NPC 的最小水平距离（用于出生/重生，避免叠在同一点） */
function minDistToOtherEnemies(x, z, selfEnemy) {
  let m = Infinity;
  for(let ei = 0; ei < enemies.length; ei++) {
    const e = enemies[ei];
    if(e === selfEnemy || e.dead) continue;
    const d = Math.hypot(x - e.group.position.x, z - e.group.position.z);
    m = Math.min(m, d);
  }
  return m;
}

/**
 * 在 pickDust2BotSpawnXZ 基础上尽量拉开 NPC 间距；仍失败则退回单点逻辑。
 */
function pickDust2BotSpawnXZSeparated(minDist = 2.6, selfEnemy = null) {
  if(!mapWorldBounds) return pickDust2BotSpawnXZ();
  const need = Math.max(0.5, minDist);
  for(let iter = 0; iter < 72; iter++) {
    const p = pickDust2BotSpawnXZ();
    if(minDistToOtherEnemies(p.x, p.z, selfEnemy) >= need) return p;
    const ang = Math.random() * Math.PI * 2;
    const r = need * 0.85 + Math.random() * 3.8;
    const x2 = p.x + Math.cos(ang) * r;
    const z2 = p.z + Math.sin(ang) * r;
    if(dust2PlayerSpawnValid(x2, z2) && minDistToOtherEnemies(x2, z2, selfEnemy) >= need * 0.75) {
      return { x: x2, z: z2 };
    }
  }
  return pickDust2BotSpawnXZ();
}

/** dust2：巡逻点落在可走圆柱内，避免目标在墙里导致原地蹭墙 */
function initDust2EnemyPatrolPoints(enemy) {
  if(!mapUseBVHCollision || !mapBVHCollisionMesh || !mapWorldBounds) return;
  const base = enemy.group.position;
  const by = base.y;
  const pts = [];
  for(let i = 0; i < 3; i++) {
    let placed = false;
    for(let t = 0; t < 22; t++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = 5 + Math.random() * 16;
      const px = base.x + Math.cos(ang) * rad;
      const pz = base.z + Math.sin(ang) * rad;
      if(!enemyPositionBlocked(px, pz, by)) {
        const py = dust2SpawnFeetYAt(px, pz, by);
        pts.push(new THREE.Vector3(px, py, pz));
        placed = true;
        break;
      }
    }
    if(!placed) pts.push(base.clone());
  }
  enemy.patrolPoints = pts;
  enemy.patrolIndex = 0;
}

// Random spawn for PVP - open areas away from enemies
function getRandomSpawnPos() {
  if(mapUseBVHCollision && mapWorldBounds) {
    return pickDust2SpawnXZForPlayer();
  }

  const openAreas = [
    { x: 0, z: -22, radius: 8 },    // CT Spawn area
    { x: 0, z: 22, radius: 8 },     // T Spawn area  
    { x: -18, z: -10, radius: 6 },  // B site
    { x: 18, z: -10, radius: 6 },   // A site
    { x: 0, z: 0, radius: 5 },      // Mid
    { x: 10, z: -18, radius: 5 },   // Long A
    { x: -10, z: 8, radius: 5 },    // Tunnels
  ];
  
  // Pick random area
  const area = openAreas[Math.floor(Math.random() * openAreas.length)];
  
  // Find position away from enemies
  for(let attempt = 0; attempt < 20; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * area.radius;
    const x = area.x + Math.cos(angle) * r;
    const z = area.z + Math.sin(angle) * r;
    
    // Check distance from enemies
    let minDist = 1000;
    for(const enemy of enemies) {
      const dist = Math.hypot(x - enemy.group.position.x, z - enemy.group.position.z);
      minDist = Math.min(minDist, dist);
    }
    
    if(isMultiplayer1v1RoomMode() && isPvpMultiplayerRoom()) {
      const rm = pvp1v1RemoteSpawnClearanceMin(0);
      if(rm > 0 && minDistToRemoteHumansAt(x, z) <= rm) continue;
    }
    // If far enough from enemies and not in wall, use this position
    if(minDist > 8 && !isInsideWall(x, z)) {
      return new THREE.Vector3(x, 0, z);
    }
  }
  
  // Fallback
  return new THREE.Vector3(area.x, 0, area.z);
}

/** 世界复活点：NPC/远端距离与脚底合理性（与 pickBest / pickMedium 共用） */
function dust2WorldRespawnFiltersOk(x, z, minNpc, requirePlausibleFeet) {
  if(requirePlausibleFeet && !dust2WorldSpawnFeetPlausible(x, z)) return false;
  if(minNpc > 0 && minDistToAnyNpcAt(x, z) <= minNpc) return false;
  const remoteMin = pvp1v1RemoteSpawnClearanceMin(minNpc);
  if(remoteMin > 0 && minDistToRemoteHumansAt(x, z) <= remoteMin) return false;
  return true;
}

/**
 * 1v1：在候选标定点中选相对阵亡位置「中等距离」——
 * 先取当前 minNpc 下所有合法点距阵亡点的 d_min、d_max，再选 d 最接近 (d_min+d_max)/2 的一点（并列随机）。
 */
function pickMediumDust2WorldRespawn(ax, az, minNpc) {
  const wr = getDust2WorldSpawnPointList();
  if(!wr || !wr.length) return null;
  function collect(requireFeet) {
    const out = [];
    for(let i = 0; i < wr.length; i++) {
      const { x, z } = wr[i];
      if(!dust2WorldRespawnFiltersOk(x, z, minNpc, requireFeet)) continue;
      out.push({ x, z, d: Math.hypot(x - ax, z - az) });
    }
    return out;
  }
  let candidates = collect(true);
  if(!candidates.length) candidates = collect(false);
  if(!candidates.length) return null;
  let dMin = Infinity;
  let dMax = -Infinity;
  for(let i = 0; i < candidates.length; i++) {
    const d = candidates[i].d;
    dMin = Math.min(dMin, d);
    dMax = Math.max(dMax, d);
  }
  const target = (dMin + dMax) * 0.5;
  const ties = [];
  let bestAbs = Infinity;
  for(let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const ad = Math.abs(c.d - target);
    if(ad < bestAbs - 1e-6) {
      bestAbs = ad;
      ties.length = 0;
      ties.push(c);
    } else if(Math.abs(ad - bestAbs) < 1e-6) {
      ties.push(c);
    }
  }
  const pick = ties[Math.floor(Math.random() * ties.length)];
  return new THREE.Vector3(pick.x, 0, pick.z);
}

/**
 * 从 dust2WorldSpawnPoints 随机轮询：在 minNpc 约束下选离 (ax,az) 最远的一点。
 * 不强制 dust2PlayerSpawnValid（标定点易被判坡/开阔不合格）；脚底射线合理优先，否则仍参与距离比较。
 */
function pickBestDust2WorldRespawnSample(ax, az, minNpc, samples) {
  const wr = getDust2WorldSpawnPointList();
  if(!wr || !wr.length) return null;
  let best = null;
  let bestD = -1;
  const n = wr.length;
  for(let pass = 0; pass < 2; pass++) {
    const requireFeet = pass === 0;
    best = null;
    bestD = -1;
    for(let s = 0; s < samples; s++) {
      const p = wr[Math.floor(Math.random() * n)];
      const x = p.x;
      const z = p.z;
      if(!dust2WorldRespawnFiltersOk(x, z, minNpc, requireFeet)) continue;
      const d = Math.hypot(x - ax, z - az);
      if(d > bestD) {
        bestD = d;
        best = new THREE.Vector3(x, 0, z);
      }
    }
    if(best) return best;
  }
  const k = Math.floor(Math.random() * n);
  return new THREE.Vector3(wr[k].x, 0, wr[k].z);
}

/**
 * PVP 复活：非 1v1 时多次随机采样，选离阵亡位置较远的一点；1v1 时选中等距离，避免全图对角拉扯。
 */
function getRandomSpawnPosForRespawn() {
  if(!mapUseBVHCollision || !mapWorldBounds) {
    const ax = camera.position.x;
    const az = camera.position.z;
    const oneV1 = isMultiplayer1v1RoomMode();
    const samples = [];
    for(let i = 0; i < 28; i++) {
      samples.push(getRandomSpawnPos());
    }
    if(oneV1 && samples.length) {
      const rm0 = pvp1v1RemoteSpawnClearanceMin(0);
      const pool = rm0 > 0
        ? samples.filter((p) => minDistToRemoteHumansAt(p.x, p.z) > rm0)
        : samples;
      const useSamples = pool.length ? pool : samples;
      let dMin = Infinity;
      let dMax = -Infinity;
      const ds = useSamples.map((p) => {
        const d = Math.hypot(p.x - ax, p.z - az);
        dMin = Math.min(dMin, d);
        dMax = Math.max(dMax, d);
        return { p, d };
      });
      const target = (dMin + dMax) * 0.5;
      const ties = [];
      let bestAbs = Infinity;
      for(let i = 0; i < ds.length; i++) {
        const ad = Math.abs(ds[i].d - target);
        if(ad < bestAbs - 1e-6) {
          bestAbs = ad;
          ties.length = 0;
          ties.push(ds[i].p);
        } else if(Math.abs(ad - bestAbs) < 1e-6) {
          ties.push(ds[i].p);
        }
      }
      return ties[Math.floor(Math.random() * ties.length)].clone();
    }
    let best = samples[0];
    let bestD = Math.hypot(best.x - ax, best.z - az);
    for(let i = 1; i < samples.length; i++) {
      const p = samples[i];
      const d = Math.hypot(p.x - ax, p.z - az);
      if(d > bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }
  const ax = camera.position.x;
  const az = camera.position.z;
  const wr = getDust2WorldSpawnPointList();
  if(wr && wr.length) {
    if(isMultiplayer1v1RoomMode()) {
      let pos = pickMediumDust2WorldRespawn(ax, az, 5);
      if(!pos) pos = pickMediumDust2WorldRespawn(ax, az, 3);
      if(!pos) pos = pickMediumDust2WorldRespawn(ax, az, 0);
      if(pos) return pos;
    } else {
      let pos = pickBestDust2WorldRespawnSample(ax, az, 5, 56);
      if(!pos) pos = pickBestDust2WorldRespawnSample(ax, az, 3, 48);
      if(!pos) pos = pickBestDust2WorldRespawnSample(ax, az, 0, 40);
      if(pos) return pos;
    }
  }
  if(isMultiplayer1v1RoomMode()) {
    const samples = [];
    for(let i = 0; i < 36; i++) {
      samples.push(pickDust2SpawnXZForPlayer());
    }
    const rm0b = pvp1v1RemoteSpawnClearanceMin(0);
    const poolB = rm0b > 0
      ? samples.filter((p) => minDistToRemoteHumansAt(p.x, p.z) > rm0b)
      : samples;
    const useB = poolB.length ? poolB : samples;
    let dMin = Infinity;
    let dMax = -Infinity;
    const ds = useB.map((p) => {
      const d = Math.hypot(p.x - ax, p.z - az);
      dMin = Math.min(dMin, d);
      dMax = Math.max(dMax, d);
      return { p, d };
    });
    const target = (dMin + dMax) * 0.5;
    const ties = [];
    let bestAbs = Infinity;
    for(let i = 0; i < ds.length; i++) {
      const ad = Math.abs(ds[i].d - target);
      if(ad < bestAbs - 1e-6) {
        bestAbs = ad;
        ties.length = 0;
        ties.push(ds[i].p);
      } else if(Math.abs(ad - bestAbs) < 1e-6) {
        ties.push(ds[i].p);
      }
    }
    return ties[Math.floor(Math.random() * ties.length)].clone();
  }
  let best = pickDust2SpawnXZForPlayer();
  let bestD = Math.hypot(best.x - ax, best.z - az);
  for(let i = 0; i < 36; i++) {
    const p = pickDust2SpawnXZForPlayer();
    const d = Math.hypot(p.x - ax, p.z - az);
    if(d > bestD) {
      bestD = d;
      best = p.clone();
    }
  }
  return best;
}

function spawnEnemies() {
  if(mapUseBVHCollision && mapWorldBounds) {
    const types = ['normal', 'normal', 'elite', 'normal', 'normal', 'elite', 'normal', 'normal'];
    const em = GAME.dust2SpawnEdgeMargin != null ? GAME.dust2SpawnEdgeMargin : 0.07;
    const wl = getDust2WorldSpawnPointList();
    if(wl.length) {
      for(let i = 0; i < 8; i++) {
        const type = types[i] || 'normal';
        let x, z;
        let ok = false;
        for(let attempt = 0; attempt < wl.length * 6; attempt++) {
          const p = wl[(i + attempt) % wl.length];
          x = p.x;
          z = p.z;
          if(dust2WorldSpawnFeetPlausible(x, z) && minDistToOtherEnemies(x, z, null) >= 2.2) {
            ok = true;
            break;
          }
        }
        if(!ok) {
          const pb = pickDust2BotSpawnXZSeparated(2.5, null);
          x = pb.x;
          z = pb.z;
        }
        const feetY = dust2SpawnFeetYAt(x, z);
        const en = createEnemy(type, new THREE.Vector3(x, feetY, z), opponentTeamOfPlayer());
        initDust2EnemyPatrolPoints(en);
        enemies.push(en);
      }
      return;
    }
    if(GAME.dust2UseFixedSpawnPointsOnly && GAME.dust2FixedSpawnPoints && GAME.dust2FixedSpawnPoints.length) {
      const fixedList = GAME.dust2FixedSpawnPoints;
      for(let i = 0; i < 8; i++) {
        const type = types[i] || 'normal';
        let x, z;
        let ok = false;
        for(let attempt = 0; attempt < fixedList.length * 4; attempt++) {
          const fp = fixedList[(i + attempt) % fixedList.length];
          const { u, v } = applyUvFlip(fp.u, fp.v);
          const p = dust2UvToXZExact(mapWorldBounds, u, v, em);
          x = p.x;
          z = p.z;
          if(dust2PlayerSpawnValid(x, z) && minDistToOtherEnemies(x, z, null) >= 2.2) {
            ok = true;
            break;
          }
        }
        if(!ok) {
          const pb = pickDust2BotSpawnXZSeparated(2.5, null);
          x = pb.x;
          z = pb.z;
        }
        const feetY = dust2SpawnFeetYAt(x, z);
        const en = createEnemy(type, new THREE.Vector3(x, feetY, z), opponentTeamOfPlayer());
        initDust2EnemyPatrolPoints(en);
        enemies.push(en);
      }
      return;
    }

    const uvs = getMergedSpawnUvs();
    const jitter = GAME.dust2SpawnJitter != null ? GAME.dust2SpawnJitter : 0.011;
    uvs.forEach((uv, i) => {
      let x, z;
      let ok = false;
      for(let t = 0; t < 22; t++) {
        const p = dust2UvWorldXZ(mapWorldBounds, uv, jitter);
        x = p.x;
        z = p.z;
        if(dust2PlayerSpawnValid(x, z) && minDistToOtherEnemies(x, z, null) >= 2.2) {
          ok = true;
          break;
        }
      }
      if(!ok) {
        const pb = pickDust2BotSpawnXZSeparated(2.5, null);
        x = pb.x;
        z = pb.z;
      }
      const feetY = dust2SpawnFeetYAt(x, z);
      const type = types[i] || 'normal';
      const en = createEnemy(type, new THREE.Vector3(x, feetY, z), opponentTeamOfPlayer());
      initDust2EnemyPatrolPoints(en);
      enemies.push(en);
    });
    return;
  }

  // T side enemies (south/east areas)
  const spawnPoints = [
    { type:'normal', pos: [0, 20] },      // T spawn
    { type:'normal', pos: [5, 15] },       // Near T spawn
    { type:'normal', pos: [-11, 8] },      // Upper tunnels
    { type:'elite',  pos: [-17, 2] },      // Lower tunnels
    { type:'normal', pos: [11, -14] },     // Long A
    { type:'normal', pos: [0, 5] },        // Mid
    { type:'elite',  pos: [-20, -8] },     // B site
    { type:'normal', pos: [20, -12] },     // A site
  ];

  spawnPoints.forEach(sp => {
    const safePos = findSafeSpawnPos(sp.pos[0], sp.pos[1]);
    enemies.push(createEnemy(sp.type, safePos, opponentTeamOfPlayer()));
  });
}

// ============================================================
// EVENTS & INPUT
// ============================================================
const keys = {};

function setupEvents() {
  document.addEventListener('keydown', e => {
    keys[e.code] = true;
    if(e.code === 'KeyW') moveForward = true;
    if(e.code === 'KeyS') moveBackward = true;
    if(e.code === 'KeyA') moveLeft = true;
    if(e.code === 'KeyD') moveRight = true;
    if(e.code === 'ShiftLeft' || e.code === 'ShiftRight') isSprinting = true;
    if(e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyC') isCrouching = true;
    if(e.code === 'Space' && GAME.running && !GAME.paused) {
      if(devInfiniteJump) {
        velocity.y = GAME.jumpForce;
      } else if(onGround) {
        velocity.y = GAME.jumpForce;
        onGround = false;
      }
    }
    if(e.code === 'KeyJ' && GAME.running && !GAME.paused && !e.repeat) {
      devInfiniteJump = !devInfiniteJump;
    }
    if(e.code === 'KeyR' && GAME.running && !GAME.paused) startReload();
    if(e.code === 'Digit1' && ownedWeapons.primary) switchWeapon(primaryWeaponIndex);
    if(e.code === 'Digit2' && ownedWeapons.pistol) switchWeapon(pistolWeaponIndex);
    if(e.code === 'Digit3') switchWeapon(3); // Knife always available
    if(e.code === 'Digit4') switchWeapon(3); // Also 4 for knife
    if(e.code === 'KeyB' && GAME.running && !GAME.paused) toggleBuyMenu();
    if(e.code === 'KeyG' && GAME.running && !GAME.paused && !e.repeat) {
      attemptPickupWorldWeaponAtCrosshair();
    }
    if(e.code === 'KeyP' && GAME.running && !GAME.paused && !e.repeat) thirdPerson = !thirdPerson;
    if(e.code === 'Escape' && GAME.running) togglePause();
    if(e.code === 'Tab' && roomAllowsTabScoreboard()) {
      e.preventDefault();
      if(!e.repeat) setTabScoreboardVisible(true);
    }
  });

  document.addEventListener('keyup', e => {
    keys[e.code] = false;
    if(e.code === 'KeyW') moveForward = false;
    if(e.code === 'KeyS') moveBackward = false;
    if(e.code === 'KeyA') moveLeft = false;
    if(e.code === 'KeyD') moveRight = false;
    if(e.code === 'ShiftLeft' || e.code === 'ShiftRight') isSprinting = false;
    if(e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyC') isCrouching = false;
    if(e.code === 'Tab') setTabScoreboardVisible(false);
  });

  document.addEventListener('mousedown', e => {
    console.log('[MouseDown] button:', e.button, 'running:', GAME.running, 'paused:', GAME.paused, 'locked:', !!document.pointerLockElement);
    
    // Get current pointer lock state
    const isLocked = !!document.pointerLockElement;
    
    if(e.button === 2) {
      e.preventDefault();
    }
    
    if(!GAME.running || GAME.paused) {
      console.log('[MouseDown] Game not running or paused, ignoring');
      return;
    }
    
    if(e.button === 2 && isLocked) {
      const weapon = WEAPONS[currentWeaponIndex];
      console.log('[MouseDown] Right click with weapon:', weapon.name, weapon.type);
      
      if(weapon.type === 'sniper') {
        if(isReloading || awpBoltAnimRemaining > 0) return;
        awpScopeStage = (awpScopeStage + 1) % 3;
        playScopeToggleSFX(awpScopeStage > 0);
      } else if(weapon.type === 'melee') {
        if(isMeleeAttacking) return;
        cancelMeleeHeavyCharge();
        clearMeleeLightResidual();
        meleeHeavySequenceActive = true;
        meleeHeavySequenceStart = performance.now();
        meleeHeavyHitDone = false;
      }
      return;
    }
    
    if(e.button === 0 && isLocked) {
      const weapon = WEAPONS[currentWeaponIndex];
      console.log('[MouseDown] Left click with weapon:', weapon.name, weapon.type);
      
      if(weapon.type === 'melee') {
        cancelMeleeHeavyCharge();
        meleeLightHeld = true;
        performMeleeAttack('light');
      } else {
        isShooting = true;
        if(!weapon.auto) shoot();
      }
    }
  });

  document.addEventListener('mouseup', e => {
    if(e.button === 0) {
      isShooting = false;
      meleeLightHeld = false;
    }
  });

  renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

  let skipNextMove = false;
  document.addEventListener('pointerlockchange', () => {
    const wasLocked = pointerLocked;
    pointerLocked = !!document.pointerLockElement;
    if(!wasLocked && pointerLocked) skipNextMove = true;
    if(!pointerLocked) meleeLightHeld = false;
    // Show/hide cursor based on pointer lock state
    if(pointerLocked) {
      document.body.classList.add('in-game');
    } else {
      document.body.classList.remove('in-game');
    }
  });

  document.addEventListener('mousemove', e => {
    if(!pointerLocked || !GAME.running || GAME.paused) return;
    // Skip first event after pointer lock to prevent huge delta spike
    if(skipNextMove) { skipNextMove = false; return; }
    // Clamp to reasonable per-frame values (±30px is already a fast flick)
    const mx = Math.max(-40, Math.min(40, e.movementX));
    const my = Math.max(-40, Math.min(40, e.movementY));
    let sens = GAME.mouseSensitivity;
    if(awpScopeStage > 0 && WEAPONS[currentWeaponIndex].type === 'sniper') {
      sens *= awpScopeStage >= 2 ? SCOPE_SENS_MULT_2 : SCOPE_SENS_MULT;
    }
    yaw -= mx * sens;
    pitch -= my * sens;
    // Limit pitch to ~±70 degrees to prevent looking straight up/down
    pitch = Math.max(-1.22, Math.min(1.22, pitch));
  });

  // Click canvas to re-acquire pointer lock if it was lost
  renderer.domElement.addEventListener('click', () => {
    if(GAME.running && !GAME.paused && !pointerLocked) {
      renderer.domElement.requestPointerLock();
    }
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    if(viewmodelCamera) {
      viewmodelCamera.aspect = window.innerWidth/window.innerHeight;
      viewmodelCamera.updateProjectionMatrix();
    }
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  window.addEventListener('blur', () => setTabScoreboardVisible(false));
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState !== 'visible') setTabScoreboardVisible(false);
  });
}

// ============================================================
// WEAPON FUNCTIONS
// ============================================================
function currentWeapon() { return WEAPONS[currentWeaponIndex]; }

function switchWeapon(idx) {
  if(idx === currentWeaponIndex || !GAME.running || GAME.paused) return;
  
  cancelMeleeHeavyCharge();
  clearMeleeLightResidual();

  // Block shooting during switch
  canShoot = false;
  
  if(isReloading) cancelReload();
  awpScopeStage = 0;
  doubleZoomBlend = 0;
  weaponMag[currentWeaponIndex] = ammo;
  weaponReserve[currentWeaponIndex] = reserveAmmo;
  
  const oldWeaponType = WEAPONS[currentWeaponIndex].type;
  currentWeaponIndex = idx;
  const w = currentWeapon();
  ammo = weaponMag[idx];
  reserveAmmo = weaponReserve[idx];
  
  // Start switch animation
  weaponSwitchAnim = 1;
  vmSwitchY = 0.35;
  
  // Update viewmodel immediately but with animation
  const wType = w.type;
  sprayConsecutive = 0;
  lastSprayAt = 0;
  vmPunch.pitch = vmPunch.yaw = vmPunch.roll = vmPunch.x = vmPunch.y = vmPunch.z = 0;
  vmRecoilBackZ = 0;
  awpBoltAnimRemaining = 0;
  
  // Smooth transition - update viewmodel with animation
  setViewmodelWeapon(wType);
  
  // Re-enable shooting after animation
  setTimeout(() => {
    canShoot = true;
  }, 200);
  
  updateAmmoUI();
  updateWeaponSlots();
}

function initWeapon() {
  weaponMag = WEAPONS.map(x => x.magSize);
  weaponReserve = WEAPONS.map(x => x.reserve);
  ammo = weaponMag[currentWeaponIndex];
  reserveAmmo = weaponReserve[currentWeaponIndex];
  isReloading = false;
  cancelReload();
  canShoot = true;
  sprayConsecutive = 0;
  lastSprayAt = 0;
  recoilOffset.x = 0;
  recoilOffset.y = 0;
  vmPunch.pitch = vmPunch.yaw = vmPunch.roll = vmPunch.x = vmPunch.y = vmPunch.z = 0;
  vmRecoilBackZ = 0;
  awpBoltAnimRemaining = 0;
  updateAmmoUI();
  updateWeaponSlots();
}

function updateAmmoUI() {
  const w = currentWeapon();
  document.getElementById('ammo-current').textContent = ammo;
  document.getElementById('ammo-reserve').textContent = reserveAmmo;
  document.getElementById('weapon-name').textContent = w.name;
  const mob = document.getElementById('weapon-mobility');
  if(mob) {
    const sp = w.maxSpeedU != null ? w.maxSpeedU : Math.round(weaponMoveSpeedRatio(w) * 250);
    const wt = w.weightSU != null ? w.weightSU : '—';
    mob.textContent = '移速 ' + sp + ' u/s · 负重 ' + wt;
  }
  const cbar = document.getElementById('weapon-csgo-bar');
  if(cbar) {
    const ap = w.armorPenetration != null ? (w.armorPenetration + '%') : '—';
    const pn = w.penetration != null ? String(w.penetration) : '—';
    const rpm = w.fireRate > 0 ? Math.round(60000 / w.fireRate) : '—';
    const pr = w.price != null ? (' · $' + w.price) : '';
    cbar.textContent = '胸部伤害 ' + w.damage + ' · 穿甲 ' + ap + ' · 穿深 ' + pn + ' · RPM ' + rpm + pr;
  }
  document.getElementById('fire-mode').textContent = w.mode;
}

const WORLD_WEAPON_PICKUP_RAY_MAX = 3;
const WORLD_WEAPON_PICKUP_HORIZ_MAX = 2.35;
const _pickupRaycaster = new THREE.Raycaster();
const _pickupFwd = new THREE.Vector3();

function findWorldWeaponDropGroupFromObject(obj) {
  let o = obj;
  while(o) {
    if(o.userData && o.userData.kind === 'worldWeaponDrop') return o;
    o = o.parent;
  }
  return null;
}

function tryApplyWorldWeaponPickup(group) {
  if(!group || !group.userData || group.userData.kind !== 'worldWeaponDrop' || !scene) return;
  const wk = String(group.userData.weaponKey || '').toLowerCase();
  const wi = weaponKeyToWeaponIndex(wk);
  if(wi < 0) return;
  const mag = Math.max(0, Math.floor(Number(group.userData.mag) || 0));
  const reserve = Math.max(0, Math.floor(Number(group.userData.reserve) || 0));

  remotePlayerMap.forEach((entry) => {
    if(entry.dropWeaponGroup === group) entry.dropWeaponGroup = null;
  });
  for(let ei = 0; ei < enemies.length; ei++) {
    const e = enemies[ei];
    if(e && e.dropWeaponGroup === group) e.dropWeaponGroup = null;
  }

  scene.remove(group);
  removeWorldWeaponDropFromList(group);

  weaponMag[currentWeaponIndex] = ammo;
  weaponReserve[currentWeaponIndex] = reserveAmmo;

  if(wk === 'usp') {
    ownedWeapons.pistol = 'usp';
    pistolWeaponIndex = 1;
    weaponMag[1] = mag;
    weaponReserve[1] = reserve;
  } else {
    ownedWeapons.primary = wk;
    primaryWeaponIndex = wi;
    weaponMag[wi] = mag;
    weaponReserve[wi] = reserve;
  }

  if(wi === currentWeaponIndex) {
    ammo = weaponMag[wi];
    reserveAmmo = weaponReserve[wi];
    updateAmmoUI();
    updateWeaponSlots();
    updateWeaponSlotsUI();
    return;
  }
  switchWeapon(wi);
  updateWeaponSlotsUI();
}

function attemptPickupWorldWeaponAtCrosshair() {
  if(!camera || !scene || !worldWeaponDrops.length) return;
  _pickupFwd.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  _pickupRaycaster.set(camera.position, _pickupFwd);
  _pickupRaycaster.near = 0;
  _pickupRaycaster.far = WORLD_WEAPON_PICKUP_RAY_MAX;
  const hits = _pickupRaycaster.intersectObjects(worldWeaponDrops, true);
  if(!hits.length) return;
  const hitGroup = findWorldWeaponDropGroupFromObject(hits[0].object);
  if(!hitGroup) return;
  const dx = camera.position.x - hitGroup.position.x;
  const dz = camera.position.z - hitGroup.position.z;
  if(Math.hypot(dx, dz) > WORLD_WEAPON_PICKUP_HORIZ_MAX) return;
  tryApplyWorldWeaponPickup(hitGroup);
}

function updateWeaponSlots() {
  document.querySelectorAll('.weapon-slot').forEach((el, i) => {
    el.classList.remove('active');
    el.style.display = 'none';
    
    // Slot 1: Primary weapon
    if (i === 0 && ownedWeapons.primary) {
      el.style.display = 'flex';
      const w = WEAPONS[ownedWeapons.primary === 'ak' ? 0 : 2];
      el.innerHTML = '<span class="slot-num">1</span>' + (w?.slotLabel || w?.label || w?.name || 'N/A');
      if (i === currentWeaponIndex) el.classList.add('active');
    }
    // Slot 2: Pistol
    else if (i === 1 && ownedWeapons.pistol) {
      el.style.display = 'flex';
      const w = WEAPONS[1]; // USP
      el.innerHTML = '<span class="slot-num">2</span>' + (w?.slotLabel || w?.label || w?.name || 'N/A');
      if (i === currentWeaponIndex) el.classList.add('active');
    }
    // Slot 3: Knife (always available)
    else if (i === 2) {
      el.style.display = 'flex';
      el.innerHTML = '<span class="slot-num">3</span>🔪';
      if (i === currentWeaponIndex) el.classList.add('active');
    }
  });
}

function getRecoilPatternDelta(w, shotIndex) {
  const list = RECOIL_PATTERNS[w.patternId];
  if(!list || !list.length) {
    return { x: (Math.random() - 0.5) * 0.004, y: 0.014 };
  }
  const p = list[Math.min(shotIndex, list.length - 1)];
  const rng = w.patternRng != null ? w.patternRng : 0.001;
  return {
    x: p.x + (Math.random() - 0.5) * rng,
    y: p.y + (Math.random() - 0.5) * rng
  };
}

function getTotalInaccuracyRad(w, shotIndex, moving, scoped, crouching) {
  let a = scoped && w.inaccuracyScoped != null ? w.inaccuracyScoped : w.inaccuracyStand;
  if(moving) a += w.inaccuracyMove;
  if(crouching) {
    const cm = w.inaccuracyCrouchMult != null ? w.inaccuracyCrouchMult : 0.5;
    a *= cm;
  }
  const sc = Math.max(0, shotIndex);
  a += sc * (w.inaccuracySpray || 0) + sc * sc * 0.00004;
  return Math.min(a, w.inaccuracyMax != null ? w.inaccuracyMax : 0.06);
}

/** CS:GO 伤害距离衰减：Damage × range_modifier^(距离/射程)，距离与射程均为 Source 单位（1m≈39.37） */
const CS_SU_PER_METER = 39.3700787;
function weaponDamageFalloffFactor(w, distMeters) {
  const rangeSU = w.rangeSU != null ? w.rangeSU : 500;
  const rm = w.rangeModifier != null ? w.rangeModifier : 0.98;
  const distSU = Math.max(0, distMeters * CS_SU_PER_METER);
  return Math.pow(rm, distSU / rangeSU);
}

function weaponMoveSpeedRatio(w) {
  if(w.maxSpeedU != null) return w.maxSpeedU / 250;
  return 0.86;
}

/** CS:GO 无甲：胸部伤害 = damage×衰减；腿/臂≈0.75×；头≈4×（步枪/多数手枪/大狙） */
function computeWeaponHitDamage(w, bodyPart, distMeters) {
  const falloff = weaponDamageFalloffFactor(w, distMeters);
  const effBase = w.damage * falloff;
  if(w.type === 'melee') {
    return Math.max(0, Math.floor(effBase));
  }
  if(bodyPart === 'head') {
    const hm = w.headMult != null ? w.headMult : 4;
    return Math.max(0, Math.floor(effBase * hm));
  }
  if(bodyPart === 'torso') {
    const cm = w.dmgChestMult != null ? w.dmgChestMult : 1;
    return Math.max(0, Math.floor(effBase * cm));
  }
  const lm = w.dmgLimbMult != null ? w.dmgLimbMult : 0.75;
  return Math.max(0, Math.floor(effBase * lm));
}

/** 木质穿透后伤害保留：穿深越高保留略多（参考 CS 穿墙衰减量级） */
function woodPenetrationDamageMult(w) {
  const pen = w.penetration != null ? w.penetration : 1;
  return Math.min(0.52, 0.22 + Math.min(3.5, pen) * 0.075);
}

function applyDirectionInaccuracy(fwd, right, up, maxRad) {
  const r = maxRad * Math.sqrt(Math.random());
  const theta = Math.random() * Math.PI * 2;
  const out = fwd.clone();
  out.addScaledVector(right, Math.cos(theta) * r);
  out.addScaledVector(up, Math.sin(theta) * r);
  return out.normalize();
}

function shoot() {
  if(!canShoot || isReloading || GAME.paused) return;
  const w = currentWeapon();
  if(w.type === 'melee') return; // Melee handled separately
  
  const now = performance.now();
  if(now - lastShotTime < w.fireRate) return;
  if(w.type === 'sniper' && awpBoltAnimRemaining > 0) return;

  if(ammo <= 0) {
    if(now - lastDryFireTime < 350) return;
    lastDryFireTime = now;
    playDryFireSound();
    return;
  }

  lastShotTime = now;
  ammo--;
  weaponMag[currentWeaponIndex] = ammo;
  updateAmmoUI();
  notifySpawnProtectGunfireToServer();

  if(now - lastSprayAt > SPRAY_RESET_MS) sprayConsecutive = 0;
  sprayConsecutive++;
  lastSprayAt = now;

  const idx = sprayConsecutive - 1;
  const dRec = getRecoilPatternDelta(w, idx);
  const awpScoped = w.type === 'sniper' && awpScopeStage > 0;
  if(!awpScoped) {
    recoilOffset.y += dRec.y;
    recoilOffset.x += dRec.x;
  }

  const sc = awpScoped ? 0.3 : 1;
  const isRifle = w.type === 'rifle';
  // 步枪：view 以上身后坐（+Z）为主，削弱「枪口上跳」式 pitch/y 位移
  const pitchKick = isRifle ? 0.26 : 1;
  const yawKick = isRifle ? 0.45 : 1;
  const yBump = isRifle ? 0.28 : 1;
  vmPunch.pitch += (dRec.y * 14 + w.vmKickY * 0.18) * sc * pitchKick;
  vmPunch.yaw += dRec.x * 12 * sc * yawKick;
  vmPunch.roll += dRec.x * -0.0065 * sc * (isRifle ? 0.45 : 1);
  vmPunch.x += dRec.x * 0.0048 * sc * (isRifle ? 0.55 : 1);
  vmPunch.y += w.vmKickY * 0.012 * sc * yBump;
  vmPunch.z += w.vmKickZ * (isRifle ? 0.11 : 0.09) * sc;
  const maxBack = w.vmRecoilBackMax != null ? w.vmRecoilBackMax : 0.1;
  const sprayIdx = Math.max(0, idx);
  let backAdd = sc * (0.0036 + dRec.y * 2.35 + Math.min(sprayIdx, 38) * 0.00052 + w.vmKickZ * 0.055);
  if(isRifle) backAdd *= 1.22;
  vmRecoilBackZ = Math.min(maxBack, vmRecoilBackZ + backAdd);

  playShootSound(w.type);
  if(w.type === 'sniper') {
    awpBoltAnimRemaining = w.fireRate / 1000;
    playSniperBoltSounds();
  }
  createMuzzleFlash();
  if(awpScoped) { awpScopeStage = 0; doubleZoomBlend = 0; }

  const moving = moveForward || moveBackward || moveLeft || moveRight;
  let fwd;
  let right;
  let up;
  let inacc = 0;

  if(awpScoped) {
    const aimEuler = new THREE.Euler(pitch, yaw, 0, 'YXZ');
    const aimQuat = new THREE.Quaternion().setFromEuler(aimEuler);
    fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(aimQuat);
    right = new THREE.Vector3(1, 0, 0).applyQuaternion(aimQuat);
    up = new THREE.Vector3(0, 1, 0).applyQuaternion(aimQuat);
    if(moving) {
      inacc = w.inaccuracyMove * 0.92;
      fwd = applyDirectionInaccuracy(fwd, right, up, inacc);
    }
  } else {
    const shotEuler = new THREE.Euler(pitch + recoilOffset.y, yaw + recoilOffset.x, 0, 'YXZ');
    const shotQuat = new THREE.Quaternion().setFromEuler(shotEuler);
    fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(shotQuat);
    right = new THREE.Vector3(1, 0, 0).applyQuaternion(shotQuat);
    up = new THREE.Vector3(0, 1, 0).applyQuaternion(shotQuat);
    inacc = getTotalInaccuracyRad(w, idx, moving, false, isCrouching);
    fwd = applyDirectionInaccuracy(fwd, right, up, inacc);
  }

  const eye = camera.position.clone();
  let rayOrigin = eye;
  let rayDir = fwd.clone();
  if(thirdPerson) {
    const tp = getThirdPersonShootRay(eye, fwd, camera.quaternion);
    rayOrigin = tp.origin;
    rayDir = tp.direction;
  }
  const raycaster = new THREE.Raycaster(rayOrigin.clone(), rayDir.clone(), 0, 100);

  // First check wall hits to determine max bullet range（程序盒体 + GLB BVH 取最近）
  const wallMeshes = mapObjects.filter(o=>o.box).map(o=>o.mesh);
  const wallHits = raycaster.intersectObjects(wallMeshes);
  const bvhWallHit = mapBVHCollisionMesh ? Dust2Map.raycastMapFirst(raycaster, mapBVHCollisionMesh) : null;
  let maxBulletDist = 100;
  let hitWall = null;
  let hitWallObj = null;
  const candidates = [];
  if(wallHits.length > 0) candidates.push({ h: wallHits[0], box: true });
  if(bvhWallHit) candidates.push({ h: bvhWallHit, box: false });
  candidates.sort((a, b) => a.h.distance - b.h.distance);
  if(candidates.length > 0) {
    const first = candidates[0];
    const wh = first.h;
    hitWallObj = first.box
      ? mapObjects.find(o => o.mesh === wh.object)
      : mapObjects.find(o => o.mapBVH);
    if(hitWallObj && hitWallObj.materialType === 'wood') {
      hitWall = wh;
    } else {
      maxBulletDist = wh.distance;
      hitWall = wh;
    }
  }

  // Check enemy hits (only within maxBulletDist)
  let hitEnemy = null;
  let hitRemoteSocketId = null;
  let hitBodyPart = 'torso';
  let minDist = Infinity;
  let throughWood = false;
  enemies.forEach(enemy => {
    if(enemy.dead) return;
    if(!shouldTreatEnemyAsHostile(enemy)) return;
    const intersects = raycaster.intersectObjects(enemy.group.children, true);
    let chosen = null;
    for(const ih of intersects) {
      if(ih.distance > maxBulletDist) break;
      if(ih.object.userData && ih.object.userData.meleeHeadHitbox) continue;
      chosen = ih;
      break;
    }
    if(chosen && chosen.distance < minDist) {
      minDist = chosen.distance;
      hitEnemy = enemy;
      hitRemoteSocketId = null;
      const obj = chosen.object;
      hitBodyPart = (obj.userData && obj.userData.bodyPart) || 'torso';
      throughWood = !!(hitWall && hitWallObj && hitWallObj.materialType === 'wood' && chosen.distance > hitWall.distance);
    }
  });

  remotePlayerMap.forEach((entry, socketId) => {
    if(entry.dead) return;
    if(!shouldTreatRemotePlayerAsHostile(socketId)) return;
    const intersects = raycaster.intersectObjects(entry.group.children, true);
    let chosen = null;
    for(const ih of intersects) {
      if(ih.distance > maxBulletDist) break;
      if(ih.object.userData && ih.object.userData.meleeHeadHitbox) continue;
      if(ih.object.userData && ih.object.userData.skipMeleeRaycast) continue;
      if(ih.object.userData && ih.object.userData.skipBulletRaycast) continue;
      if(ih.object.userData && ih.object.userData.mpCorpseNoHit) continue;
      chosen = ih;
      break;
    }
    if(chosen && chosen.distance < minDist) {
      minDist = chosen.distance;
      hitEnemy = null;
      hitRemoteSocketId = socketId;
      const obj = chosen.object;
      hitBodyPart = (obj.userData && obj.userData.bodyPart) || 'torso';
      throughWood = !!(hitWall && hitWallObj && hitWallObj.materialType === 'wood' && chosen.distance > hitWall.distance);
    }
  });

  if(hitRemoteSocketId) {
    const rent = remotePlayerMap.get(hitRemoteSocketId);
    const protHit = isRemoteSpawnProtectedEntry(rent);
    if(!protHit) {
      let dmg, isHeadshot = false;
      dmg = computeWeaponHitDamage(w, hitBodyPart, minDist);
      if(hitBodyPart === 'head') isHeadshot = true;
      if(throughWood) {
        dmg = Math.floor(dmg * woodPenetrationDamageMult(w));
        isHeadshot = false;
      }
      showHitmarker(isHeadshot);
      showDamageNumber(isHeadshot ? '爆头' : dmg, isHeadshot);
      postMultiplayerGunHit(hitRemoteSocketId, w.name, hitBodyPart, minDist, throughWood);

      const hitPoint = raycaster.ray.at(minDist, new THREE.Vector3());
      if(isHeadshot) {
        createHeadshotImpactEffect(hitPoint);
      } else {
        createImpactParticles(hitPoint, 0xff4444);
      }

      if(throughWood && hitWall) {
        createImpactParticles(hitWall.point, 0x8a6a35);
        playSFX('wood_impact', 0.4);
        const wm = hitWallObj && hitWallObj.materialType ? hitWallObj.materialType : 'wood';
        createBulletDecal(hitWall, wm, fwd);
      }
    }
  } else if(hitEnemy) {
    let dmg, isHeadshot = false;
    dmg = computeWeaponHitDamage(w, hitBodyPart, minDist);
    if(hitBodyPart === 'head') isHeadshot = true;
    if(throughWood) {
      dmg = Math.floor(dmg * woodPenetrationDamageMult(w));
      isHeadshot = false;
    }
    hitEnemy.health -= dmg;
    showHitmarker(isHeadshot);
    showDamageNumber(isHeadshot ? '爆头' : dmg, isHeadshot);

    const hitPoint = raycaster.ray.at(minDist, new THREE.Vector3());
    if(isHeadshot) {
      createHeadshotImpactEffect(hitPoint);
    } else {
      createImpactParticles(hitPoint, 0xff4444);
    }

    if(hitEnemy.health <= 0) {
      killEnemy(hitEnemy, isHeadshot, fwd);
    } else {
      hitEnemy.state = 'chase'; // alert enemy
      hitEnemy.hitAlertTimer = 5; // knows player position for 5 seconds even through walls
      hitEnemy.alertTimer = hitEnemy.alertThreshold; // immediately ready to fire back
    }

    // Also show wood impact if bullet went through wood
    if(throughWood && hitWall) {
      createImpactParticles(hitWall.point, 0x8a6a35);
      playSFX('wood_impact', 0.4);
      const wm = hitWallObj && hitWallObj.materialType ? hitWallObj.materialType : 'wood';
      createBulletDecal(hitWall, wm, fwd);
    }
  } else {
    // Bullet hit wall (no enemy hit)
    if(hitWall) {
      createImpactParticles(hitWall.point, 0xffaa44);
      const wm = hitWallObj && hitWallObj.materialType ? hitWallObj.materialType : 'stone';
      createBulletDecal(hitWall, wm, fwd);
      // Play material-specific impact sound
      if(hitWallObj) {
        if(hitWallObj.materialType === 'wood') playSFX('wood_impact', 0.4);
        else if(hitWallObj.materialType === 'metal') playSFX('metal_impact', 0.4);
        else playSFX('bullet_impact', 0.3);
      }
    }
  }

  if(!w.auto) {
    canShoot = false;
    setTimeout(() => { canShoot = true; }, w.fireRate);
  }

  crosshairSpread = Math.min(4 + sprayConsecutive * 0.95 + (moving ? 5 : 0) + inacc * 420, 30);

  let traceLen = 100;
  if((hitEnemy || hitRemoteSocketId) && minDist < Infinity) traceLen = minDist;
  else if(hitWall) traceLen = Math.min(hitWall.distance, 100);
  const muzzleOff = 0.42;
  const traceFrom = thirdPerson
    ? eye.clone().add(rayDir.clone().multiplyScalar(muzzleOff))
    : eye.clone().add(fwd.clone().multiplyScalar(muzzleOff));
  const traceTo = traceFrom.clone().add(rayDir.clone().multiplyScalar(traceLen));
  createPlayerTracer(traceFrom, traceTo, w);
}

function stopReloadSound() {
  if(reloadSfxSource) {
    try { reloadSfxSource.stop(0); } catch(e) {}
    reloadSfxSource = null;
  }
}

function cancelReload() {
  if(reloadTimeoutId) {
    clearTimeout(reloadTimeoutId);
    reloadTimeoutId = null;
  }
  stopReloadSound();
  isReloading = false;
  canShoot = true;
  reloadStartTime = 0;
  vmReloadRot = 0;
  hideReloadCrosshair();
}

function startReload() {
  if(isReloading) return;
  const w = currentWeapon();
  if(ammo === w.magSize || reserveAmmo <= 0) return;

  if(w.type === 'sniper') {
    awpScopeStage = 0;
    doubleZoomBlend = 0;
    awpBoltAnimRemaining = 0;
  }

  reloadWeaponSlot = currentWeaponIndex;
  reloadStartTime = performance.now();
  reloadDurationMs = w.reloadTime;
  isReloading = true;
  canShoot = false;

  showReloadCrosshair(w.reloadTime);

  playReloadSound();

  if(reloadTimeoutId) clearTimeout(reloadTimeoutId);
  reloadTimeoutId = setTimeout(() => {
    reloadTimeoutId = null;
    if(!GAME.running) return;
    const wi = reloadWeaponSlot;
    const ww = WEAPONS[wi];
    let am = weaponMag[wi];
    let res = weaponReserve[wi];
    if(am >= ww.magSize || res <= 0) {
      isReloading = false;
      canShoot = true;
      reloadStartTime = 0;
      hideReloadCrosshair();
      return;
    }
    const needed = ww.magSize - am;
    const available = Math.min(needed, res);
    weaponMag[wi] += available;
    weaponReserve[wi] -= available;
    isReloading = false;
    canShoot = true;
    reloadStartTime = 0;
    hideReloadCrosshair();
    if(currentWeaponIndex === wi) {
      ammo = weaponMag[wi];
      reserveAmmo = weaponReserve[wi];
      updateAmmoUI();
    }
  }, w.reloadTime);
}

function killEnemy(enemy, isHeadshot, bulletDir) {
  if(enemy.dead) return;
  enemy.dead = true;
  enemy.visualPhase = 'dying';
  enemy.deathAnimT = 0;
  enemy.deathAnimDuration = 0.72;
  enemy._deathBaseY = enemy.group.position.y;
  enemy._feetGroundY = getFeetSurfaceY(
    enemy.group.position.x, enemy.group.position.z, 0.42, enemy.group.position.y + 22, enemy.group.position.y
  );
  enemy.group.visible = true;
  /** 倒地朝向：沿水平面「子弹飞来方向的反方向」倒下（local +Z 对齐该方向后 pitch） */
  let ry = enemy.group.rotation.y;
  if(bulletDir && bulletDir.lengthSq() > 1e-8) {
    const fall = new THREE.Vector3(-bulletDir.x, 0, -bulletDir.z);
    if(fall.lengthSq() > 1e-8) {
      fall.normalize();
      ry = Math.atan2(fall.x, fall.z);
    }
  }
  enemy._deathRotY = ry;
  enemy.group.rotation.y = ry;
  enemy.alertTimer = 0;
  enemy.burstCount = 0;
  enemy.burstCooldown = 0;
  GAME.kills++;
  if(isHeadshot) GAME.headshots++;
  GAME.score += enemy.cfg.score + (isHeadshot ? 50 : 0);
  updateScoreUI();
  updateKillCounter(isHeadshot);
  showKillFeed(enemy.cfg.name, isHeadshot);

  if(scene) {
    if(enemy.dropWeaponGroup) {
      scene.remove(enemy.dropWeaponGroup);
      removeWorldWeaponDropFromList(enemy.dropWeaponGroup);
      enemy.dropWeaponGroup = null;
    }
    const botWeaponKey = enemy.type === 'elite' ? 'awp' : 'ak';
    const bwi = weaponKeyToWeaponIndex(botWeaponKey);
    const bww = WEAPONS[bwi];
    const feetPos = new THREE.Vector3(
      enemy.group.position.x,
      enemy._feetGroundY != null ? enemy._feetGroundY : enemy.group.position.y,
      enemy.group.position.z
    );
    enemy.dropWeaponGroup = spawnWorldWeaponDrop(feetPos, ry, {
      weaponKey: botWeaponKey,
      mag: bww.magSize,
      reserve: bww.reserve,
    });
  }
}

// ============================================================
// BULLET HOLES（墙面弹痕，参考 CS：贴花 + 数量上限 + 超时淡出）
// ============================================================
function getBulletHoleTexture(materialType) {
  if(bulletHoleTextureCache[materialType]) return bulletHoleTextureCache[materialType];
  const c = document.createElement('canvas');
  const S = 256;
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d');
  const cx = S / 2;
  const cy = S / 2;
  let rimR = 42;
  let rimG = 42;
  let rimB = 46;
  if(materialType === 'wood') { rimR = 88; rimG = 62; rimB = 42; }
  else if(materialType === 'metal') { rimR = 48; rimG = 52; rimB = 58; }
  ctx.clearRect(0, 0, S, S);
  const grd = ctx.createRadialGradient(cx, cy, 3, cx, cy, 62);
  grd.addColorStop(0, 'rgba(4,4,6,0.99)');
  grd.addColorStop(0.18, 'rgba(14,14,18,0.94)');
  grd.addColorStop(0.4, `rgba(${rimR},${rimG},${rimB},0.62)`);
  grd.addColorStop(0.68, `rgba(${rimR + 28},${rimG + 24},${rimB + 18},0.28)`);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((Math.random() - 0.5) * 0.45);
  ctx.scale(1, 0.9 + Math.random() * 0.1);
  ctx.beginPath();
  ctx.ellipse(0, 0, 58 + Math.random() * 5, 55 + Math.random() * 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgba(2,2,4,0.99)';
  ctx.beginPath();
  ctx.arc(cx + (Math.random() - 0.5) * 5, cy + (Math.random() - 0.5) * 5, 10 + Math.random() * 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(${Math.min(255, rimR + 36)},${Math.min(255, rimG + 32)},${Math.min(255, rimB + 28)},0.42)`;
  ctx.lineWidth = 1.8;
  for(let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + Math.random() * 0.35;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 14, cy + Math.sin(a) * 14);
    ctx.lineTo(cx + Math.cos(a) * (28 + Math.random() * 10), cy + Math.sin(a) * (28 + Math.random() * 10));
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  bulletHoleTextureCache[materialType] = tex;
  return tex;
}

/** 细长刀痕：中间深、边缘碎裂、带擦痕高光；贴图竖直方向为刀刃划迹走向，由 mesh 对齐到挥砍方向 */
function getKnifeSlashTexture(materialType) {
  const key = materialType || 'stone';
  if(knifeSlashTextureCache[key]) return knifeSlashTextureCache[key];
  const c = document.createElement('canvas');
  const W = 160;
  const H = 496;
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  let baseR = 22;
  let baseG = 20;
  let baseB = 18;
  let hiR = 62;
  let hiG = 58;
  let hiB = 52;
  if(key === 'wood') {
    baseR = 48; baseG = 32; baseB = 18;
    hiR = 92; hiG = 72; hiB = 48;
  } else if(key === 'metal') {
    baseR = 28; baseG = 32; baseB = 38;
    hiR = 72; hiG = 78; hiB = 88;
  }
  const cx = W * 0.5;
  const cy = H * 0.5;
  const jitter = (i, s) => Math.sin(i * 3.17 + s * 12.9898) * 4.2 + Math.sin(i * 7.23 + s * 4.1) * 2.1;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalCompositeOperation = 'source-over';

  for(let layer = 0; layer < 4; layer++) {
    const lw = 16 - layer * 3.2;
    const a = 0.52 - layer * 0.1;
    ctx.beginPath();
    const n = 48;
    for(let i = 0; i <= n; i++) {
      const t = i / n;
      const y = (t - 0.5) * H * 0.92;
      const x = jitter(i * 0.7, layer + 1) + Math.sin(t * Math.PI * 6 + layer * 0.4) * (2.5 + layer);
      if(i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(${baseR + layer * 5},${baseG + layer * 4},${baseB + layer * 3},${a})`;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  ctx.globalCompositeOperation = 'lighter';
  for(let k = 0; k < 5; k++) {
    const ox = (Math.sin(k * 2.1) * 3.5);
    ctx.beginPath();
    const n = 36;
    for(let i = 0; i <= n; i++) {
      const t = i / n;
      const y = (t - 0.5) * H * 0.78 + (k - 2) * 2;
      const x = ox + Math.sin(t * Math.PI * 5 + k) * 1.8;
      if(i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(${hiR},${hiG},${hiB},${0.14 + k * 0.02})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  ctx.restore();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalCompositeOperation = 'destination-out';
  for(let e = 0; e < 18; e++) {
    const ty = (e / 17 - 0.5) * H * 0.94;
    const w = 10 + (e % 5) * 2;
    ctx.fillStyle = `rgba(0,0,0,${0.04 + (e % 3) * 0.03})`;
    ctx.fillRect(-w * 0.5 + Math.sin(e * 1.7) * 3, ty - 2, w, 4);
  }
  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  knifeSlashTextureCache[key] = tex;
  return tex;
}

function createBulletDecal(intersect, materialType, bulletDir) {
  if(!intersect || !bulletDir || !bulletDecalsGroup) return;
  const obj = intersect.object;
  let n;
  if(intersect.face && intersect.face.normal) {
    n = intersect.face.normal.clone();
    n.transformDirection(obj.matrixWorld).normalize();
  } else {
    n = bulletDir.clone().multiplyScalar(-1).normalize();
  }
  if(n.dot(bulletDir) > 0) n.negate();

  const pos = intersect.point.clone().addScaledVector(n, 0.012);
  const base = new THREE.Vector3(0, 0, 1);
  const quat = new THREE.Quaternion().setFromUnitVectors(base, n);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.36 + Math.random() * 0.1, 0.36 + Math.random() * 0.1),
    new THREE.MeshBasicMaterial({
      map: getBulletHoleTexture(materialType || 'stone'),
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide
    })
  );
  mesh.position.copy(pos);
  mesh.quaternion.copy(quat);
  mesh.rotateOnAxis(new THREE.Vector3(0, 0, 1), Math.random() * Math.PI * 2);

  if(bulletDecals.length >= MAX_BULLET_DECALS) {
    const old = bulletDecals.shift();
    bulletDecalsGroup.remove(old.mesh);
    old.mesh.geometry.dispose();
    old.mesh.material.dispose();
  }
  bulletDecals.push({ mesh, life: BULLET_DECAL_LIFE });
  bulletDecalsGroup.add(mesh);
}

function clearBulletDecals() {
  if(!bulletDecalsGroup) return;
  while(bulletDecals.length) {
    const d = bulletDecals.pop();
    bulletDecalsGroup.remove(d.mesh);
    d.mesh.geometry.dispose();
    d.mesh.material.dispose();
  }
}

function updateBulletDecals(dt) {
  if(!bulletDecals.length) return;
  for(let i = bulletDecals.length - 1; i >= 0; i--) {
    const d = bulletDecals[i];
    d.life -= dt;
    if(d.life <= 0) {
      bulletDecalsGroup.remove(d.mesh);
      d.mesh.geometry.dispose();
      d.mesh.material.dispose();
      bulletDecals.splice(i, 1);
      continue;
    }
    if(d.life < BULLET_DECAL_FADE) {
      d.mesh.material.opacity = Math.max(0, (d.life / BULLET_DECAL_FADE) * 0.94);
    }
  }
}

// ============================================================
// PARTICLE SYSTEM
// ============================================================
function createImpactParticles(position, color) {
  for(let i=0; i<6; i++) {
    const geo = new THREE.SphereGeometry(0.03, 4, 4);
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position);
    scene.add(mesh);
    particles.push({
      mesh,
      velocity: new THREE.Vector3((Math.random()-0.5)*4, Math.random()*3, (Math.random()-0.5)*4),
      life: 0.5 + Math.random()*0.3,
    });
  }
}

/** 爆头：击中点周围蓝白细环（无光源；略向相机偏移避免被模型遮挡 / z-fighting） */
function createHeadshotImpactEffect(position) {
  const basePos = position.clone();
  const toCam = new THREE.Vector3().subVectors(camera.position, basePos);
  if(toCam.lengthSq() > 1e-8) toCam.normalize();
  else toCam.set(0, 0, 1);
  basePos.addScaledVector(toCam, 0.028);

  const ringGroup = new THREE.Group();
  ringGroup.position.copy(basePos);
  ringGroup.lookAt(camera.position);

  const innerR = 0.018, outerR = 0.048;
  const ringGeo = new THREE.RingGeometry(innerR, outerR, 40);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xa8dfff, transparent: true, opacity: 0.92, depthWrite: false, depthTest: true,
    side: THREE.DoubleSide, blending: THREE.NormalBlending,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });
  const ringMain = new THREE.Mesh(ringGeo, ringMat);
  ringMain.renderOrder = 120;
  ringGroup.add(ringMain);

  const rimGeo = new THREE.RingGeometry(outerR * 0.92, outerR * 1.08, 32);
  const rimMat = new THREE.MeshBasicMaterial({
    color: 0xe8f6ff, transparent: true, opacity: 0.45, depthWrite: false, depthTest: true,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });
  const ringRim = new THREE.Mesh(rimGeo, rimMat);
  ringRim.renderOrder = 121;
  ringGroup.add(ringRim);

  scene.add(ringGroup);
  headshotFx.push({ group: ringGroup, basePos: basePos.clone(), life: 0.26, maxLife: 0.26 });
}

function updateHeadshotFx(dt) {
  for(let i = headshotFx.length - 1; i >= 0; i--) {
    const fx = headshotFx[i];
    fx.life -= dt;
    const k = Math.max(0, fx.life / fx.maxLife);
    if(fx.group && fx.basePos) {
      fx.group.position.copy(fx.basePos);
      fx.group.lookAt(camera.position);
      const t = 1 - k;
      const s = 0.92 + t * 0.12;
      fx.group.scale.setScalar(s);
      fx.group.children.forEach((ch, idx) => {
        if(!ch.material) return;
        ch.material.opacity = (idx === 0 ? 0.92 : 0.45) * k;
      });
    }
    if(fx.life <= 0) {
      if(fx.group) {
        scene.remove(fx.group);
        fx.group.traverse(obj => {
          if(obj.geometry) obj.geometry.dispose();
          if(obj.material) obj.material.dispose();
        });
      }
      headshotFx.splice(i, 1);
    }
  }
}

function clearHeadshotFx() {
  while(headshotFx.length) {
    const fx = headshotFx.pop();
    if(fx.group) {
      if(fx.group.parent) scene.remove(fx.group);
      fx.group.traverse(obj => {
        if(obj.geometry) obj.geometry.dispose();
        if(obj.material) obj.material.dispose();
      });
    }
  }
}

function createMuzzleFlash() {
  const geo = new THREE.SphereGeometry(0.035, 5, 5);
  const mat = new THREE.MeshBasicMaterial({ color:0xff9933, transparent:true, opacity:0.38, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  const forward = new THREE.Vector3(0.2, -0.15, -0.8);
  forward.applyQuaternion(camera.quaternion);
  mesh.position.copy(camera.position).add(forward);
  scene.add(mesh);
  muzzleFlashes.push({ mesh, life: 0.035 });
}

function disposeTracerMesh(mesh) {
  if(!mesh) return;
  if(mesh.isGroup) {
    mesh.traverse(obj => {
      if(obj.geometry) obj.geometry.dispose();
      if(obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(m => { if(m && m.dispose) m.dispose(); });
      }
    });
  } else {
    if(mesh.geometry) mesh.geometry.dispose();
    if(mesh.material) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach(m => { if(m && m.dispose) m.dispose(); });
    }
  }
}

function applyTracerGroupOpacity(group, opacityBase) {
  const k = Math.max(0, Math.min(1, opacityBase));
  group.traverse(obj => {
    if(!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach(m => {
      if(m && m.userData.tracerOp != null) m.opacity = k * m.userData.tracerOp;
    });
  });
}

function clearPlayerTracers() {
  while(playerTracers.length) {
    const t = playerTracers.pop();
    if(t.mesh && t.mesh.parent) scene.remove(t.mesh);
    disposeTracerMesh(t.mesh);
  }
}

const BULLET_VISUAL_SCALE = 0.5;

function buildTracerMeshCylinder(dir, w) {
  const bv = BULLET_VISUAL_SCALE;
  let tipR = 0.00062 * bv, baseR = 0.00158 * bv, bLen = 0.021 * bv;
  let outerCol = 0xc67a2e;
  let innerCol = 0xffecd4;
  if(w && w.type === 'pistol') {
    tipR = 0.0005 * bv; baseR = 0.00128 * bv; bLen = 0.015 * bv;
    outerCol = 0xb8894a;
    innerCol = 0xfff0dd;
  } else if(w && w.type === 'sniper') {
    tipR = 0.00072 * bv; baseR = 0.00185 * bv; bLen = 0.03 * bv;
    outerCol = 0xa85c28;
    innerCol = 0xfff8f0;
  }
  const group = new THREE.Group();
  const outer = new THREE.Mesh(
    new THREE.CylinderGeometry(tipR, baseR, bLen, 18, 1),
    new THREE.MeshBasicMaterial({ color: outerCol, transparent: true, opacity: 0.78, depthWrite: false })
  );
  outer.userData.tracerOp = 0.78;
  const inner = new THREE.Mesh(
    new THREE.CylinderGeometry(tipR * 0.45, baseR * 0.46, bLen * 0.96, 14, 1),
    new THREE.MeshBasicMaterial({ color: innerCol, transparent: true, opacity: 0.96, depthWrite: false })
  );
  inner.userData.tracerOp = 0.96;
  group.add(outer);
  group.add(inner);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  return { group, bLen };
}

function buildTracerMeshEnemyCylinder(dir) {
  const bv = BULLET_VISUAL_SCALE;
  const tipR = 0.00058 * bv, baseR = 0.00148 * bv, bLen = 0.02 * bv;
  const group = new THREE.Group();
  const outer = new THREE.Mesh(
    new THREE.CylinderGeometry(tipR, baseR, bLen, 16, 1),
    new THREE.MeshBasicMaterial({ color: 0xc45a2a, transparent: true, opacity: 0.8, depthWrite: false })
  );
  outer.userData.tracerOp = 0.8;
  const inner = new THREE.Mesh(
    new THREE.CylinderGeometry(tipR * 0.44, baseR * 0.45, bLen * 0.96, 12, 1),
    new THREE.MeshBasicMaterial({ color: 0xffe8c8, transparent: true, opacity: 0.95, depthWrite: false })
  );
  inner.userData.tracerOp = 0.95;
  group.add(outer);
  group.add(inner);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  return { group, bLen };
}

/** 曳光弹：双层圆柱（轻量，无 glTF） */
function spawnBulletTracer(from, to, speed, minDist, weapon) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const dist = dir.length();
  if(dist < minDist) return;
  dir.normalize();
  let group;
  let bLen;
  if(weapon) {
    const built = buildTracerMeshCylinder(dir, weapon);
    group = built.group;
    bLen = built.bLen;
  } else {
    const built = buildTracerMeshEnemyCylinder(dir);
    group = built.group;
    bLen = built.bLen;
  }
  const tip = from.clone().addScaledVector(dir, Math.min(bLen * 0.5, dist * 0.5));
  group.position.copy(tip).addScaledVector(dir, -bLen * 0.48);
  scene.add(group);
  playerTracers.push({
    mesh: group,
    from: from.clone(),
    to: to.clone(),
    dir: dir.clone(),
    dist,
    traveled: 0,
    speed,
    bLen,
    life: dist / speed + 0.12,
    fade0: dist / speed
  });
}

function createPlayerTracer(from, to, w) {
  const spd = w.bulletSpeed != null ? w.bulletSpeed : 300;
  spawnBulletTracer(from, to, spd, 0.06, w);
}

function createBulletTracer(from, to) {
  spawnBulletTracer(from, to, 268, 0.5, null);
}

function updateParticles(dt) {
  for(let i = particles.length-1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if(p.life <= 0) {
      scene.remove(p.mesh);
      particles.splice(i,1);
      continue;
    }
    p.velocity.y -= 9.8 * dt;
    p.mesh.position.add(p.velocity.clone().multiplyScalar(dt));
    p.mesh.material.opacity = p.life * 2;
  }

  for(let i = muzzleFlashes.length-1; i >= 0; i--) {
    const m = muzzleFlashes[i];
    m.life -= dt;
    if(m.life <= 0) {
      scene.remove(m.mesh);
      m.mesh.geometry.dispose();
      m.mesh.material.dispose();
      muzzleFlashes.splice(i,1);
    }
  }

  for(let i = playerTracers.length - 1; i >= 0; i--) {
    const t = playerTracers[i];
    t.life -= dt;
    if(t.traveled != null && t.speed != null) {
      t.traveled += t.speed * dt;
      const hit = t.traveled >= t.dist;
      const tipD = Math.min(t.traveled, t.dist);
      const tip = t.from.clone().addScaledVector(t.dir, tipD);
      t.mesh.position.copy(tip).addScaledVector(t.dir, -t.bLen * 0.48);
      if(hit || t.life <= 0) {
        scene.remove(t.mesh);
        disposeTracerMesh(t.mesh);
        playerTracers.splice(i, 1);
        continue;
      }
      const ft = t.fade0 > 0 ? Math.min(1, t.traveled / (t.fade0 * 0.35)) : 0;
      const op = Math.max(0.15, 0.94 - ft * 0.35);
      if(t.mesh.isGroup) applyTracerGroupOpacity(t.mesh, op);
      else if(t.mesh.material) t.mesh.material.opacity = op;
    } else {
      if(t.life <= 0) {
        scene.remove(t.mesh);
        disposeTracerMesh(t.mesh);
        playerTracers.splice(i, 1);
        continue;
      }
      const op = Math.max(0, Math.min(1, t.life * 16));
      if(t.mesh.isGroup) applyTracerGroupOpacity(t.mesh, op);
      else if(t.mesh.material) t.mesh.material.opacity = op;
    }
  }

  updateBulletDecals(dt);
}

// ============================================================
// AUDIO SYSTEM (File-based with Web Audio API)
// ============================================================
const SFX = {}; // loaded audio buffers
const SFX_FILES = {
  rifle_shot:    'assets/sounds/rifle_shot.wav',
  pistol_shot:   'assets/sounds/pistol_shot.wav',
  sniper_shot:   'assets/sounds/awp_shoot.mp3',
  reload_rifle:  'assets/sounds/reload_rifle.wav',
  reload_pistol: 'assets/sounds/reload_pistol.wav',
  headshot_ding:  'assets/sounds/headshot_ding.ogg',
  bullet_impact: 'assets/sounds/bullet_impact.ogg',
  metal_impact:  'assets/sounds/metal_impact.ogg',
  wood_impact:   'assets/sounds/wood_impact.ogg',
  footstep_0:    'assets/sounds/footstep_concrete_000.ogg',
  footstep_1:    'assets/sounds/footstep_concrete_001.ogg',
  footstep_2:    'assets/sounds/footstep_concrete_002.ogg',
  footstep_3:    'assets/sounds/footstep_concrete_003.ogg',
  footstep_4:    'assets/sounds/footstep_concrete_004.ogg',
};

async function initAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // Load all sound files in parallel
  const entries = Object.entries(SFX_FILES);
  await Promise.all(entries.map(async ([key, url]) => {
    try {
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      SFX[key] = await audioCtx.decodeAudioData(buf);
    } catch(e) {
      console.warn('Failed to load sound:', key, e);
    }
  }));
  console.log('Audio loaded:', Object.keys(SFX).length, 'sounds');
}

function playSFX(name, volume, playbackRate) {
  if(!audioCtx || !SFX[name]) return;
  const source = audioCtx.createBufferSource();
  source.buffer = SFX[name];
  if(playbackRate) source.playbackRate.value = playbackRate;
  const gain = audioCtx.createGain();
  gain.gain.value = volume || 1.0;
  source.connect(gain);
  gain.connect(audioCtx.destination);
  source.start(0);
}

function playProceduralScopeToggle(opening) {
  if(!audioCtx) return;
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(opening ? 2600 : 1700, t0);
  osc.frequency.exponentialRampToValueAtTime(opening ? 950 : 720, t0 + 0.04);
  gain.gain.setValueAtTime(0.075, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.07);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.075);
}

function playScopeToggleSFX(opening) {
  if(SFX['metal_impact']) playSFX('metal_impact', opening ? 0.26 : 0.19, opening ? 1.18 : 0.88);
  else playProceduralScopeToggle(opening);
}


function playProceduralBoltClick(freq) {
  if(!audioCtx) return;
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq || 820;
  gain.gain.setValueAtTime(0.055, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.038);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.042);
}

/** 空膛击发：金属撞击或程序化短促咔嗒 */
function playDryFireSound() {
  if(!audioCtx) return;
  if(SFX['metal_impact']) {
    playSFX('metal_impact', 0.24, 1.42);
    return;
  }
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(1800, t0);
  osc.frequency.exponentialRampToValueAtTime(520, t0 + 0.028);
  gain.gain.setValueAtTime(0.068, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.055);
}

function playSniperBoltSounds() {
  if(SFX['metal_impact']) {
    setTimeout(() => playSFX('metal_impact', 0.24, 1.22), 108);
    setTimeout(() => playSFX('metal_impact', 0.2, 0.9), 255);
  } else {
    setTimeout(() => playProceduralBoltClick(920), 108);
    setTimeout(() => playProceduralBoltClick(680), 255);
  }
}

function playProceduralSniperShot() {
  if(!audioCtx) return;
  const t0 = audioCtx.currentTime;
  const dur = 0.2;
  const n = Math.floor(audioCtx.sampleRate * dur);
  const buffer = audioCtx.createBuffer(1, n, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for(let i = 0; i < n; i++) {
    const t = i / audioCtx.sampleRate;
    const env = Math.exp(-t * 14);
    data[i] = (Math.random() * 2 - 1) * env * 0.42;
  }
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  const filt = audioCtx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 3200;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.52;
  src.connect(filt);
  filt.connect(gain);
  gain.connect(audioCtx.destination);
  src.start(t0);
}

/** 每帧同步 Web Audio 听者与相机（耳朵位置 + 朝向），供 PannerNode 计算方位与距离衰减 */
function syncAudioListenerFromCamera() {
  if(!audioCtx || !camera) return;
  const l = audioCtx.listener;
  const p = camera.position;
  if(l.positionX) {
    l.positionX.value = p.x;
    l.positionY.value = p.y;
    l.positionZ.value = p.z;
  } else if(l.setPosition) {
    l.setPosition(p.x, p.y, p.z);
  }
  camera.getWorldDirection(_audioListenerFwd);
  const fx = _audioListenerFwd.x, fy = _audioListenerFwd.y, fz = _audioListenerFwd.z;
  if(l.forwardX) {
    l.forwardX.value = fx;
    l.forwardY.value = fy;
    l.forwardZ.value = fz;
    l.upX.value = 0;
    l.upY.value = 1;
    l.upZ.value = 0;
  } else if(l.setOrientation) {
    l.setOrientation(fx, fy, fz, 0, 1, 0);
  }
}

/** 自身脚步：不经过 Panner（脚与耳同朝向，仅略偏下），避免 HRTF 竖直方向怪异 */
function playFootstepSFXLocal(name, gainMul, playbackRate) {
  if(!audioCtx || !SFX[name]) return;
  const source = audioCtx.createBufferSource();
  source.buffer = SFX[name];
  if(playbackRate) source.playbackRate.value = playbackRate;
  const lowpass = audioCtx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 5200;
  lowpass.Q.value = 0.7;
  const gain = audioCtx.createGain();
  gain.gain.value = gainMul == null ? 1 : gainMul;
  source.connect(lowpass);
  lowpass.connect(gain);
  gain.connect(audioCtx.destination);
  source.start(0);
}

/**
 * 空间化脚步声：世界坐标 + HRTF 方向 + 距离衰减；gainMul 为 refDistance 附近的基准响度
 */
function playFootstepSFXSpatial(name, gainMul, playbackRate, wx, wy, wz, pannerOpts) {
  if(!audioCtx || !SFX[name]) return;
  const source = audioCtx.createBufferSource();
  source.buffer = SFX[name];
  if(playbackRate) source.playbackRate.value = playbackRate;
  const lowpass = audioCtx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 5200;
  lowpass.Q.value = 0.7;
  const gain = audioCtx.createGain();
  gain.gain.value = gainMul == null ? 1 : gainMul;
  const panner = audioCtx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = (pannerOpts && pannerOpts.distanceModel) ? pannerOpts.distanceModel : 'inverse';
  panner.refDistance = (pannerOpts && pannerOpts.refDistance != null) ? pannerOpts.refDistance : 2.2;
  panner.maxDistance = (pannerOpts && pannerOpts.maxDistance != null) ? pannerOpts.maxDistance : 56;
  panner.rolloffFactor = (pannerOpts && pannerOpts.rolloffFactor != null) ? pannerOpts.rolloffFactor : 1.15;
  panner.coneInnerAngle = 360;
  panner.coneOuterAngle = 360;
  if(panner.positionX) {
    panner.positionX.value = wx;
    panner.positionY.value = wy;
    panner.positionZ.value = wz;
  } else if(panner.setPosition) {
    panner.setPosition(wx, wy, wz);
  }
  source.connect(lowpass);
  lowpass.connect(gain);
  gain.connect(panner);
  panner.connect(audioCtx.destination);
  source.start(0);
}

function playShootSound(type) {
  if(type === 'rifle') {
    playSFX('rifle_shot', 0.5, 0.9 + Math.random()*0.2);
  } else if(type === 'pistol') {
    playSFX('pistol_shot', 0.5, 0.9 + Math.random()*0.2);
  } else {
    if(SFX['sniper_shot']) playSFX('sniper_shot', 0.6, 0.9 + Math.random()*0.2);
    else playProceduralSniperShot();
  }
}

function playEnemyShootSound(distance) {
  // Use rifle sound at lower volume + higher pitch for distance
  const vol = Math.max(0.05, 0.4 - distance * 0.015);
  playSFX('rifle_shot', vol, 1.1 + Math.random()*0.2);
}

function playReloadSound() {
  stopReloadSound();
  const w = currentWeapon();
  if(!audioCtx) return;
  let name, vol, rate;
  if(w.type === 'pistol') {
    name = 'reload_pistol';
    vol = 0.6;
  } else if(w.type === 'sniper') {
    if(!SFX['reload_rifle']) return;
    name = 'reload_rifle';
    vol = 0.55;
    rate = 0.94;
  } else {
    name = 'reload_rifle';
    vol = 0.6;
  }
  if(!SFX[name]) return;
  const source = audioCtx.createBufferSource();
  source.buffer = SFX[name];
  if(rate != null) source.playbackRate.value = rate;
  const gain = audioCtx.createGain();
  gain.gain.value = vol;
  source.connect(gain);
  gain.connect(audioCtx.destination);
  reloadSfxSource = source;
  source.onended = () => { if(reloadSfxSource === source) reloadSfxSource = null; };
  source.start(0);
}

function playHitSound() {
  playSFX('bullet_impact', 0.5, 0.8 + Math.random()*0.4);
}

function playHeadshotSound() {
  playSFX('headshot_ding', 0.7);
  playSFX('bullet_impact', 0.4, 0.6);
}

function playFootstepSound(quiet) {
  const idx = Math.floor(Math.random() * 5);
  const mul = quiet ? 0.08 : 0.26;
  playFootstepSFXLocal('footstep_' + idx, mul, 0.92 + Math.random() * 0.14);
}

const ENEMY_FOOTSTEP_MAX_DIST = 10;

function playEnemyFootstepSound(wx, wy, wz) {
  const dx = wx - camera.position.x;
  const dy = wy - camera.position.y;
  const dz = wz - camera.position.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if(dist > ENEMY_FOOTSTEP_MAX_DIST) return;
  const idx = Math.floor(Math.random() * 5);
  playFootstepSFXSpatial(
    'footstep_' + idx,
    0.42,
    0.9 + Math.random() * 0.12,
    wx,
    wy + 0.06,
    wz,
    {
      distanceModel: 'linear',
      refDistance: 1,
      maxDistance: ENEMY_FOOTSTEP_MAX_DIST,
      rolloffFactor: 1
    }
  );
}

// ============================================================
// HUD FUNCTIONS
// ============================================================
let crosshairSpread = 4;

const CH_RELOAD_R = 26;
const CH_RELOAD_C = 2 * Math.PI * CH_RELOAD_R;

function drawCrosshair() {
  const ch = document.getElementById('crosshair');
  ch.innerHTML = `<svg id="crosshair-svg" width="80" height="80" viewBox="0 0 80 80">
    <g id="ch-normal">
      <line class="ch-line" id="ch-t" x1="40" y1="10" x2="40" y2="22" stroke="rgba(255,255,255,0.9)" stroke-width="1.5"/>
      <line class="ch-line" id="ch-b" x1="40" y1="58" x2="40" y2="46" stroke="rgba(255,255,255,0.9)" stroke-width="1.5"/>
      <line class="ch-line" id="ch-l" x1="10" y1="40" x2="22" y2="40" stroke="rgba(255,255,255,0.9)" stroke-width="1.5"/>
      <line class="ch-line" id="ch-r" x1="70" y1="40" x2="58" y2="40" stroke="rgba(255,255,255,0.9)" stroke-width="1.5"/>
      <circle cx="40" cy="40" r="1.5" fill="rgba(255,255,255,0.6)"/>
    </g>
    <g id="ch-reload" style="display:none">
      <circle cx="40" cy="40" r="${CH_RELOAD_R}" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="3"/>
      <circle id="ch-reload-ring" cx="40" cy="40" r="${CH_RELOAD_R}" fill="none" stroke="var(--hud-orange)" stroke-width="3" stroke-linecap="round"
        transform="rotate(-90 40 40)" stroke-dasharray="${CH_RELOAD_C}" stroke-dashoffset="${CH_RELOAD_C}"/>
      <text x="40" y="44" text-anchor="middle" fill="rgba(255,255,255,0.92)" font-family="Rajdhani,sans-serif" font-size="12" font-weight="600">换弹</text>
    </g>
  </svg>`;
}

function showReloadCrosshair(durationMs) {
  const norm = document.getElementById('ch-normal');
  const rel = document.getElementById('ch-reload');
  const ring = document.getElementById('ch-reload-ring');
  if(!norm || !rel || !ring) return;
  norm.style.display = 'none';
  rel.style.display = 'block';
  ring.style.transition = 'none';
  ring.setAttribute('stroke-dashoffset', String(CH_RELOAD_C));
  void ring.getBoundingClientRect();
  ring.style.transition = `stroke-dashoffset ${durationMs}ms linear`;
  requestAnimationFrame(() => { ring.setAttribute('stroke-dashoffset', '0'); });
}

function hideReloadCrosshair() {
  const norm = document.getElementById('ch-normal');
  const rel = document.getElementById('ch-reload');
  const ring = document.getElementById('ch-reload-ring');
  if(norm) norm.style.display = 'block';
  if(rel) rel.style.display = 'none';
  if(ring) {
    ring.style.transition = 'none';
    ring.setAttribute('stroke-dashoffset', String(CH_RELOAD_C));
  }
}

function updateCrosshair() {
  if(isReloading) return;
  crosshairSpread = Math.max(4, crosshairSpread - 0.3);
  const s = crosshairSpread;
  const ch = document.getElementById('crosshair');
  if(!ch.querySelector('#ch-t')) return;
  ch.querySelector('#ch-t').setAttribute('y1', 40-8-s);
  ch.querySelector('#ch-t').setAttribute('y2', 40-s);
  ch.querySelector('#ch-b').setAttribute('y1', 40+s);
  ch.querySelector('#ch-b').setAttribute('y2', 40+8+s);
  ch.querySelector('#ch-l').setAttribute('x1', 40-8-s);
  ch.querySelector('#ch-l').setAttribute('x2', 40-s);
  ch.querySelector('#ch-r').setAttribute('x1', 40+s);
  ch.querySelector('#ch-r').setAttribute('x2', 40+8+s);
}

function showHitmarker(isHeadshot) {
  if(isHeadshot) {
    playHeadshotSound();
  } else {
    playHitSound();
  }
  const hm = document.getElementById('hitmarker');
  if(isHeadshot) {
    hm.innerHTML = `<svg width="28" height="28" viewBox="0 0 28 28">
      <line x1="2" y1="2" x2="10" y2="10" stroke="#00B0FF" stroke-width="3" filter="url(#hsb)"/>
      <line x1="26" y1="2" x2="18" y2="10" stroke="#00B0FF" stroke-width="3"/>
      <line x1="2" y1="26" x2="10" y2="18" stroke="#00B0FF" stroke-width="3"/>
      <line x1="26" y1="26" x2="18" y2="18" stroke="#00B0FF" stroke-width="3"/>
      <circle cx="14" cy="14" r="3" fill="none" stroke="#66D9FF" stroke-width="2"/>
      <defs><filter id="hsb" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    </svg>`;
  } else {
    hm.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20">
      <line x1="3" y1="3" x2="8" y2="8" stroke="#fff" stroke-width="2"/>
      <line x1="17" y1="3" x2="12" y2="8" stroke="#fff" stroke-width="2"/>
      <line x1="3" y1="17" x2="8" y2="12" stroke="#fff" stroke-width="2"/>
      <line x1="17" y1="17" x2="12" y2="12" stroke="#fff" stroke-width="2"/>
    </svg>`;
  }
  hm.style.opacity = 1;
  setTimeout(() => { hm.style.opacity = 0; }, isHeadshot ? 300 : 150);
}

function showDamageNumber(dmg, isCrit) {
  const el = document.createElement('div');
  el.className = 'dmg-number' + (isCrit ? ' crit' : '');
  el.textContent = isCrit ? '💀 爆头' : ('-' + dmg);
  el.style.left = (window.innerWidth/2 + (Math.random()-0.5)*60) + 'px';
  el.style.top = (window.innerHeight/2 - 30 + (Math.random()-0.5)*30) + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 800);
}

function showKillFeed(enemyName, isHeadshot) {
  const feed = document.getElementById('kill-feed');
  const msg = document.createElement('div');
  msg.className = 'kill-msg';
  const hsText = isHeadshot ? ' <span style="color:var(--hud-yellow)">[爆头]</span>' : '';
  msg.innerHTML = `<span style="color:var(--hud-blue)">你</span> 击杀了 <span style="color:var(--hud-red)">${enemyName}</span>${hsText}`;
  feed.appendChild(msg);
  setTimeout(() => msg.remove(), 3000);
}

function updateHealthUI() {
  const pct = Math.max(0, GAME.health / GAME.maxHealth * 100);
  document.getElementById('health-bar-fill').style.width = pct + '%';
  document.getElementById('health-text').innerHTML = Math.ceil(GAME.health) + '<span>/100</span>';

  // Color change at low health
  const fill = document.getElementById('health-bar-fill');
  if(pct < 30) fill.style.background = 'linear-gradient(90deg,#ff0000,#ff3333)';
  else if(pct < 60) fill.style.background = 'linear-gradient(90deg,#ff6600,#ff8844)';
  else fill.style.background = 'linear-gradient(90deg,#ff1744,#ff4444)';
}

function updateScoreUI() {
  document.getElementById('score-value').textContent = GAME.kills;
}

function updateKillCounter(isHeadshot) {
  const icons = document.querySelectorAll('.kill-icon');
  const currentKills = GAME.kills;
  
  icons.forEach((icon, i) => {
    if(i < currentKills % 10) {
      if(i === (currentKills - 1) % 10 && isHeadshot) {
        icon.className = 'kill-icon headshot';
      } else {
        icon.className = 'kill-icon kill';
      }
    } else {
      icon.className = 'kill-icon';
    }
  });
  
  document.getElementById('headshot-count').textContent = '爆头: ' + GAME.headshots;
  document.getElementById('total-kills').textContent = '击杀: ' + GAME.kills;
}

function showDamageOverlay() {
  const overlay = document.getElementById('damage-overlay');
  overlay.style.background = 'radial-gradient(ellipse at center, transparent 40%, rgba(255,0,0,0.4) 100%)';
  overlay.style.opacity = 1;
  setTimeout(() => { overlay.style.opacity = 0; }, 200);
}

// ============================================================
// MINIMAP
// ============================================================
/** 自场景俯视渲染的底图（优先于静态 SVG） */
let minimapWorldCanvas = null;
let minimapWorldCaptureQueued = false;

let minimapThumbImg = null;
let minimapThumbReadyUrl = '';
let minimapThumbInFlightUrl = '';
let minimapThumbLoadFailedUrl = '';

const MINIMAP_WORLD_RT_SIZE = 512;

function pushMinimapSceneVisibilityStash() {
  const stash = [];
  const hide = (o) => {
    if(!o) return;
    stash.push({ o, v: o.visible });
    o.visible = false;
  };
  hide(bulletDecalsGroup);
  hide(thirdPersonWeaponRoot);
  if(GAME.dustPoints) hide(GAME.dustPoints);
  let i;
  for(i = 0; i < enemies.length; i++) hide(enemies[i].group);
  remotePlayerMap.forEach((e) => {
    hide(e.group);
    hide(e.weaponSceneRoot);
    hide(e.dropWeaponGroup);
  });
  for(i = 0; i < worldWeaponDrops.length; i++) hide(worldWeaponDrops[i]);
  for(i = 0; i < particles.length; i++) hide(particles[i].mesh);
  for(i = 0; i < muzzleFlashes.length; i++) hide(muzzleFlashes[i].mesh);
  for(i = 0; i < playerTracers.length; i++) hide(playerTracers[i].mesh);
  for(i = 0; i < headshotFx.length; i++) hide(headshotFx[i].group);
  if(scene) {
    scene.traverse((ch) => {
      /** 远端克隆曾复制 isLocalPlayerAvatar，勿当作本地模型隐藏，否则对方人物会消失 */
      if(ch.userData && ch.userData.isLocalPlayerAvatar && !ch.userData.isRemotePlayerAvatar) hide(ch);
    });
  }
  return function restoreMinimapSceneVisibility() {
    for(i = 0; i < stash.length; i++) stash[i].o.visible = stash[i].v;
  };
}

function scheduleMinimapWorldCapture() {
  if(minimapWorldCanvas || minimapWorldCaptureQueued) return;
  if(!renderer || !scene) return;
  minimapWorldCaptureQueued = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      minimapWorldCaptureQueued = false;
      tryCaptureMinimapFromWorld();
    });
  });
}

function tryCaptureMinimapFromWorld() {
  if(minimapWorldCanvas || !renderer || !scene || !(mapHalfBound > 0)) return;
  const SIZE = MINIMAP_WORLD_RT_SIZE;
  const h = mapHalfBound;
  const rt = new THREE.WebGLRenderTarget(SIZE, SIZE, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  const orthoCam = new THREE.OrthographicCamera(-h, h, h, -h, Math.max(0.5, h * 0.12), h * 24);
  orthoCam.position.set(0, h * 6, 0);
  orthoCam.lookAt(0, 0, 0);
  orthoCam.updateProjectionMatrix();

  const restoreVis = pushMinimapSceneVisibilityStash();
  const prevFog = scene.fog;
  const prevBg = scene.background;
  scene.fog = null;
  scene.background = new THREE.Color(0x1e1c1a);

  const prevTarget = renderer.getRenderTarget();
  const prevV = new THREE.Vector4();
  renderer.getViewport(prevV);
  const prevShadow = renderer.shadowMap.enabled;

  try {
    renderer.shadowMap.enabled = false;
    renderer.setRenderTarget(rt);
    renderer.setViewport(0, 0, SIZE, SIZE);
    renderer.clear(true, true, true);
    renderer.render(scene, orthoCam);
  } catch(err) {
    console.warn('[minimap] 俯视渲染失败', err);
    rt.dispose();
    scene.fog = prevFog;
    scene.background = prevBg;
    restoreVis();
    renderer.setRenderTarget(prevTarget);
    renderer.setViewport(prevV.x, prevV.y, prevV.z, prevV.w);
    renderer.shadowMap.enabled = prevShadow;
    return;
  }

  renderer.setRenderTarget(prevTarget);
  renderer.setViewport(prevV.x, prevV.y, prevV.z, prevV.w);
  renderer.shadowMap.enabled = prevShadow;

  scene.fog = prevFog;
  scene.background = prevBg;
  restoreVis();

  try {
    const pixels = new Uint8Array(SIZE * SIZE * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, pixels);
    const out = document.createElement('canvas');
    out.width = SIZE;
    out.height = SIZE;
    const octx = out.getContext('2d');
    const imgData = octx.createImageData(SIZE, SIZE);
    let x;
    let y;
    for(y = 0; y < SIZE; y++) {
      for(x = 0; x < SIZE; x++) {
        const srcI = (y * SIZE + x) * 4;
        const dstI = ((SIZE - 1 - y) * SIZE + x) * 4;
        imgData.data[dstI] = pixels[srcI];
        imgData.data[dstI + 1] = pixels[srcI + 1];
        imgData.data[dstI + 2] = pixels[srcI + 2];
        imgData.data[dstI + 3] = pixels[srcI + 3];
      }
    }
    octx.putImageData(imgData, 0, 0);
    minimapWorldCanvas = out;
  } catch(err) {
    console.warn('[minimap] 读取渲染目标失败', err);
  }
  rt.dispose();
}

function getActiveMapKeyForMinimap() {
  if(multiplayerData && multiplayerData.settings && multiplayerData.settings.map)
    return String(multiplayerData.settings.map);
  return GAME.useDust2GlbMap ? 'desert' : 'warehouse';
}

function minimapThumbUrlForMapKey(mapKey) {
  return mapKey === 'warehouse' ? 'assets/maps/minimap_warehouse.svg' : 'assets/maps/minimap_desert.svg';
}

function ensureMinimapThumbLoaded() {
  if(minimapWorldCanvas) return;
  const url = minimapThumbUrlForMapKey(getActiveMapKeyForMinimap());
  if(minimapThumbLoadFailedUrl === url) return;
  if(minimapThumbReadyUrl === url && minimapThumbImg && minimapThumbImg.complete && minimapThumbImg.naturalWidth > 0) return;
  if(minimapThumbInFlightUrl === url) return;
  minimapThumbInFlightUrl = url;
  const im = new Image();
  im.onload = () => {
    if(minimapThumbInFlightUrl === url) {
      minimapThumbImg = im;
      minimapThumbReadyUrl = url;
      minimapThumbLoadFailedUrl = '';
    }
    minimapThumbInFlightUrl = '';
  };
  im.onerror = () => {
    if(minimapThumbInFlightUrl === url) {
      minimapThumbImg = null;
      minimapThumbReadyUrl = '';
      minimapThumbLoadFailedUrl = url;
    }
    minimapThumbInFlightUrl = '';
  };
  im.src = url;
}

function updateMinimapLabelForMap() {
  const el = document.getElementById('minimap-label');
  if(!el) return;
  const key = getActiveMapKeyForMinimap();
  el.textContent = key === 'warehouse' ? '仓库突袭' : '沙漠2';
}

function isPvp1v1OpponentRevealOnMinimapActive() {
  if(!isMultiplayer1v1RoomMode() || !isPvpMultiplayerRoom()) return false;
  if(pvpMatchEnded) return false;
  if(!GAME.running || GAME.paused) return false;
  /** 加时：独立时间轴，每 10s 亮 1s（与顶栏「加时」显示一致，与常规 30s/3s 分开） */
  if(pvp1v1OvertimeActive) {
    if(pvp1v1OvertimeRevealEpochMs <= 0) return false;
    const ot = performance.now() - pvp1v1OvertimeRevealEpochMs;
    if(!Number.isFinite(ot) || ot < 0) return false;
    const ph = ot % PVP_1V1_OT_REVEAL_EVERY_MS;
    return ph < PVP_1V1_OT_REVEAL_FOR_MS;
  }
  if(pvp1v1MinimapRevealEpochMs <= 0) return false;
  const t = performance.now() - pvp1v1MinimapRevealEpochMs;
  if(!Number.isFinite(t) || t < 0) return false;
  const phase = t % PVP_1V1_MINIMAP_REVEAL_EVERY_MS;
  return phase < PVP_1V1_MINIMAP_REVEAL_FOR_MS;
}

function drawPvp1v1OvertimeOpponentBlip(ctx, scale) {
  const localSid = multiplayerData && multiplayerData.localSocketId;
  remotePlayerMap.forEach((entry, socketId) => {
    if(localSid && socketId === localSid) return;
    if(entry.dead) return;
    const ox = (entry.curPos.x + mapHalfBound) * scale;
    const oz = (entry.curPos.z + mapHalfBound) * scale;
    ctx.fillStyle = 'rgba(255, 60, 60, 0.95)';
    ctx.beginPath();
    ctx.arc(ox, oz, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1.25;
    ctx.stroke();
  });
}

function updateMinimap() {
  const canvas = document.getElementById('minimap-canvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const mapExtent = mapHalfBound * 2;
  const scale = w / mapExtent;

  ctx.clearRect(0, 0, w, h);

  if(minimapWorldCanvas) {
    ctx.drawImage(minimapWorldCanvas, 0, 0, w, h);
    ctx.fillStyle = 'rgba(8, 10, 18, 0.32)';
    ctx.fillRect(0, 0, w, h);
  } else if(minimapThumbImg && minimapThumbImg.complete && minimapThumbImg.naturalWidth > 0) {
    ctx.drawImage(minimapThumbImg, 0, 0, w, h);
    ctx.fillStyle = 'rgba(8, 10, 18, 0.42)';
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.fillStyle = 'rgba(10,10,15,0.8)';
    ctx.fillRect(0, 0, w, h);
  }

  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  mapObjects.forEach(obj => {
    if(!obj.box) return;
    const b = obj.box;
    const mx = (b.min.x + mapHalfBound) * scale;
    const mz = (b.min.z + mapHalfBound) * scale;
    const mw = (b.max.x - b.min.x) * scale;
    const mh = (b.max.z - b.min.z) * scale;
    ctx.fillRect(mx, mz, Math.max(mw, 1), Math.max(mh, 1));
  });

  enemies.forEach(enemy => {
    if(enemy.dead) return;
    const ex = (enemy.group.position.x + mapHalfBound) * scale;
    const ez = (enemy.group.position.z + mapHalfBound) * scale;
    const hostile = shouldTreatEnemyAsHostile(enemy);
    ctx.fillStyle = hostile
      ? (enemy.type === 'elite' ? '#ff6600' : '#ff3333')
      : '#44aaff';
    ctx.beginPath();
    ctx.arc(ex, ez, 3, 0, Math.PI*2);
    ctx.fill();
  });

  const px = (camera.position.x + mapHalfBound) * scale;
  const pz = (camera.position.z + mapHalfBound) * scale;

  if(isPvp1v1OpponentRevealOnMinimapActive()) {
    drawPvp1v1OvertimeOpponentBlip(ctx, scale);
  }

  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px, pz);
  const dirLen = 10;
  ctx.lineTo(px - Math.sin(yaw)*dirLen, pz - Math.cos(yaw)*dirLen);
  ctx.stroke();

  ctx.fillStyle = '#00ff88';
  ctx.beginPath();
  ctx.arc(px, pz, 3, 0, Math.PI*2);
  ctx.fill();
}

// ============================================================
// PLAYER PHYSICS & COLLISION
// ============================================================
/**
 * 程序地图：AABB 挤出。
 * GLB：仅对「明显陷入网格内部」做小幅分步挤出（大 pad + 单步位移上限），避免台沿假穿透抖动，又减少穿矮墙。
 */
function resolvePlayerWallPenetration() {
  if(mapUseBVHCollision && mapBVHCollisionMesh) {
    const pr = GAME.playerRadius;
    const pad = GAME.dust2ResolvePenetrationPad != null ? GAME.dust2ResolvePenetrationPad : 0.11;
    const maxPush = GAME.dust2ResolvePenetrationMaxPush != null ? GAME.dust2ResolvePenetrationMaxPush : 0.034;
    /**
     * 仅「几乎贴地飘落」时弱化挤出，减轻地面接缝与水平位移对冲；贴竖箱/竖墙时仍用满强度，避免贴模卡死。
     */
    const slowFallSkim =
      !onGround && velocity.y > -0.55 && velocity.y < 0.05;
    const airScale = slowFallSkim
      ? (GAME.dust2ResolvePenetrationPushScaleAir != null ? GAME.dust2ResolvePenetrationPushScaleAir : 0.45)
      : 1;
    const yc = camera.position.y - GAME.playerHeight * 0.48;
    const iterations = slowFallSkim ? 3 : 5;
    for(let k = 0; k < iterations; k++) {
      Dust2Map.resolvePenetrationXZ(mapBVHCollisionMesh, camera.position, pr, yc, pad, {
        maxPushPerStep: maxPush * airScale,
        pushScale: airScale,
      });
    }
    return;
  }
  const pr = GAME.playerRadius;
  const pad = 0.035;
  for(let k = 0; k < 8; k++) {
    const feetY = camera.position.y - GAME.playerHeight;
    const cx = camera.position.x;
    const cz = camera.position.z;
    const ymin = feetY + 0.04;
    const ymax = camera.position.y + 0.16;
    let fixed = false;
    for(let i = 0; i < mapObjects.length; i++) {
      const obj = mapObjects[i];
      if(!obj.box) continue;
      const b = obj.box;
      if(cx + pr <= b.min.x || cx - pr >= b.max.x || cz + pr <= b.min.z || cz - pr >= b.max.z) continue;
      if(ymax <= b.min.y || ymin >= b.max.y) continue;
      const penL = (cx + pr) - b.min.x;
      const penR = b.max.x - (cx - pr);
      const penF = (cz + pr) - b.min.z;
      const penB = b.max.z - (cz - pr);
      const m = Math.min(penL, penR, penF, penB);
      if(m === penL) camera.position.x -= penL + pad;
      else if(m === penR) camera.position.x += penR + pad;
      else if(m === penF) camera.position.z -= penF + pad;
      else camera.position.z += penB + pad;
      fixed = true;
      break;
    }
    if(!fixed) break;
  }
}

/** CS:GO 思路：持刀 250 为基准 → 各枪 max speed 比例；静步/下蹲再乘约 1/3；开镜狙再 ×0.5（100/200） */
const CS_MOVE_WALK_MULT = 0.34;
const CS_MOVE_CROUCH_MULT = 0.34;
const CS_MOVE_SCOPED_SNIPER_MULT = 0.5;

function getPlayerMoveSpeed() {
  const w = currentWeapon();
  const base = GAME.moveKnifeSpeed * weaponMoveSpeedRatio(w);
  let v = base;
  if(awpScopeStage > 0 && w.type === 'sniper') v *= CS_MOVE_SCOPED_SNIPER_MULT;
  if(isSprinting) v *= CS_MOVE_WALK_MULT;
  if(isCrouching) v *= CS_MOVE_CROUCH_MULT;
  return v;
}

function updatePlayer(dt) {
  let pendingPlayerFootstep = null;

  // 相机只跟随鼠标 pitch/yaw；后坐力不晃画面，弹道仍用 recoilOffset（见 shoot）
  const euler = new THREE.Euler(0,0,0,'YXZ');
  euler.x = pitch;
  euler.y = yaw;
  camera.quaternion.setFromEuler(euler);

  const sinceShot = lastSprayAt > 0 ? (performance.now() - lastSprayAt) : 1e9;
  // 停火后更快回到准度（CS:GO 弹道/散布恢复较快）；连射中仍略慢
  let rx = 0.985;
  let ry = 0.982;
  if(sinceShot < 85) {
    rx = 0.82;
    ry = 0.79;
  } else if(sinceShot < 220) {
    rx = 0.91;
    ry = 0.89;
  } else if(sinceShot < 420) {
    rx = 0.965;
    ry = 0.958;
  }
  recoilOffset.x *= rx;
  recoilOffset.y *= ry;
  if(Math.abs(recoilOffset.x) < 0.00012) recoilOffset.x = 0;
  if(Math.abs(recoilOffset.y) < 0.00012) recoilOffset.y = 0;

  // Movement：武器最大速 + 静步/下蹲/开镜（见 getPlayerMoveSpeed）
  const speed = getPlayerMoveSpeed();
  const direction = new THREE.Vector3();

  const forward = new THREE.Vector3(0,0,-1).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)));
  const right = new THREE.Vector3(1,0,0).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)));

  if(moveForward) direction.add(forward);
  if(moveBackward) direction.sub(forward);
  if(moveRight) direction.add(right);
  if(moveLeft) direction.sub(right);

  if(direction.length() > 0) {
    direction.normalize();
    const bobSpd = isSprinting ? 5 : 8;
    weaponBob += dt * bobSpd;

    // Player footstep sounds
    if(!GAME._lastFootstep) GAME._lastFootstep = 0;
    const footstepInterval = isSprinting ? 0.6 : 0.35;
    GAME._lastFootstep += dt;
    if(GAME._lastFootstep >= footstepInterval && onGround) {
      pendingPlayerFootstep = isSprinting; // 静步；在位移与落地结算后再播，与相机位置一致
      GAME._lastFootstep = 0;
    }
  } else {
    if(GAME._lastFootstep) GAME._lastFootstep = 0;
  }

  // Apply horizontal movement
  const moveVec = direction.multiplyScalar(speed * dt);

  const refYForFeet = mapWorldBounds
    ? Math.max(camera.position.y + 8, mapWorldBounds.max.y + 40)
    : camera.position.y + 100;
  const bvhXZHasGroundSupport = (x, z) => {
    if(!mapUseBVHCollision || !mapBVHCollisionMesh || !mapWorldBounds) return true;
    const feetProbe = camera.position.y - GAME.playerHeight;
    let fy = Dust2Map.getFeetYFromBVH(
      mapBVHCollisionMesh, x, z, GAME.playerRadius, refYForFeet, mapWorldBounds, feetProbe
    );
    if(!Number.isFinite(fy) && lastValidGroundFeetY != null && Number.isFinite(lastValidGroundFeetY)) {
      fy = Dust2Map.getFeetYFromBVH(
        mapBVHCollisionMesh, x, z, GAME.playerRadius, refYForFeet, mapWorldBounds, lastValidGroundFeetY
      );
    }
    if(!Number.isFinite(fy) || fy <= mapWorldBounds.min.y - 200) {
      /** 接缝处射线短暂落空时不挡水平尝试，竖直由重力与下一帧落地结算；避免与步高一起误判卡死 */
      return true;
    }
    /** 不在此做步高筛选：斜坡/矮墙交界处 fy 与相机高度易不一致；防走上矮箱靠落地 fy 钳制 */
    return true;
  };

  // Collision detection - use a box that starts above the surface player stands on
  const newPos = camera.position.clone().add(moveVec);
  newPos.y = camera.position.y;

  // 与墙体相交检测：程序地图用 AABB；GLB 用 BVH 水平扇区射线
  const playerHeight = GAME.playerHeight;
  const colBottom = camera.position.y - playerHeight + 0.05;
  const colTop = camera.position.y + 0.15;

  if(mapUseBVHCollision && mapBVHCollisionMesh) {
    const px0 = camera.position.x;
    const pz0 = camera.position.z;
    const feetY = camera.position.y - GAME.playerHeight;
    /** 膝上高度：挡矮墙；略低于原 0.72 层，减少只蹭地面接缝 */
    const yWallKnee = Math.min(feetY + 0.58, camera.position.y - 0.28);
    const yWallMid = camera.position.y - 0.42;
    const yWallChest = camera.position.y - 0.12;
    /**
     * 未落地且非强起跳：水平射线略放宽、去掉膝层，减少沿平面下落时接缝竖面误挡与滑移卡死。
     * 起跳初速大时仍用全套，避免空中穿矮栏。
     */
    const wallAirRelax = !onGround && velocity.y < 2.8;
    const ySamples = wallAirRelax ? [yWallMid, yWallChest] : [yWallKnee, yWallMid, yWallChest];
    const wallSec = GAME.dust2WallSectorCount != null ? GAME.dust2WallSectorCount : 14;
    const wallOpts = {
      walkableMinNy: GAME.dust2WallWalkableMinNy != null ? GAME.dust2WallWalkableMinNy : 0.44,
      rayInset: GAME.dust2WallRayInset != null ? GAME.dust2WallRayInset : 0.14,
      microGapMaxDist:
        wallAirRelax && GAME.dust2WallMicroGapAir != null
          ? GAME.dust2WallMicroGapAir
          : GAME.dust2WallMicroGapMaxDist != null
            ? GAME.dust2WallMicroGapMaxDist
            : 0.14,
      castExtra:
        wallAirRelax && GAME.dust2WallCastExtraAir != null
          ? GAME.dust2WallCastExtraAir
          : GAME.dust2WallCastExtra != null
            ? GAME.dust2WallCastExtra
            : 0.3,
    };
    const blockedFull = Dust2Map.horizontalMoveBlocked(
      mapBVHCollisionMesh, newPos.x, newPos.z, ySamples, GAME.playerRadius, wallSec, wallOpts
    );
    if(!blockedFull) {
      if(bvhXZHasGroundSupport(newPos.x, newPos.z)) {
        camera.position.x = newPos.x;
        camera.position.z = newPos.z;
      }
    } else {
      const slideX = camera.position.clone();
      slideX.x += moveVec.x;
      if(!Dust2Map.horizontalMoveBlocked(
        mapBVHCollisionMesh, slideX.x, slideX.z, ySamples, GAME.playerRadius, wallSec, wallOpts
      ) &&
        bvhXZHasGroundSupport(slideX.x, slideX.z)) {
        camera.position.x = slideX.x;
      }
      const slideZ = camera.position.clone();
      slideZ.z += moveVec.z;
      if(!Dust2Map.horizontalMoveBlocked(
        mapBVHCollisionMesh, slideZ.x, slideZ.z, ySamples, GAME.playerRadius, wallSec, wallOpts
      ) &&
        bvhXZHasGroundSupport(slideZ.x, slideZ.z)) {
        camera.position.z = slideZ.z;
      }
    }
    /**
     * 整步 + 轴滑移仍不动时：全向扇区常把「仍贴墙的切向位移」判挡（空中下滑与地面贴墙同源）。
     * ClipVelocity + 最近点回退见 dust2Map；通过条件用陷入深度不加深，而非 horizontalMoveBlocked(目标点)。
     */
    const movedXZ =
      Math.abs(camera.position.x - px0) > 1e-7 ||
      Math.abs(camera.position.z - pz0) > 1e-7;
    if(!movedXZ && moveVec.lengthSq() > 1e-14) {
      const clip = Dust2Map.clipHorizontalDeltaAlongWall(
        mapBVHCollisionMesh,
        camera.position.x,
        camera.position.z,
        moveVec.x,
        moveVec.z,
        yWallMid,
        GAME.playerRadius,
        {
          walkableMinNy: wallOpts.walkableMinNy,
          rayInset: wallOpts.rayInset,
          castExtra: wallOpts.castExtra,
          microGapMaxDist: wallOpts.microGapMaxDist,
        }
      );
      const tcx = camera.position.x + clip.dx;
      const tcz = camera.position.z + clip.dz;
      if(clip.dx * clip.dx + clip.dz * clip.dz > 1e-12) {
        const ycPen = camera.position.y - GAME.playerHeight * 0.48;
        const padPen =
          GAME.dust2ResolvePenetrationPad != null ? GAME.dust2ResolvePenetrationPad : 0.11;
        const slideSlack =
          GAME.dust2WallSlidePenetrationSlack != null ? GAME.dust2WallSlidePenetrationSlack : 0.006;
        const pen0 = Dust2Map.xzPenetrationExcess(
          mapBVHCollisionMesh,
          px0,
          pz0,
          ycPen,
          GAME.playerRadius,
          padPen
        );
        const pen1 = Dust2Map.xzPenetrationExcess(
          mapBVHCollisionMesh,
          tcx,
          tcz,
          ycPen,
          GAME.playerRadius,
          padPen
        );
        if(pen1 <= pen0 + slideSlack && bvhXZHasGroundSupport(tcx, tcz)) {
          camera.position.x = tcx;
          camera.position.z = tcz;
        }
      }
    }
  } else {
    const playerBox = new THREE.Box3(
      new THREE.Vector3(newPos.x - GAME.playerRadius, colBottom, newPos.z - GAME.playerRadius),
      new THREE.Vector3(newPos.x + GAME.playerRadius, colTop, newPos.z + GAME.playerRadius)
    );

    let collided = false;
    mapObjects.forEach(obj => {
      if(!obj.box) return;
      if(playerBox.intersectsBox(obj.box)) collided = true;
    });

    if(!collided) {
      camera.position.x = newPos.x;
      camera.position.z = newPos.z;
    } else {
      const slideX = camera.position.clone();
      slideX.x += moveVec.x;
      const boxX = new THREE.Box3(
        new THREE.Vector3(slideX.x-GAME.playerRadius, colBottom, slideX.z-GAME.playerRadius),
        new THREE.Vector3(slideX.x+GAME.playerRadius, colTop, slideX.z+GAME.playerRadius)
      );
      let colX = false;
      mapObjects.forEach(obj => { if(obj.box && boxX.intersectsBox(obj.box)) colX = true; });
      if(!colX) camera.position.x = slideX.x;

      const slideZ = camera.position.clone();
      slideZ.z += moveVec.z;
      const boxZ = new THREE.Box3(
        new THREE.Vector3(slideZ.x-GAME.playerRadius, colBottom, slideZ.z-GAME.playerRadius),
        new THREE.Vector3(slideZ.x+GAME.playerRadius, colTop, slideZ.z+GAME.playerRadius)
      );
      let colZ = false;
      mapObjects.forEach(obj => { if(obj.box && boxZ.intersectsBox(obj.box)) colZ = true; });
      if(!colZ) camera.position.z = slideZ.z;
    }
  }

  // Player-enemy collision (push player away from enemies)
  const playerCollisionRadius = 1.2;
  const preEnemyPushX = camera.position.x;
  const preEnemyPushZ = camera.position.z;
  enemies.forEach(enemy => {
    if(enemy.dead) return;
    if(!shouldTreatEnemyAsHostile(enemy)) return;
    const dx = camera.position.x - enemy.group.position.x;
    const dz = camera.position.z - enemy.group.position.z;
    const dist = Math.hypot(dx, dz);
    if(dist < playerCollisionRadius && dist > 0.01) {
      const pushX = (dx / dist) * (playerCollisionRadius - dist);
      const pushZ = (dz / dist) * (playerCollisionRadius - dist);
      camera.position.x += pushX;
      camera.position.z += pushZ;
    }
  });
  if(mapUseBVHCollision && mapBVHCollisionMesh && mapWorldBounds) {
    if(!bvhXZHasGroundSupport(camera.position.x, camera.position.z)) {
      camera.position.x = preEnemyPushX;
      camera.position.z = preEnemyPushZ;
    }
  }

  // 坠落出地图包围盒下方：与开局/重生相同逻辑选合法脚底点（防止拉回 bbox 中心仍踩空）
  if(mapUseBVHCollision && mapWorldBounds && mapBVHCollisionMesh) {
    const feet = camera.position.y - GAME.playerHeight;
    if(feet < mapWorldBounds.min.y - 2) {
      const sp = getRandomSpawnPos();
      dust2ApplySpawnCameraToWalkableGround(sp.x, sp.z);
      velocity.y = 0;
    }
  }

  // Gravity
  velocity.y += GAME.gravity * dt;
  camera.position.y += velocity.y * dt;

  // Platform/ground collision - check if player is standing on any object
  let groundY = GAME.playerHeight; // default ground level
  const playerFeetX = camera.position.x;
  const playerFeetZ = camera.position.z;
  const pr = GAME.playerRadius;

  if(mapUseBVHCollision && mapBVHCollisionMesh && mapWorldBounds) {
    const feetProbe = camera.position.y - GAME.playerHeight;
    const refY = Math.max(camera.position.y + 8, mapWorldBounds.max.y + 40);
    const feetLift = GAME.dust2SpawnFeetLift != null ? GAME.dust2SpawnFeetLift : 0.12;
    let fy = Dust2Map.getFeetYFromBVH(
      mapBVHCollisionMesh, playerFeetX, playerFeetZ, pr, refY, mapWorldBounds, feetProbe
    );
    const maxStep = GAME.dust2MaxWalkStepUp != null ? GAME.dust2MaxWalkStepUp : 0.14;
    if(Number.isFinite(fy) && velocity.y <= 0.28 && velocity.y > -0.18) {
      const curRawFeet = camera.position.y - GAME.playerHeight - feetLift;
      if(fy > curRawFeet + maxStep) {
        fy = Math.min(fy, curRawFeet + maxStep);
      }
    }
    if(Number.isFinite(fy) && fy > mapWorldBounds.min.y - 200) {
      groundY = fy + feetLift + GAME.playerHeight;
      lastValidGroundFeetY = fy;
    } else {
      groundY = -1e9;
    }
  } else {
    mapObjects.forEach(obj => {
      if(!obj.box) return;
      const b = obj.box;
      if(playerFeetX + pr > b.min.x && playerFeetX - pr < b.max.x &&
         playerFeetZ + pr > b.min.z && playerFeetZ - pr < b.max.z) {
        const surfaceY = b.max.y + GAME.playerHeight;
        const playerFeetY = camera.position.y - GAME.playerHeight;
        if(playerFeetY >= b.max.y - 0.3 && playerFeetY <= b.max.y + 0.5) {
          if(surfaceY > groundY) {
            groundY = surfaceY;
          }
        }
      }
    });
  }

  const maxStepDown =
    GAME.dust2MaxWalkStepDown != null ? GAME.dust2MaxWalkStepDown : 0.52;
  const slopeSnapMaxFallVy =
    GAME.dust2SlopeGroundSnapMaxFallVy != null
      ? GAME.dust2SlopeGroundSnapMaxFallVy
      : -1.38;
  const landSnapNearGap =
    GAME.dust2LandSnapNearGap != null ? GAME.dust2LandSnapNearGap : 0.048;
  const gapAboveGround = camera.position.y - groundY;
  /** 快落地最后一两厘米：直接贴地；宽间隙瞬移仅用于「慢下落/下坡」避免与跳跃落地抢同一分支 */
  const allowWideSlopeSnap =
    velocity.y > slopeSnapMaxFallVy ||
    gapAboveGround <= landSnapNearGap;
  if(camera.position.y <= groundY) {
    camera.position.y = groundY;
    velocity.y = 0;
    onGround = true;
  } else if(
    gapAboveGround > 0 &&
    gapAboveGround <= maxStepDown &&
    velocity.y <= 0 &&
    allowWideSlopeSnap
  ) {
    /** 下坡/沿坡滑：射线地面低于相机但间隙在一步内，贴地并清零竖直速度（否则 onGround 恒 false，无法起跳） */
    camera.position.y = groundY;
    velocity.y = 0;
    onGround = true;
  } else {
    onGround = false;
  }

  if(mapUseBVHCollision && mapBVHCollisionMesh && mapWorldBounds && onGround) {
    const feetLift = GAME.dust2SpawnFeetLift != null ? GAME.dust2SpawnFeetLift : 0.12;
    const feetProbe2 = camera.position.y - GAME.playerHeight;
    const refY2 = Math.max(camera.position.y + 8, mapWorldBounds.max.y + 40);
    let fy2 = Dust2Map.getFeetYFromBVH(
      mapBVHCollisionMesh, camera.position.x, camera.position.z, pr, refY2, mapWorldBounds, feetProbe2
    );
    const maxStep2 = GAME.dust2MaxWalkStepUp != null ? GAME.dust2MaxWalkStepUp : 0.14;
    if(Number.isFinite(fy2) && velocity.y <= 0.28 && velocity.y > -0.18) {
      const curRaw2 = camera.position.y - GAME.playerHeight - feetLift;
      if(fy2 > curRaw2 + maxStep2) {
        fy2 = Math.min(fy2, curRaw2 + maxStep2);
      }
    }
    if(Number.isFinite(fy2) && fy2 > mapWorldBounds.min.y - 200) {
      const gy2 = fy2 + feetLift + GAME.playerHeight;
      if(camera.position.y < gy2 - 0.001) {
        camera.position.y = gy2;
      }
    }
  }

  resolvePlayerWallPenetration();

  // Map bounds（GLB 用包围盒推导的 mapHalfBound）
  const bound = mapHalfBound - 1;
  camera.position.x = Math.max(-bound, Math.min(bound, camera.position.x));
  camera.position.z = Math.max(-bound, Math.min(bound, camera.position.z));

  // Auto-fire for automatic weapons
  if(isShooting && currentWeapon().auto && GAME.running && !GAME.paused) {
    shoot();
  }

  // Health regen：仅单机。联机 PVP（含 1v1）禁止自动回血，血量只随服务端命中同步，与回合/计时血量判胜一致
  if(!isPvpMultiplayerRoom() && GAME.health < GAME.maxHealth && GAME.health > 0) {
    GAME.health = Math.min(GAME.maxHealth, GAME.health + 0.5 * dt);
    updateHealthUI();
  }

  if(pendingPlayerFootstep !== null && onGround) playFootstepSound(pendingPlayerFootstep);

  syncLocalPlayerAvatar(dt, {
    camera,
    yaw,
    thirdPerson,
    moveForward,
    moveBackward,
    moveLeft,
    moveRight,
    isSprinting,
  });

  if(isLocalSpawnProtected()) {
    let cancel = moveForward || moveBackward || moveLeft || moveRight;
    if(!cancel && camera) {
      const c = camera.position;
      const dx = c.x - localSpawnProtectOrigin.x;
      const dz = c.z - localSpawnProtectOrigin.z;
      const dy = c.y - localSpawnProtectOrigin.y;
      if(Math.hypot(dx, dz) > 0.14 || Math.abs(dy) > 0.11) cancel = true;
    }
    if(cancel) localSpawnProtectUntil = 0;
  }

  tryPostMultiplayerSelfSync();
}

// ============================================================
// LINE OF SIGHT CHECK (used by enemy AI)
// ============================================================
const _losRaycaster = new THREE.Raycaster();
function hasLineOfSight(fromPos, toPos) {
  const dir = toPos.clone().sub(fromPos);
  const dist = dir.length();
  if(dist < 0.1) return true;
  dir.normalize();
  _losRaycaster.set(fromPos, dir);
  _losRaycaster.near = 0;
  _losRaycaster.far = dist;
  const wallMeshes = mapObjects.filter(o => o.box && o.mesh).map(o => o.mesh);
  const hits = _losRaycaster.intersectObjects(wallMeshes, false);
  let minWall = hits.length ? hits[0].distance : Infinity;
  if(mapBVHCollisionMesh) {
    const bh = Dust2Map.raycastMapFirst(_losRaycaster, mapBVHCollisionMesh);
    if(bh && bh.distance < minWall) minWall = bh.distance;
  }
  return minWall === Infinity || minWall >= dist - 0.3;
}

// ============================================================
// ENEMY AI UPDATE
// ============================================================
function updateEnemies(dt) {
  enemies.forEach(enemy => {
    if(enemy.dead && enemy.visualPhase === 'dying') {
      enemy.deathAnimT += dt;
      const dur = enemy.deathAnimDuration || 0.72;
      const u = Math.min(1, enemy.deathAnimT / dur);
      const e = u * (2 - u);
      if(enemy._deathRotY != null) enemy.group.rotation.y = enemy._deathRotY;
      enemy.group.rotation.x = e * (Math.PI / 2 * 0.92);
      const gy = enemy._feetGroundY != null ? enemy._feetGroundY : getFeetSurfaceY(
        enemy.group.position.x, enemy.group.position.z, 0.42, enemy.group.position.y + 22, enemy.group.position.y
      );
      enemy.group.position.y = gy;
      if(enemy.legL && enemy.legR) {
        enemy.legL.rotation.x = e * 0.65;
        enemy.legR.rotation.x = e * 0.4;
      }
      if(u >= 1) {
        enemy.visualPhase = 'corpse';
        enemy.corpseTimer = 10;
      }
      return;
    }
    if(enemy.dead && enemy.visualPhase === 'corpse') {
      if(enemy._deathRotY != null) enemy.group.rotation.y = enemy._deathRotY;
      const gy = enemy._feetGroundY != null ? enemy._feetGroundY : getFeetSurfaceY(
        enemy.group.position.x, enemy.group.position.z, 0.42, enemy.group.position.y + 22, enemy.group.position.y
      );
      enemy.group.position.y = gy;
      enemy.corpseTimer -= dt;
      if(enemy.corpseTimer <= 0) {
        enemy.group.visible = false;
        enemy.visualPhase = 'hidden';
        enemy.respawnTimer = 5;
      }
      return;
    }
    if(enemy.dead && enemy.visualPhase === 'hidden') {
      enemy.respawnTimer -= dt;
      if(enemy.respawnTimer <= 0) respawnEnemy(enemy);
      return;
    }

    const pos = enemy.group.position;
    const playerPos = camera.position.clone();
    playerPos.y = 0;
    const toPlayer = playerPos.clone().sub(pos);
    toPlayer.y = 0;
    const distToPlayer = toPlayer.length();

    // Line-of-sight check (enemy eye position to player position)
    const enemyEyePos = pos.clone();
    enemyEyePos.y = pos.y + 1.6;
    const canSeePlayer = distToPlayer < enemy.detectionRange &&
      hasLineOfSight(enemyEyePos, camera.position.clone());

    // Track if enemy was recently hit (can locate player even without LOS)
    if(!enemy.hitAlertTimer) enemy.hitAlertTimer = 0;
    enemy.hitAlertTimer = Math.max(0, enemy.hitAlertTimer - dt);
    const wasRecentlyHit = enemy.hitAlertTimer > 0;

    const playerVisible = canSeePlayer || wasRecentlyHit;
    const hostile = shouldTreatEnemyAsHostile(enemy);

    // === CS-STYLE STATE TRANSITIONS ===
    const prevState = enemy.state;

    if(hostile && playerVisible && distToPlayer < enemy.detectionRange) {
      enemy.alertTimer += dt;

      if(enemy.alertTimer >= enemy.alertThreshold && distToPlayer < enemy.attackRange) {
        // In range and alerted -> hold position and attack
        enemy.state = 'attack';
      } else if(distToPlayer > enemy.attackRange) {
        // Detected but too far -> chase to engagement range
        enemy.state = 'chase';
      } else if(enemy.alertTimer < enemy.alertThreshold) {
        // Spotted but still reacting
        enemy.state = 'chase';
      }
    } else {
      enemy.state = 'patrol';
      enemy.alertTimer = Math.max(0, enemy.alertTimer - dt * 0.5);
      enemy.holdTimer = 0;
      enemy.repositioning = false;
    }

    // Reset hold timer when entering attack state
    if(prevState !== 'attack' && enemy.state === 'attack') {
      enemy.holdTimer = 0;
      enemy.repositioning = false;
      enemy.holdDuration = 0.55 + Math.random() * 0.95;
    }

    // === CS-STYLE BEHAVIOR ===
    let moveDir = new THREE.Vector3();
    let isMoving = false;

    if(enemy.state === 'patrol') {
      // Patrol between waypoints
      const target = enemy.patrolPoints[enemy.patrolIndex];
      moveDir = target.clone().sub(pos);
      moveDir.y = 0;
      if(moveDir.length() < 0.55) {
        enemy.patrolIndex = (enemy.patrolIndex + 1) % enemy.patrolPoints.length;
      }
      isMoving = true;

    } else if(enemy.state === 'chase') {
      // Move toward player, stop at engagement distance (5m)
      const engageDistance = 5.0;
      if(distToPlayer > engageDistance) {
        moveDir = toPlayer.clone();
        isMoving = true;
      }
      // Always face player while chasing
      enemy.group.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);

    } else if(enemy.state === 'attack') {
      // CS-STYLE: Hold position, stop moving, aim and shoot
      // Occasionally reposition (short strafe) then hold again
      enemy.group.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);
      enemy.holdTimer += dt;

      if(enemy.repositioning) {
        // Doing a short reposition move
        if(enemy.repositionTarget && enemy.repositionTimer > 0) {
          const toTarget = enemy.repositionTarget.clone().sub(pos);
          toTarget.y = 0;
          if(toTarget.length() > 0.3) {
            moveDir = toTarget;
            isMoving = true;
          }
          enemy.repositionTimer -= dt;
        }
        if(enemy.repositionTimer <= 0) {
          enemy.repositioning = false;
          enemy.holdTimer = 0;
          enemy.holdDuration = 0.4 + Math.random() * 0.75;
        }
      } else if(enemy.holdTimer > enemy.holdDuration) {
        // Time to do a short reposition (CS bots peek/strafe occasionally)
        enemy.repositioning = true;
        enemy.repositionTimer = 0.38 + Math.random() * 0.42;
        // Pick a short strafe direction (perpendicular to player)
        const perpDir = new THREE.Vector3(-toPlayer.z, 0, toPlayer.x).normalize();
        const strafeDir = (Math.random() > 0.5 ? 1 : -1);
        const strafeDist = 2.0 + Math.random() * 2.8;
        enemy.repositionTarget = pos.clone().add(perpDir.multiplyScalar(strafeDir * strafeDist));
        // Keep reposition target within min distance from player
        const rpToPlayer = Math.hypot(enemy.repositionTarget.x - camera.position.x, enemy.repositionTarget.z - camera.position.z);
        if(rpToPlayer < 4) {
          const pushAway = new THREE.Vector2(
            enemy.repositionTarget.x - camera.position.x,
            enemy.repositionTarget.z - camera.position.z
          ).normalize();
          enemy.repositionTarget.x = camera.position.x + pushAway.x * 5;
          enemy.repositionTarget.z = camera.position.z + pushAway.y * 5;
        }
      }
      // else: holding position, not moving (standing still aiming)

      // Burst fire logic (only when NOT repositioning - CS bots stop to shoot)
      if(!enemy.repositioning) {
        if(enemy.burstCooldown > 0) {
          enemy.burstCooldown -= dt;
        } else if(enemy.burstCount < enemy.burstMax) {
          enemy.burstTimer -= dt;
          if(enemy.burstTimer <= 0) {
            enemyShoot(enemy, distToPlayer);
            enemy.burstCount++;
            enemy.burstTimer = enemy.burstInterval;
          }
        } else {
          enemy.burstCount = 0;
          enemy.burstCooldown = enemy.burstCooldownMax;
        }
      }
    }

    // === MOVEMENT EXECUTION ===
    if(isMoving && moveDir.length() > 0.01) {
      moveDir.normalize();
      const spd = enemy.cfg.speed * (
        enemy.state === 'chase' ? 1.38 :
          enemy.state === 'patrol' ? 1.34 :
            enemy.repositioning ? 1.62 : 1
      ) * dt;
      const newEPos = pos.clone().add(moveDir.clone().multiplyScalar(spd));

      // Map bounds（与玩家一致：GLB 加载后的 mapHalfBound，勿用固定 mapSize/2）
      const eBound = mapHalfBound - 1;
      newEPos.x = Math.max(-eBound, Math.min(eBound, newEPos.x));
      newEPos.z = Math.max(-eBound, Math.min(eBound, newEPos.z));

      // Enemy-wall collision（与墙体 AABB，禁止穿墙）
      if(enemyPositionBlocked(newEPos.x, newEPos.z, pos.y)) {
        if(!enemyPositionBlocked(newEPos.x, pos.z, pos.y)) {
          newEPos.z = pos.z;
        } else if(!enemyPositionBlocked(pos.x, newEPos.z, pos.y)) {
          newEPos.x = pos.x;
        } else {
          newEPos.x = pos.x;
          newEPos.z = pos.z;
        }
      }

      // Enemy-player collision (keep minimum distance)
      const toPlayerDist = Math.hypot(newEPos.x - camera.position.x, newEPos.z - camera.position.z);
      const minPlayerDist = 2.0;
      if(toPlayerDist < minPlayerDist) {
        const pushDir = new THREE.Vector2(newEPos.x - camera.position.x, newEPos.z - camera.position.z).normalize();
        newEPos.x = camera.position.x + pushDir.x * minPlayerDist;
        newEPos.z = camera.position.z + pushDir.y * minPlayerDist;
      }

      // Enemy-enemy collision
      const minEnemyDist = 1.2;
      enemies.forEach(other => {
        if(other === enemy || other.dead) return;
        const dx = newEPos.x - other.group.position.x;
        const dz = newEPos.z - other.group.position.z;
        const dist = Math.hypot(dx, dz);
        if(dist < minEnemyDist && dist > 0.01) {
          const push = minEnemyDist - dist;
          newEPos.x += (dx / dist) * push * 0.5;
          newEPos.z += (dz / dist) * push * 0.5;
        }
      });

      pos.x = newEPos.x;
      pos.z = newEPos.z;

      // Face movement direction (only for patrol)
      if(enemy.state === 'patrol') {
        enemy.group.rotation.y = Math.atan2(moveDir.x, moveDir.z);
      }

      // Walk animation
      enemy.walkPhase += dt * 8;
      enemy.legL.rotation.x = Math.sin(enemy.walkPhase) * 0.4;
      enemy.legR.rotation.x = Math.sin(enemy.walkPhase + Math.PI) * 0.4;

      // Enemy footstep sounds
      if(!enemy._lastStep) enemy._lastStep = 0;
      enemy._lastStep += dt;
      if(enemy._lastStep >= 0.45) {
        playEnemyFootstepSound(pos.x, pos.y, pos.z);
        enemy._lastStep = 0;
      }
    } else {
      // Standing still - reset legs to neutral
      enemy.legL.rotation.x *= 0.9;
      enemy.legR.rotation.x *= 0.9;
    }

    if(mapUseBVHCollision && mapWorldBounds && mapBVHCollisionMesh) {
      const fy = dust2SpawnFeetYAt(pos.x, pos.z, pos.y);
      if(Number.isFinite(fy) && fy > mapWorldBounds.min.y - 8) {
        pos.y = fy;
      }
    }
  });

  // 强制推出墙体：与玩家 resolvePlayerWallPenetration 一致；解决「最小玩家距离 / NPC 互推」把位置挤进墙内
  for(let pass = 0; pass < 2; pass++) {
    enemies.forEach(enemy => {
      if(enemy.dead) return;
      if(mapUseBVHCollision && mapBVHCollisionMesh) {
        const feetY = enemy.group.position.y;
        const yc = feetY + (Collision.ENEMY_WALL_Y0 + Collision.ENEMY_WALL_Y1) * 0.5;
        for(let k = 0; k < 10; k++) {
          Dust2Map.resolvePenetrationXZ(mapBVHCollisionMesh, enemy.group.position, Collision.ENEMY_WALL_R, yc);
        }
      } else {
        Collision.resolveActorWallPenetrationXZ(
          mapObjects,
          enemy.group.position,
          Collision.ENEMY_WALL_R,
          Collision.ENEMY_WALL_Y0,
          Collision.ENEMY_WALL_Y1
        );
      }
    });
  }

  if(mapUseBVHCollision && mapWorldBounds && mapBVHCollisionMesh) {
    enemies.forEach(enemy => {
      if(enemy.dead) return;
      const p = enemy.group.position;
      const fy = dust2SpawnFeetYAt(p.x, p.z, p.y);
      if(Number.isFinite(fy) && fy > mapWorldBounds.min.y - 8) p.y = fy;
    });
  }
}

function enemyShoot(enemy, dist) {
  if(!shouldTreatEnemyAsHostile(enemy)) return;
  // LOS check - bullets cannot go through walls
  const from = enemy.group.position.clone();
  from.y += 1.05; // weapon height on model (scaled)
  const to = camera.position.clone();
  if(!hasLineOfSight(from, to)) return; // blocked by wall, don't shoot

  // Accuracy decreases with distance, random factor
  const accuracy = Math.max(0.3, 1 - dist/30);
  if(Math.random() < accuracy * 0.35) {
    const bulletDmg = 20 + Math.floor(Math.random() * 11);
    GAME.health -= bulletDmg;
    showDamageOverlay();
    updateHealthUI();

    if(GAME.health <= 0) {
      if(isPvpMultiplayerRoom()) {
        if(isMultiplayer1v1RoomMode()) begin1v1RoundDeath();
        else beginRespawnCountdown();
      } else gameOver();
    }
  }

  // Play enemy gunshot sound (distant)
  playEnemyShootSound(dist);

  // Visual: bullet tracer
  createBulletTracer(from, to);
}

function respawnEnemy(enemy) {
  enemy.dead = false;
  enemy.visualPhase = undefined;
  enemy.deathAnimT = 0;
  enemy.corpseTimer = 0;
  enemy.respawnTimer = 0;
  enemy._feetGroundY = undefined;
  enemy._deathRotY = undefined;
  enemy.group.rotation.x = 0;
  enemy.group.rotation.y = 0;
  enemy.group.rotation.z = 0;
  if(enemy.legL && enemy.legR) {
    enemy.legL.rotation.x = 0;
    enemy.legR.rotation.x = 0;
  }
  enemy.health = enemy.cfg.health;
  enemy.state = 'patrol';
  enemy.alertTimer = 0;
  enemy.burstCount = 0;
  enemy.burstCooldown = 0;
  enemy.holdTimer = 0;
  enemy.repositioning = false;
  enemy.repositionTarget = null;
  let rx, rz;
  if(mapUseBVHCollision && mapWorldBounds) {
    let attempts = 0;
    do {
      const p = pickDust2BotSpawnXZSeparated(2.8, enemy);
      rx = p.x;
      rz = p.z;
      attempts++;
    } while(Math.hypot(rx - camera.position.x, rz - camera.position.z) < 12 && attempts < 40);
    const ry = dust2SpawnFeetYAt(rx, rz);
    enemy.group.position.set(rx, ry, rz);
    initDust2EnemyPatrolPoints(enemy);
  } else {
    let attempts = 0;
    do {
      rx = (Math.random()-0.5) * (GAME.mapSize - 10);
      rz = (Math.random()-0.5) * (GAME.mapSize - 10);
      attempts++;
    } while((Math.hypot(rx - camera.position.x, rz - camera.position.z) < 15 || isInsideWall(rx, rz)) && attempts < 50);

    const safePos = findSafeSpawnPos(rx, rz);
    enemy.group.position.copy(safePos);
    enemy.patrolPoints = [];
    for(let i = 0; i < 3; i++) {
      enemy.patrolPoints.push(new THREE.Vector3(rx+(Math.random()-0.5)*20, 0, rz+(Math.random()-0.5)*20));
    }
  }
  enemy.group.visible = true;
  enemy.patrolIndex = 0;
}

// ============================================================
// GAME FLOW
// ============================================================
async function startGame() {
  await mapReadyPromise;
  console.log('[Game HTML] startGame() called');
  clearAllWorldWeaponDrops();
  disposeClientPveEnemies();
  if(shouldSpawnClientPveEnemies()) {
    spawnEnemies();
  }
  respawnUntilMs = 0;
  resetPvpMatchTimerState();
  const ro = document.getElementById('respawn-overlay');
  if(ro) ro.style.display = 'none';
  document.getElementById('main-menu').style.display = 'none';
  document.getElementById('instructions').style.display = 'block';
  setTimeout(() => { document.getElementById('instructions').style.display = 'none'; }, 5000);
  GAME.running = true;
  GAME.paused = false;
  cancelMeleeHeavyCharge();
  GAME.health = 100;
  GAME.kills = 0;
  GAME.headshots = 0;
  GAME.money = 16000;
  GAME.score = 0;
  ownedWeapons = { primary: 'ak', pistol: 'usp' };
  primaryWeaponIndex = 0;
  pistolWeaponIndex = 1;
  currentWeaponIndex = 0;
  
  // Random spawn point in open areas away from enemies
  const spawnPos = getRandomSpawnPos();
  dust2ApplySpawnCameraToWalkableGround(spawnPos.x, spawnPos.z);
  yaw = Math.PI; pitch = 0;
  clearPlayerTracers();
  clearMuzzleEffects();
  clearBulletDecals();
  clearHeadshotFx();
  document.querySelectorAll('.kill-icon').forEach(icon => icon.className = 'kill-icon');
  document.getElementById('headshot-count').textContent = '爆头: 0';
  document.getElementById('total-kills').textContent = '击杀: 0';
  awpScopeStage = 0;
  doubleZoomBlend = 0;
  scopeBlend = 0;
  scopeZoomElapsed = 0;
  isCrouching = false;
  camera.fov = CAM_FOV_HIP;
  camera.updateProjectionMatrix();
  if(viewmodelCamera) {
    viewmodelCamera.fov = VM_FOV_HIP;
    viewmodelCamera.updateProjectionMatrix();
  }
  const ov = document.getElementById('scope-overlay');
  const ch = document.getElementById('crosshair');
  if(ov) ov.style.opacity = '0';
  if(ch) ch.style.opacity = '1';
  initWeapon();
  updateHealthUI();
  updateScoreUI();

  if(!audioCtx) await initAudio();

  setupPvpMatchTimerForStart();

  updateMinimapLabelForMap();
  ensureMinimapThumbLoaded();

  renderer.domElement.requestPointerLock();
}

function togglePause() {
  // PVP mode - no pause, just show controls menu
  const menu = document.getElementById('pause-menu');
  if(menu.style.display === 'flex') {
    menu.style.display = 'none';
    renderer.domElement.requestPointerLock();
  } else {
    menu.style.display = 'flex';
    document.exitPointerLock();
  }
}

function toggleBuyMenu() {
  const menu = document.getElementById('buy-menu');
  if(menu.classList.contains('hidden')) {
    menu.classList.remove('hidden');
    document.exitPointerLock();
  } else {
    menu.classList.add('hidden');
    renderer.domElement.requestPointerLock();
  }
}

function buyWeapon(weaponType, price) {
  if(GAME.money < price) return;
  
  GAME.money -= price;
  updateMoneyUI();
  
  if(weaponType === 'ak' || weaponType === 'awp') {
    // Buying primary weapon
    ownedWeapons.primary = weaponType;
    // Find weapon index
    if(weaponType === 'ak') primaryWeaponIndex = 0;
    else if(weaponType === 'awp') primaryWeaponIndex = 2;
    // Switch to it
    switchWeapon(primaryWeaponIndex);
    weaponMag[primaryWeaponIndex] = WEAPONS[primaryWeaponIndex].magSize;
    weaponReserve[primaryWeaponIndex] = WEAPONS[primaryWeaponIndex].reserve;
    updateWeaponSlotsUI();
  } else if(weaponType === 'usp') {
    // Buying pistol
    ownedWeapons.pistol = weaponType;
    pistolWeaponIndex = 1;
    updateWeaponSlotsUI();
  } else if(weaponType === 'he' || weaponType === 'flash' || weaponType === 'smoke') {
    // Grenade purchase - just deduct money for now
    showKillFeed('购买了 ' + (weaponType === 'he' ? '手雷' : weaponType === 'flash' ? '闪光弹' : '烟雾弹'), false);
  }
  
  updateAmmoUI();
  toggleBuyMenu();
}

function updateWeaponSlotsUI() {
  const slot1 = document.getElementById('slot-1');
  const slot2 = document.getElementById('slot-2');
  
  if(slot1 && ownedWeapons.primary) {
    const weapon = WEAPONS[ownedWeapons.primary === 'ak' ? 0 : 2];
    slot1.innerHTML = '<span class="slot-num">1</span>' + weapon.slotLabel;
  }
  
  if(slot2 && ownedWeapons.pistol) {
    slot2.innerHTML = '<span class="slot-num">2</span>USP';
  }
}

function updateMoneyUI() {
  const container = document.getElementById('ammo-container');
  if(container) {
    let moneyDiv = document.getElementById('money-display');
    if(!moneyDiv) {
      moneyDiv = document.createElement('div');
      moneyDiv.id = 'money-display';
      moneyDiv.style.cssText = 'font-size:10px;color:var(--hud-green);letter-spacing:1px;margin-top:4px;font-family:Orbitron';
      container.appendChild(moneyDiv);
    }
    moneyDiv.textContent = '$' + GAME.money;
  }
}

function setupBuyMenu() {
  document.querySelectorAll('.buy-item').forEach(item => {
    item.addEventListener('click', () => {
      const weapon = item.dataset.weapon;
      const price = parseInt(item.dataset.price);
      buyWeapon(weapon, price);
    });
  });
}

function performMeleeAttack(attackType) {
  if(attackType !== 'light') return;
  const now = performance.now();
  if(now < meleeLightNextAllowedAt) return;
  if(isMeleeAttacking || !canShoot) return;
  const w = currentWeapon();
  const mv = weaponGroup ? getMeleeVmParams(weaponGroup) : null;
  const gap = Math.max(meleeLightFullMs(mv), w.fireRate != null ? w.fireRate : 500);
  meleeLightNextAllowedAt = now + gap;
  meleeLightSwingIndex++;
  meleeLightRySign = (meleeLightSwingIndex % 2 === 1) ? 1 : -1;
  isMeleeAttacking = true;
  meleeAttackType = 'light';
  meleeAttackStartTime = now;
  meleeLightHitDone = false;
}

/** 准心方向 + 上下左右小角度，用于近战宽容判定（仍从相机原点投射） */
function getMeleeSweepDirections(quat) {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  const sp = MELEE_AIM_SPREAD_RAD;
  const dirs = [forward.clone()];
  const a = forward.clone();
  a.applyAxisAngle(right, sp);
  dirs.push(a);
  const b = forward.clone();
  b.applyAxisAngle(right, -sp);
  dirs.push(b);
  const c = forward.clone();
  c.applyAxisAngle(up, sp);
  dirs.push(c);
  const d = forward.clone();
  d.applyAxisAngle(up, -sp);
  dirs.push(d);
  return dirs;
}

function checkMeleeHit(attackType) {
  const meleeRange = attackType === 'light' ? MELEE_RANGE_LIGHT : MELEE_RANGE_HEAVY;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  /** 与 shoot() 一致：第三人称下射线起点为机位偏移，否则近战与准星/实弹不同步、易打空 */
  const meleeTraceOrigin = (thirdPerson && camera)
    ? getThirdPersonShootRay(camera.position, forward, camera.quaternion).origin
    : camera.position.clone();

  const raycaster = new THREE.Raycaster();
  raycaster.set(meleeTraceOrigin, forward);
  raycaster.far = meleeRange + 5;
  const wallIntersects = raycaster.intersectObjects(
    mapObjects.filter(o => o.materialType && !o.mapBVH).map(o => o.mesh), true);

  let wallHit = null;
  let wallHitObj = null;
  for(const hit of wallIntersects) {
    if(hit.distance < meleeRange) {
      wallHit = hit;
      wallHitObj = mapObjects.find(o => o.mesh === hit.object);
      break;
    }
  }
  if(!wallHit && mapBVHCollisionMesh) {
    const bh = Dust2Map.raycastMapFirst(raycaster, mapBVHCollisionMesh);
    if(bh && bh.distance < meleeRange) {
      wallHit = bh;
      wallHitObj = mapObjects.find(o => o.mapBVH);
    }
  }

  if(wallHit) {
    createKnifeMark(wallHit, forward, attackType, wallHitObj);
  }

  const meleeDirs = getMeleeSweepDirections(camera.quaternion);
  const meleeRaycaster = new THREE.Raycaster();

  let best = null;
  for(const dir of meleeDirs) {
    meleeRaycaster.set(meleeTraceOrigin, dir);
    for(const enemy of enemies) {
      if(enemy.dead) continue;
      if(!shouldTreatEnemyAsHostile(enemy)) continue;
      const intersects = meleeRaycaster.intersectObjects(enemy.group.children, true);
      for(const ih of intersects) {
        if(ih.distance >= meleeRange) break;
        const o = ih.object;
        if(o.userData && o.userData.skipMeleeRaycast) continue;
        const hitBodyPart = (o.userData && o.userData.bodyPart) || 'torso';
        if(!best || ih.distance < best.dist) {
          best = { kind: 'enemy', enemy, hitPoint: ih.point, dist: ih.distance, hitBodyPart };
        }
        break;
      }
    }
    remotePlayerMap.forEach((entry, socketId) => {
      if(entry.dead) return;
      if(!shouldTreatRemotePlayerAsHostile(socketId)) return;
      const remoteRoots = [entry.group];
      if(entry.weaponSceneRoot) remoteRoots.push(entry.weaponSceneRoot);
      const intersects = meleeRaycaster.intersectObjects(remoteRoots, true);
      for(const ih of intersects) {
        if(ih.distance >= meleeRange) break;
        const o = ih.object;
        if(o.userData && o.userData.skipMeleeRaycast) continue;
        /** 与 shoot() 对远端一致：跳过 GLTF 枪械装饰等，否则与 NPC（skipMeleeRaycast）行为不对齐 */
        if(o.userData && o.userData.skipBulletRaycast) continue;
        if(o.userData && o.userData.mpCorpseNoHit) continue;
        const hitBodyPart = (o.userData && o.userData.bodyPart) || 'torso';
        if(!best || ih.distance < best.dist) {
          best = { kind: 'remote', socketId, hitPoint: ih.point, dist: ih.distance, hitBodyPart };
        }
        break;
      }
    });
  }

  if(!best) return;

  if(best.kind === 'remote') {
    const { socketId, hitPoint } = best;
    const rent = remotePlayerMap.get(socketId);
    if(isRemoteSpawnProtectedEntry(rent)) return;
    showHitmarker(false);
    showDamageNumber(attackType === 'light' ? MELEE_LIGHT_DAMAGE : GAME.maxHealth, false);
    createImpactParticles(hitPoint, 0xff4444);
    postMultiplayerMeleeHit(socketId, attackType);
    return;
  }

  const { enemy, hitPoint, hitBodyPart } = best;

  // 近战无爆头判定：轻击固定伤害、普通命中反馈；重击秒杀；命中部位仅作日志（伤害不按头身倍率）
  let damage;
  const hpBefore = enemy.health;
  if(attackType === 'light') {
    damage = MELEE_LIGHT_DAMAGE;
  } else {
    damage = hpBefore + 999;
  }

  enemy.health -= damage;
  console.log('[Melee] Hit enemy, damage:', damage, 'body part:', hitBodyPart, 'health:', enemy.health);

  showHitmarker(false);
  showDamageNumber(attackType === 'light' ? MELEE_LIGHT_DAMAGE : hpBefore, false);

  createImpactParticles(hitPoint, 0xff4444);

  if(enemy.health <= 0) {
    killEnemy(enemy, false, forward);
  } else {
    enemy.state = 'chase';
    enemy.hitAlertTimer = 5;
    enemy.alertTimer = enemy.alertThreshold;
  }
}

function createKnifeMark(hit, forward, attackType, wallObj) {
  if(!hit || !forward || !bulletDecalsGroup) return;

  const obj = hit.object;
  let n = new THREE.Vector3();
  if(hit.face && hit.face.normal) {
    n.copy(hit.face.normal);
    n.transformDirection(obj.matrixWorld).normalize();
  } else {
    n.copy(forward).multiplyScalar(-1).normalize();
  }
  if(n.dot(forward) > 0) n.negate();

  const materialType = wallObj && wallObj.materialType ? wallObj.materialType : 'stone';

  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);

  const projectOnPlane = (v, nn) => {
    const d = v.dot(nn);
    return v.clone().sub(nn.clone().multiplyScalar(d));
  };

  let pr = projectOnPlane(camRight, n);
  let pu = projectOnPlane(camUp, n);
  if(pr.lengthSq() < 1e-10) pr = projectOnPlane(new THREE.Vector3(0, 0, 1), n);
  if(pr.lengthSq() < 1e-10) pr = new THREE.Vector3(1, 0, 0);
  pr.normalize();
  if(pu.lengthSq() < 1e-10) pu = new THREE.Vector3().crossVectors(n, pr).normalize();
  else pu.normalize();

  let slashTangent = new THREE.Vector3();
  if(attackType === 'heavy') {
    const pf = projectOnPlane(forward, n);
    if(pf.lengthSq() > 1e-8) {
      slashTangent.copy(pf).normalize();
    } else {
      slashTangent.copy(pr);
    }
  } else {
    /**
     * 与 getLightStrikeOffsets 一致：仅 Ry 随 rs 翻转，Rx/Rz 两刀相同。
     * manifest 当前值（弧度）：windup Ry=-0.28、slash Ry=0.22 → ΔRy=0.5·rs（约 ±28.6°）；
     * windup Rx=0.28、slash Rx=-0.66 → ΔRx=-0.94（约 -53.9°，两刀相同）。
     * 刀痕切线用 (ΔRy)·右 + (ΔRx)·上 投到墙面，两刀仅水平分量镜像，夹角约等于 2·atan(|ΔRy|/|ΔRx|)。
     */
    const mv = weaponGroup ? getMeleeVmParams(weaponGroup) : null;
    const g = (k, def) => {
      const v = mv && mv[k] != null ? mv[k] : def;
      return Number(v);
    };
    const wRx = g('lightWindupRx', DEFAULT_MELEE_VM.lightWindupRx);
    const wRy = g('lightWindupRy', DEFAULT_MELEE_VM.lightWindupRy);
    const sRx = g('lightSlashRx', DEFAULT_MELEE_VM.lightSlashRx);
    const sRy = g('lightSlashRy', DEFAULT_MELEE_VM.lightSlashRy);
    const rs = meleeLightRySign;
    const dRy = (sRy - wRy) * rs;
    const dRx = sRx - wRx;
    slashTangent.addScaledVector(pr, dRy);
    slashTangent.addScaledVector(pu, dRx);
    if(slashTangent.lengthSq() < 1e-8) {
      slashTangent.crossVectors(forward, n);
      if(slashTangent.lengthSq() < 1e-8) slashTangent.crossVectors(new THREE.Vector3(0, 1, 0), n);
    }
    slashTangent.normalize();
  }

  const zAxis = n.clone().normalize();
  const yAxis = slashTangent.clone().normalize();
  const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis);
  if(xAxis.lengthSq() < 1e-10) return;
  xAxis.normalize();
  const yCorr = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();

  const pos = hit.point.clone().addScaledVector(n, 0.014);
  const w = 0.045 + Math.random() * 0.022;
  const h = attackType === 'heavy' ? 0.1 + Math.random() * 0.04 : 0.24 + Math.random() * 0.06;
  const geo = new THREE.PlaneGeometry(w, h);
  const mat = new THREE.MeshBasicMaterial({
    map: getKnifeSlashTexture(materialType),
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos);
  const basis = new THREE.Matrix4().makeBasis(xAxis, yCorr, zAxis);
  mesh.quaternion.setFromRotationMatrix(basis);

  if(bulletDecals.length >= MAX_BULLET_DECALS) {
    const old = bulletDecals.shift();
    bulletDecalsGroup.remove(old.mesh);
    old.mesh.geometry.dispose();
    old.mesh.material.dispose();
  }

  bulletDecals.push({ mesh, life: BULLET_DECAL_LIFE * 3 });
  bulletDecalsGroup.add(mesh);
}

function resumeGame() {
  // No longer used in PVP mode
  document.getElementById('pause-menu').style.display = 'none';
  renderer.domElement.requestPointerLock();
}

/**
 * 联机对局（从大厅 iframe 进入，带 roomId）：死亡后倒计时复活，不显示阵亡菜单。
 * 仅当明确为 pve 时走单机式阵亡界面（避免 settings 缺失时误判成单机）。
 */
function isPvpMultiplayerRoom() {
  if(!multiplayerData || !multiplayerData.roomId) return false;
  const mode = multiplayerData.settings && multiplayerData.settings.mode;
  if(mode === 'pve') return false;
  return true;
}

/** PVP 单局时长兜底（秒），与房间 settings.roundTime 缺省一致 */
const PVP_MATCH_DURATION_FALLBACK_SEC = 120;
/** 对局结束时刻（墙钟 ms，与 performance.now 无关，便于晚进房与全端对齐） */
let pvpMatchEndWallClockMs = 0;
let pvpMatchEnded = false;
/** 1v1：当前回合结束时刻（墙钟 ms） */
let pvpRoundEndWallClockMs = 0;
/** 1v1：本回合是否已上报 roundTimeUp（仅房主上报，双方 UI 归零后防重复） */
let pvpRoundTimeUpReported = false;
/** 1v1：常规时间同血进入加时，无倒计时直至一方被击杀 */
let pvp1v1OvertimeActive = false;
/** 1v1 常规回合：小地图暴露对方（开局/新回合重置；每 30s 亮 3s） */
let pvp1v1MinimapRevealEpochMs = 0;
const PVP_1V1_MINIMAP_REVEAL_EVERY_MS = 30000;
const PVP_1V1_MINIMAP_REVEAL_FOR_MS = 3000;
/** 1v1 加时：小地图雷达单独计时（每 10s 亮 1s） */
let pvp1v1OvertimeRevealEpochMs = 0;
const PVP_1V1_OT_REVEAL_EVERY_MS = 10000;
const PVP_1V1_OT_REVEAL_FOR_MS = 1000;
/** 时间到后自动返回房间页的定时器 */
let pvpAutoReturnToRoomTimer = null;

function resetPvpMatchTimerState() {
  if(pvpAutoReturnToRoomTimer) {
    clearTimeout(pvpAutoReturnToRoomTimer);
    pvpAutoReturnToRoomTimer = null;
  }
  pvpMatchEndWallClockMs = 0;
  pvpRoundEndWallClockMs = 0;
  pvpRoundTimeUpReported = false;
  pvp1v1OvertimeActive = false;
  pvp1v1MinimapRevealEpochMs = 0;
  pvp1v1OvertimeRevealEpochMs = 0;
  pvpMatchEnded = false;
  document.body.classList.remove('pvp-match-active');
  const label = document.getElementById('pvp-match-timer-label');
  if(label) label.textContent = '对局时间';
  const hCt = document.getElementById('pvp-hud-ct-num');
  const hT = document.getElementById('pvp-hud-t-num');
  if(hCt) hCt.textContent = '0';
  if(hT) hT.textContent = '0';
  const res = document.getElementById('pvp-end-result');
  if(res) {
    res.style.display = 'none';
    res.textContent = '';
    res.className = 'pvp-end-result';
  }
  const board = document.getElementById('pvp-end-match-board');
  if(board) board.style.display = 'none';
  const statsBody = document.getElementById('pvp-end-stats-body');
  if(statsBody) statsBody.innerHTML = '';
  const ctNum = document.getElementById('pvp-end-ct-num');
  const tNum = document.getElementById('pvp-end-t-num');
  if(ctNum) ctNum.textContent = '0';
  if(tNum) tNum.textContent = '0';
  const wrap = document.getElementById('pvp-match-timer-wrap');
  if(wrap) {
    wrap.classList.remove('visible', 'pvp-timer-low');
    wrap.style.display = 'none';
    wrap.setAttribute('aria-hidden', 'true');
  }
  const end = document.getElementById('pvp-match-end-overlay');
  if(end) end.style.display = 'none';
  const clockReset = document.getElementById('pvp-match-timer');
  if(clockReset) clockReset.classList.remove('pvp-timer-ot-text');
}

/** 顶栏 CT / T 回合分（与 CS:GO 类似，时间在中间、比分在两侧） */
function syncPvpTopBarTeamScores() {
  if(!isPvpMultiplayerRoom()) return;
  const gs = multiplayerData && multiplayerData.gameState;
  const ct = gs ? Number(gs.ctScore) : NaN;
  const tt = gs ? Number(gs.tScore) : NaN;
  const ctN = Number.isFinite(ct) ? Math.max(0, Math.floor(ct)) : 0;
  const ttN = Number.isFinite(tt) ? Math.max(0, Math.floor(tt)) : 0;
  const elCt = document.getElementById('pvp-hud-ct-num');
  const elT = document.getElementById('pvp-hud-t-num');
  if(elCt) elCt.textContent = String(ctN);
  if(elT) elT.textContent = String(ttN);
}

function updatePvp1v1ScoreFromMultiplayerData() {
  syncPvpTopBarTeamScores();
}

function getPvpMatchDurationSecFromSettings() {
  const rt = multiplayerData && multiplayerData.settings && multiplayerData.settings.roundTime;
  const n = Number(rt);
  if(Number.isFinite(n) && n > 0) return Math.min(3600, Math.max(30, Math.floor(n)));
  return PVP_MATCH_DURATION_FALLBACK_SEC;
}

function parseMultiplayerMatchStartWallClockMs() {
  const gs = multiplayerData && multiplayerData.gameState;
  const st = gs && gs.startTime;
  if(st == null || st === '') return null;
  const t = st instanceof Date ? st.getTime() : new Date(st).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 1v1：优先 roundStartTime（每回合更新），否则回退 startTime（首回合） */
function parse1v1RoundStartWallClockMs() {
  const gs = multiplayerData && multiplayerData.gameState;
  if(!gs) return null;
  const rs = gs.roundStartTime;
  if(rs != null && rs !== '') {
    const t = rs instanceof Date ? rs.getTime() : new Date(rs).getTime();
    if(Number.isFinite(t)) return t;
  }
  return parseMultiplayerMatchStartWallClockMs();
}

/**
 * 按服务端写入的锚点刷新倒计时终点（不重置胜负/加时状态）。
 * 用于：开局 setup、父页重复 init、socket 重连后同步。
 */
function applyPvpTimerAnchorsFromMultiplayerData() {
  if(!isPvpMultiplayerRoom() || pvpMatchEnded) return;
  if(multiplayerData?.gameState?.status !== 'playing') return;
  const durSec = getPvpMatchDurationSecFromSettings();
  if(isMultiplayer1v1RoomMode()) {
    if(pvp1v1OvertimeActive) {
      syncPvpTopBarTeamScores();
      return;
    }
    pvpMatchEndWallClockMs = 0;
    const rs = parse1v1RoundStartWallClockMs();
    if(rs != null) {
      pvpRoundEndWallClockMs = rs + durSec * 1000;
    } else {
      pvpRoundEndWallClockMs = Date.now() + durSec * 1000;
    }
  } else {
    const startMs = parseMultiplayerMatchStartWallClockMs();
    if(startMs != null) {
      pvpMatchEndWallClockMs = startMs + durSec * 1000;
    } else {
      pvpMatchEndWallClockMs = Date.now() + durSec * 1000;
    }
  }
  syncPvpTopBarTeamScores();
  updatePvpMatchTimerDisplay();
}

function setupPvpMatchTimerForStart() {
  if(!isPvpMultiplayerRoom()) return;
  pvpMatchEnded = false;
  if(isMultiplayer1v1RoomMode()) {
    pvpMatchEndWallClockMs = 0;
    pvp1v1OvertimeActive = false;
    pvp1v1OvertimeRevealEpochMs = 0;
    pvp1v1MinimapRevealEpochMs = performance.now();
    pvpRoundTimeUpReported = false;
    document.body.classList.add('pvp-match-active');
    const lbl = document.getElementById('pvp-match-timer-label');
    if(lbl) lbl.textContent = '回合时间';
    const wrap = document.getElementById('pvp-match-timer-wrap');
    if(wrap) {
      wrap.style.display = 'flex';
      wrap.classList.add('visible');
      wrap.setAttribute('aria-hidden', 'false');
    }
    updatePvp1v1ScoreFromMultiplayerData();
    applyPvpTimerAnchorsFromMultiplayerData();
    return;
  }
  pvpRoundEndWallClockMs = 0;
  pvpRoundTimeUpReported = false;
  document.body.classList.add('pvp-match-active');
  const wrap = document.getElementById('pvp-match-timer-wrap');
  if(wrap) {
    wrap.style.display = 'flex';
    wrap.classList.add('visible');
    wrap.setAttribute('aria-hidden', 'false');
  }
  applyPvpTimerAnchorsFromMultiplayerData();
}

function onPvpRoundTimeUpLocal() {
  if(!isMultiplayer1v1RoomMode() || !isPvpMultiplayerRoom() || pvpMatchEnded) return;
  if(pvpRoundTimeUpReported) return;
  pvpRoundTimeUpReported = true;
  pvpRoundEndWallClockMs = 0;
  const clock = document.getElementById('pvp-match-timer');
  if(clock) {
    clock.classList.remove('pvp-timer-ot-text');
    clock.textContent = '0:00';
  }
  if(GAME.playerIsHost && multiplayerData && multiplayerData.roomId) {
    window.parent.postMessage({ type: 'mp-round-timeup', roomId: multiplayerData.roomId }, '*');
  }
}

function handle1v1OvertimeMessage() {
  if(!multiplayerData || !isMultiplayer1v1RoomMode() || !isPvpMultiplayerRoom() || pvpMatchEnded) return;
  pvp1v1OvertimeActive = true;
  pvp1v1OvertimeRevealEpochMs = performance.now();
  const wrap = document.getElementById('pvp-match-timer-wrap');
  if(wrap) {
    wrap.style.display = 'flex';
    wrap.classList.add('visible', 'pvp-timer-low');
    wrap.setAttribute('aria-hidden', 'false');
  }
  updatePvpMatchTimerDisplay();
}

function updatePvpMatchTimerDisplay() {
  if(!isPvpMultiplayerRoom() || pvpMatchEnded) return;
  const clock = document.getElementById('pvp-match-timer');
  const wrap = document.getElementById('pvp-match-timer-wrap');
  if(isMultiplayer1v1RoomMode()) {
    if(pvp1v1OvertimeActive) {
      const lbl = document.getElementById('pvp-match-timer-label');
      if(lbl) lbl.textContent = '加时赛';
      if(clock) {
        clock.textContent = '加时';
        clock.classList.add('pvp-timer-ot-text');
      }
      if(wrap) {
        wrap.style.display = 'flex';
        wrap.classList.add('visible', 'pvp-timer-low');
        wrap.setAttribute('aria-hidden', 'false');
      }
      return;
    }
    if(!pvpRoundEndWallClockMs) return;
    const remain = Math.max(0, pvpRoundEndWallClockMs - Date.now());
    const totalSec = Math.floor(remain / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if(clock) {
      clock.classList.remove('pvp-timer-ot-text');
      clock.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    }
    if(wrap) wrap.classList.toggle('pvp-timer-low', totalSec <= 30 && totalSec > 0);
    if(remain <= 0) {
      onPvpRoundTimeUpLocal();
    }
    return;
  }
  if(!pvpMatchEndWallClockMs) return;
  const remain = Math.max(0, pvpMatchEndWallClockMs - Date.now());
  const totalSec = Math.floor(remain / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if(clock) {
    clock.classList.remove('pvp-timer-ot-text');
    clock.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }
  if(wrap) wrap.classList.toggle('pvp-timer-low', totalSec <= 30 && totalSec > 0);
  if(remain <= 0) {
    pvpMatchEnded = true;
    onPvpMatchTimeUp();
  }
}

function onPvpMatchTimeUp() {
  respawnUntilMs = 0;
  const ro = document.getElementById('respawn-overlay');
  if(ro) ro.style.display = 'none';
  const pm = document.getElementById('pause-menu');
  if(pm) pm.style.display = 'none';
  GAME.running = false;
  GAME.paused = false;
  cancelMeleeHeavyCharge();
  document.exitPointerLock();
  const wrap = document.getElementById('pvp-match-timer-wrap');
  if(wrap) wrap.classList.add('pvp-timer-low');
  const clock = document.getElementById('pvp-match-timer');
  if(clock) {
    clock.classList.remove('pvp-timer-ot-text');
    clock.textContent = '0:00';
  }
  const res = document.getElementById('pvp-end-result');
  if(res) {
    res.style.display = 'none';
    res.textContent = '';
    res.className = 'pvp-end-result';
  }
  const titleEl = document.getElementById('pvp-end-title');
  if(titleEl) titleEl.textContent = '对局结束';
  const subEl = document.getElementById('pvp-end-sub');
  if(subEl) subEl.textContent = '时间已到 · 将返回房间，可再次开始游戏';
  const board = document.getElementById('pvp-end-match-board');
  if(board) board.style.display = 'none';
  const statsBody = document.getElementById('pvp-end-stats-body');
  if(statsBody) statsBody.innerHTML = '';
  const end = document.getElementById('pvp-match-end-overlay');
  if(end) end.style.display = 'flex';
  if(pvpAutoReturnToRoomTimer) {
    clearTimeout(pvpAutoReturnToRoomTimer);
    pvpAutoReturnToRoomTimer = null;
  }
  /** 双方均回房间页，可继续开局；也可点「立即返回」提前 */
  pvpAutoReturnToRoomTimer = setTimeout(() => {
    pvpAutoReturnToRoomTimer = null;
    returnToRoomAfterMatchEnd();
  }, 5000);
}

/**
 * 联机对局结束（时间到等）：不回到大厅主菜单，通知父页面进入房间页
 */
function returnToRoomAfterMatchEnd() {
  if(pvpAutoReturnToRoomTimer) {
    clearTimeout(pvpAutoReturnToRoomTimer);
    pvpAutoReturnToRoomTimer = null;
  }
  if(!multiplayerData || !multiplayerData.roomId) {
    quitToMenu();
    return;
  }
  GAME.running = false;
  GAME.paused = false;
  cancelMeleeHeavyCharge();
  resetPvpMatchTimerState();
  document.getElementById('pause-menu').style.display = 'none';
  respawnUntilMs = 0;
  const ro = document.getElementById('respawn-overlay');
  if(ro) ro.style.display = 'none';
  const go = document.getElementById('gameover-screen');
  if(go) go.style.display = 'none';
  const pvpEnd = document.getElementById('pvp-match-end-overlay');
  if(pvpEnd) pvpEnd.style.display = 'none';
  document.exitPointerLock();
  clearPlayerTracers();
  clearMuzzleEffects();
  clearBulletDecals();
  clearHeadshotFx();
  awpScopeStage = 0;
  doubleZoomBlend = 0;
  scopeBlend = 0;
  scopeZoomElapsed = 0;
  isCrouching = false;
  thirdPerson = false;
  resetPlayerAvatarForQuit();
  clearRemotePlayers();
  localSpawnProtectUntil = 0;
  camera.fov = CAM_FOV_HIP;
  camera.updateProjectionMatrix();
  if(viewmodelCamera) {
    viewmodelCamera.fov = VM_FOV_HIP;
    viewmodelCamera.updateProjectionMatrix();
  }
  const ov = document.getElementById('scope-overlay');
  const ch = document.getElementById('crosshair');
  if(ov) ov.style.opacity = '0';
  if(ch) ch.style.opacity = '1';
  window.parent.postMessage({ type: 'return-to-room', roomId: multiplayerData.roomId }, '*');
}

/** 阵亡后复活倒计时（毫秒时间戳，0 表示未在等待复活） */
let respawnUntilMs = 0;

function beginRespawnCountdown() {
  GAME.running = false;
  localSpawnProtectUntil = 0;
  cancelMeleeHeavyCharge();
  clearHeadshotFx();
  GAME.health = 0;
  updateHealthUI();
  awpScopeStage = 0;
  doubleZoomBlend = 0;
  scopeBlend = 0;
  scopeZoomElapsed = 0;
  isCrouching = false;
  const ov = document.getElementById('scope-overlay');
  const ch = document.getElementById('crosshair');
  if(ov) ov.style.opacity = '0';
  if(ch) ch.style.opacity = '1';
  camera.fov = CAM_FOV_HIP;
  camera.updateProjectionMatrix();
  if(viewmodelCamera) {
    viewmodelCamera.fov = VM_FOV_HIP;
    viewmodelCamera.updateProjectionMatrix();
  }
  document.exitPointerLock();
  const respawnWaitMs = isMultiplayer1v1RoomMode() ? 2000 : 5000;
  respawnUntilMs = performance.now() + respawnWaitMs;
  const ro = document.getElementById('respawn-overlay');
  if(ro) {
    ro.style.display = 'flex';
    const cd = document.getElementById('respawn-countdown');
    if(cd) cd.textContent = String(Math.ceil(respawnWaitMs / 1000));
  }
}

function performRespawn() {
  if(pvpMatchEnded) {
    respawnUntilMs = 0;
    const ro = document.getElementById('respawn-overlay');
    if(ro) ro.style.display = 'none';
    return;
  }
  respawnUntilMs = 0;
  const ro = document.getElementById('respawn-overlay');
  if(ro) ro.style.display = 'none';
  cancelMeleeHeavyCharge();
  clearHeadshotFx();
  GAME.health = GAME.maxHealth;
  updateHealthUI();
  const useWorldRespawnPool = mapUseBVHCollision && mapWorldBounds && getDust2WorldSpawnPointList().length;
  const spawnPos = useWorldRespawnPool || isPvpMultiplayerRoom() ? getRandomSpawnPosForRespawn() : getRandomSpawnPos();
  if(isPvpMultiplayerRoom()) {
    dust2SnapCameraToGroundNearPreferred(spawnPos.x, spawnPos.z);
  } else {
    dust2ApplySpawnCameraToWalkableGround(spawnPos.x, spawnPos.z);
  }
  yaw = Math.PI;
  pitch = 0;
  velocity.set(0, 0, 0);
  isShooting = false;
  sprayConsecutive = 0;
  crosshairSpread = 4;
  awpScopeStage = 0;
  doubleZoomBlend = 0;
  scopeBlend = 0;
  scopeZoomElapsed = 0;
  isCrouching = false;
  cancelReload();
  const ov = document.getElementById('scope-overlay');
  const ch = document.getElementById('crosshair');
  if(ov) ov.style.opacity = '0';
  if(ch) ch.style.opacity = '1';
  camera.fov = CAM_FOV_HIP;
  camera.updateProjectionMatrix();
  if(viewmodelCamera) {
    viewmodelCamera.fov = VM_FOV_HIP;
    viewmodelCamera.updateProjectionMatrix();
  }
  GAME.running = true;
  lastMpSyncSelfAt = 0;
  tryPostMultiplayerSelfSync();
  renderer.domElement.requestPointerLock();
  postMultiplayerRespawnSync();
  startLocalSpawnProtectAfterRespawn();
}

function begin1v1RoundDeath() {
  GAME.running = false;
  localSpawnProtectUntil = 0;
  cancelMeleeHeavyCharge();
  clearHeadshotFx();
  GAME.health = 0;
  updateHealthUI();
  awpScopeStage = 0;
  doubleZoomBlend = 0;
  scopeBlend = 0;
  scopeZoomElapsed = 0;
  isCrouching = false;
  const ov = document.getElementById('scope-overlay');
  const ch = document.getElementById('crosshair');
  if(ov) ov.style.opacity = '0';
  if(ch) ch.style.opacity = '1';
  camera.fov = CAM_FOV_HIP;
  camera.updateProjectionMatrix();
  if(viewmodelCamera) {
    viewmodelCamera.fov = VM_FOV_HIP;
    viewmodelCamera.updateProjectionMatrix();
  }
  document.exitPointerLock();
  respawnUntilMs = 0;
  const ro = document.getElementById('respawn-overlay');
  if(ro) {
    ro.style.display = 'flex';
    const cd = document.getElementById('respawn-countdown');
    if(cd) cd.textContent = '回合结算';
  }
}

function handle1v1RoundEndedMessage(data) {
  if(!multiplayerData || !isMultiplayer1v1RoomMode()) return;
  pvp1v1OvertimeActive = false;
  pvp1v1OvertimeRevealEpochMs = 0;
  pvp1v1MinimapRevealEpochMs = performance.now();
  const lbl = document.getElementById('pvp-match-timer-label');
  if(lbl) lbl.textContent = '回合时间';
  const ct = Number(data.ctScore);
  const tt = Number(data.tScore);
  if(Number.isFinite(ct) && Number.isFinite(tt)) {
    if(multiplayerData.gameState) {
      multiplayerData.gameState.ctScore = ct;
      multiplayerData.gameState.tScore = tt;
      if(data.round != null) multiplayerData.gameState.round = data.round;
    }
  }
  syncPvpTopBarTeamScores();
  remotePlayerMap.forEach((_e, sid) => {
    markRemotePlayerAlive(sid);
  });
  respawnUntilMs = 0;
  const ro = document.getElementById('respawn-overlay');
  if(ro) ro.style.display = 'none';
  const cd = document.getElementById('respawn-countdown');
  if(cd) cd.textContent = '5';
  performRespawn();
  const durSec = getPvpMatchDurationSecFromSettings();
  let rsMs = null;
  if(data.roundStartTime != null && data.roundStartTime !== '') {
    const rt = data.roundStartTime instanceof Date ? data.roundStartTime.getTime() : new Date(data.roundStartTime).getTime();
    if(Number.isFinite(rt)) rsMs = rt;
  }
  if(rsMs != null) {
    pvpRoundEndWallClockMs = rsMs + durSec * 1000;
    if(multiplayerData.gameState) {
      multiplayerData.gameState.roundStartTime = data.roundStartTime;
    }
  } else {
    pvpRoundEndWallClockMs = Date.now() + durSec * 1000;
  }
  pvpRoundTimeUpReported = false;
  updatePvpMatchTimerDisplay();
  if(tabScoreboardHeld) refreshTabScoreboardTable();
}

function formatPvpMatchKd(kills, deaths) {
  const k = Number(kills) || 0;
  const d = Number(deaths) || 0;
  if(d === 0) return k === 0 ? '0.00' : k.toFixed(2);
  return (k / d).toFixed(2);
}

/** 按住 Tab 时显示房间战绩表 */
let tabScoreboardHeld = false;

function roomAllowsTabScoreboard() {
  return !!(multiplayerData && multiplayerData.roomId && GAME.running);
}

function refreshTabScoreboardTable() {
  const body = document.getElementById('tab-scoreboard-body');
  const scoresRow = document.getElementById('tab-scoreboard-scores');
  if(!body || !multiplayerData || !multiplayerData.players) return;
  const mode = multiplayerData.settings && multiplayerData.settings.mode;
  if(scoresRow) {
    if(String(mode) === 'pve') {
      scoresRow.classList.remove('visible');
    } else {
      scoresRow.classList.add('visible');
      const gs = multiplayerData.gameState || {};
      const ct = Number(gs.ctScore) || 0;
      const tt = Number(gs.tScore) || 0;
      const ctEl = document.getElementById('tab-sb-ct');
      const tEl = document.getElementById('tab-sb-t');
      if(ctEl) ctEl.textContent = 'CT ' + ct;
      if(tEl) tEl.textContent = 'T ' + tt;
    }
  }
  const list = multiplayerData.players.slice();
  list.sort((a, b) => {
    const botA = a.isBot ? 1 : 0;
    const botB = b.isBot ? 1 : 0;
    if(botA !== botB) return botA - botB;
    const ta = a.team === 'T' ? 1 : 0;
    const tb = b.team === 'T' ? 1 : 0;
    if(ta !== tb) return ta - tb;
    return String(a.nickname || '').localeCompare(String(b.nickname || ''));
  });
  body.innerHTML = '';
  const localPid = String(multiplayerData.playerId || '');
  const localSock = getLocalMultiplayerSocketId();

  for(let i = 0; i < list.length; i++) {
    const p = list[i];
    const st = p.stats || {};
    const kills = Number(st.kills) || 0;
    const deaths = Number(st.deaths) || 0;
    const isMe =
      !!(localPid && p.playerId && String(p.playerId) === localPid) ||
      !!(localSock && p.odId && String(p.odId) === localSock);
    const tr = document.createElement('tr');
    if(isMe) tr.className = 'pvp-end-me';
    const team = p.team === 'T' ? 'T' : 'CT';
    const tdNick = document.createElement('td');
    const nick = document.createElement('span');
    nick.className = 'pvp-end-nick';
    nick.textContent = String(p.nickname || '玩家');
    tdNick.appendChild(nick);
    const tdTeam = document.createElement('td');
    const teamSpan = document.createElement('span');
    teamSpan.className = team === 'CT' ? 'pvp-end-team-ct' : 'pvp-end-team-t';
    teamSpan.textContent = team === 'CT' ? 'CT' : 'T';
    tdTeam.appendChild(teamSpan);
    const tdK = document.createElement('td');
    tdK.className = 'col-num';
    tdK.textContent = String(kills);
    const tdD = document.createElement('td');
    tdD.className = 'col-num';
    tdD.textContent = String(deaths);
    const tdKd = document.createElement('td');
    tdKd.className = 'col-num';
    tdKd.textContent = formatPvpMatchKd(kills, deaths);
    const tdDmg = document.createElement('td');
    tdDmg.className = 'col-num';
    tdDmg.textContent = String(Math.round(Number(st.damage) || 0));
    const tdSc = document.createElement('td');
    tdSc.className = 'col-num';
    tdSc.textContent = String(Math.round(Number(st.score) || 0));
    const tdMvp = document.createElement('td');
    tdMvp.className = 'col-num';
    tdMvp.textContent = String(Math.round(Number(st.mvps) || 0));
    const tdHs = document.createElement('td');
    tdHs.className = 'col-num';
    tdHs.textContent = String(Math.round(Number(st.headshots) || 0));
    tr.appendChild(tdNick);
    tr.appendChild(tdTeam);
    tr.appendChild(tdK);
    tr.appendChild(tdD);
    tr.appendChild(tdKd);
    tr.appendChild(tdDmg);
    tr.appendChild(tdSc);
    tr.appendChild(tdMvp);
    tr.appendChild(tdHs);
    body.appendChild(tr);
  }
}

function setTabScoreboardVisible(show) {
  const el = document.getElementById('tab-scoreboard-overlay');
  if(!el) return;
  tabScoreboardHeld = !!show;
  if(show) {
    el.classList.add('visible');
    el.setAttribute('aria-hidden', 'false');
    refreshTabScoreboardTable();
  } else {
    el.classList.remove('visible');
    el.setAttribute('aria-hidden', 'true');
  }
}

/** 结算页：总比分 + 个人战绩表（数据来自服务端 game:ended.players） */
function fillPvpEndMatchBoardFromPayload(data) {
  const ct = Number(data.ctScore) || 0;
  const tt = Number(data.tScore) || 0;
  const ctN = document.getElementById('pvp-end-ct-num');
  const tN = document.getElementById('pvp-end-t-num');
  if(ctN) ctN.textContent = String(ct);
  if(tN) tN.textContent = String(tt);

  const body = document.getElementById('pvp-end-stats-body');
  const board = document.getElementById('pvp-end-match-board');
  if(!body || !board) return;

  const list = Array.isArray(data.players) ? data.players.slice() : [];
  if(list.length === 0) {
    board.style.display = 'none';
    return;
  }
  board.style.display = 'block';
  body.innerHTML = '';

  list.sort((a, b) => {
    const ta = a.team === 'T' ? 1 : 0;
    const tb = b.team === 'T' ? 1 : 0;
    if(ta !== tb) return ta - tb;
    return String(a.nickname || '').localeCompare(String(b.nickname || ''));
  });

  const localPid = multiplayerData ? String(multiplayerData.playerId || '') : '';
  const localSock = getLocalMultiplayerSocketId();

  for(let i = 0; i < list.length; i++) {
    const p = list[i];
    const isMe =
      !!(localPid && p.playerId && String(p.playerId) === localPid) ||
      !!(localSock && p.odId && String(p.odId) === localSock);
    const tr = document.createElement('tr');
    if(isMe) tr.className = 'pvp-end-me';
    const team = p.team === 'T' ? 'T' : 'CT';
    const tdNick = document.createElement('td');
    const nick = document.createElement('span');
    nick.className = 'pvp-end-nick';
    nick.textContent = String(p.nickname || '玩家');
    tdNick.appendChild(nick);
    const tdTeam = document.createElement('td');
    const teamSpan = document.createElement('span');
    teamSpan.className = team === 'CT' ? 'pvp-end-team-ct' : 'pvp-end-team-t';
    teamSpan.textContent = team === 'CT' ? 'CT' : 'T';
    tdTeam.appendChild(teamSpan);
    const tdK = document.createElement('td');
    tdK.className = 'col-num';
    tdK.textContent = String(Number(p.kills) || 0);
    const tdD = document.createElement('td');
    tdD.className = 'col-num';
    tdD.textContent = String(Number(p.deaths) || 0);
    const tdKd = document.createElement('td');
    tdKd.className = 'col-num';
    tdKd.textContent = formatPvpMatchKd(p.kills, p.deaths);
    const tdDmg = document.createElement('td');
    tdDmg.className = 'col-num';
    tdDmg.textContent = String(Math.round(Number(p.damage) || 0));
    const tdSc = document.createElement('td');
    tdSc.className = 'col-num';
    tdSc.textContent = String(Math.round(Number(p.score) || 0));
    const tdHs = document.createElement('td');
    tdHs.className = 'col-num';
    tdHs.textContent = String(Math.round(Number(p.headshots) || 0));
    tr.appendChild(tdNick);
    tr.appendChild(tdTeam);
    tr.appendChild(tdK);
    tr.appendChild(tdD);
    tr.appendChild(tdKd);
    tr.appendChild(tdDmg);
    tr.appendChild(tdSc);
    tr.appendChild(tdHs);
    body.appendChild(tr);
  }
}

function handle1v1MatchEndedMessage(data) {
  if(!multiplayerData || !isMultiplayer1v1RoomMode()) return;
  pvp1v1OvertimeActive = false;
  pvp1v1OvertimeRevealEpochMs = 0;
  pvp1v1MinimapRevealEpochMs = 0;
  pvpMatchEnded = true;
  pvpRoundEndWallClockMs = 0;
  pvpMatchEndWallClockMs = 0;
  respawnUntilMs = 0;
  const ro = document.getElementById('respawn-overlay');
  if(ro) ro.style.display = 'none';
  const pm = document.getElementById('pause-menu');
  if(pm) pm.style.display = 'none';
  GAME.running = false;
  GAME.paused = false;
  cancelMeleeHeavyCharge();
  document.exitPointerLock();
  const wrap = document.getElementById('pvp-match-timer-wrap');
  if(wrap) wrap.classList.add('pvp-timer-low');
  const clock = document.getElementById('pvp-match-timer');
  if(clock) {
    clock.classList.remove('pvp-timer-ot-text');
    clock.textContent = '0:00';
  }
  const ct = Number(data.ctScore) || 0;
  const tt = Number(data.tScore) || 0;
  const w = String(data.winner || '');
  const reason = String(data.reason || '');
  let outcome = 'draw';
  if(w === 'CT' || w === 'T') {
    outcome = GAME.playerTeam === w ? 'win' : 'lose';
  }
  const resultEl = document.getElementById('pvp-end-result');
  const titleEl = document.getElementById('pvp-end-title');
  if(titleEl) titleEl.textContent = '对局结束';
  if(resultEl) {
    resultEl.style.display = 'block';
    if(outcome === 'win') {
      resultEl.textContent = '胜利';
      resultEl.className = 'pvp-end-result pvp-end-win';
    } else if(outcome === 'lose') {
      resultEl.textContent = '失败';
      resultEl.className = 'pvp-end-result pvp-end-lose';
    } else {
      resultEl.textContent = '平局';
      resultEl.className = 'pvp-end-result pvp-end-draw';
    }
  }
  fillPvpEndMatchBoardFromPayload(data);

  const sub = document.getElementById('pvp-end-sub');
  if(sub) {
    let reasonLine = '对局结束';
    if(reason === 'opponent_left') {
      reasonLine = outcome === 'win' ? '对手已离开赛场' : '对局已结束';
    } else if(reason === 'score' && (w === 'CT' || w === 'T')) {
      reasonLine = outcome === 'win' ? '率先达到制胜回合分' : '对方达到制胜回合分';
    } else if(w === 'CT' || w === 'T') {
      reasonLine = outcome === 'win' ? '你方获胜' : '你方落败';
    }
    sub.textContent = `${reasonLine} · 即将返回房间，也可点击下方按钮`;
  }
  const end = document.getElementById('pvp-match-end-overlay');
  if(end) end.style.display = 'flex';
  if(pvpAutoReturnToRoomTimer) {
    clearTimeout(pvpAutoReturnToRoomTimer);
    pvpAutoReturnToRoomTimer = null;
  }
  pvpAutoReturnToRoomTimer = setTimeout(() => {
    pvpAutoReturnToRoomTimer = null;
    returnToRoomAfterMatchEnd();
  }, 5000);
}

function gameOver() {
  GAME.running = false;
  localSpawnProtectUntil = 0;
  cancelMeleeHeavyCharge();
  clearHeadshotFx();
  GAME.health = 0;
  awpScopeStage = 0;
  doubleZoomBlend = 0;
  scopeBlend = 0;
  scopeZoomElapsed = 0;
  isCrouching = false;
  const ov = document.getElementById('scope-overlay');
  const ch = document.getElementById('crosshair');
  if(ov) ov.style.opacity = '0';
  if(ch) ch.style.opacity = '1';
  camera.fov = CAM_FOV_HIP;
  camera.updateProjectionMatrix();
  if(viewmodelCamera) {
    viewmodelCamera.fov = VM_FOV_HIP;
    viewmodelCamera.updateProjectionMatrix();
  }
  document.exitPointerLock();
  const go = document.getElementById('gameover-screen');
  if(go) {
    go.style.display = 'flex';
    const fk = document.getElementById('final-kills');
    const fs = document.getElementById('final-score');
    if(fk) fk.textContent = GAME.kills;
    if(fs) fs.textContent = GAME.score;
  }
}

function restartGame() {
  const go = document.getElementById('gameover-screen');
  if(go) go.style.display = 'none';
  enemies.forEach(e => {
    e.dead = false;
    e.visualPhase = undefined;
    e.deathAnimT = 0;
    e.corpseTimer = 0;
    e.respawnTimer = 0;
    e._feetGroundY = undefined;
    e._deathRotY = undefined;
    e.health = e.cfg.health;
    e.group.visible = true;
    e.group.rotation.x = 0;
    e.group.rotation.y = 0;
    e.group.rotation.z = 0;
    if(e.legL && e.legR) { e.legL.rotation.x = 0; e.legR.rotation.x = 0; }
    e.state = 'patrol';
  });
  startGame();
}

function quitToMenu() {
  GAME.running = false;
  GAME.paused = false;
  cancelMeleeHeavyCharge();
  resetPvpMatchTimerState();
  document.getElementById('pause-menu').style.display = 'none';
  respawnUntilMs = 0;
  const ro = document.getElementById('respawn-overlay');
  if(ro) ro.style.display = 'none';
  const go = document.getElementById('gameover-screen');
  if(go) go.style.display = 'none';
  const pvpEnd = document.getElementById('pvp-match-end-overlay');
  if(pvpEnd) pvpEnd.style.display = 'none';
  document.getElementById('main-menu').style.display = 'flex';
  document.exitPointerLock();
  clearPlayerTracers();
  clearMuzzleEffects();
  clearBulletDecals();
  clearHeadshotFx();
  awpScopeStage = 0;
  doubleZoomBlend = 0;
  scopeBlend = 0;
  scopeZoomElapsed = 0;
  isCrouching = false;
  thirdPerson = false;
  resetPlayerAvatarForQuit();
  clearRemotePlayers();
  camera.fov = CAM_FOV_HIP;
  camera.updateProjectionMatrix();
  if(viewmodelCamera) {
    viewmodelCamera.fov = VM_FOV_HIP;
    viewmodelCamera.updateProjectionMatrix();
  }
  const ov = document.getElementById('scope-overlay');
  const ch = document.getElementById('crosshair');
  if(ov) ov.style.opacity = '0';
  if(ch) ch.style.opacity = '1';
  window.parent.postMessage({ type: 'quit-game' }, '*');
}

function showControls() {
  const menu = document.getElementById('pause-menu');
  if(menu) {
    menu.style.display = 'flex';
    document.exitPointerLock();
  }
}

function showLoginOrLobby() {
  // In iframe mode, this shouldn't be called - game starts automatically
  // If clicked, just close menu
}

// ============================================================
// FPS COUNTER
// ============================================================
let fpsFrames = 0, fpsTime = 0;
function updateFPS(dt) {
  fpsFrames++;
  fpsTime += dt;
  if(fpsTime >= 0.5) {
    document.getElementById('fps-counter').textContent = Math.round(fpsFrames/fpsTime) + ' FPS';
    fpsFrames = 0;
    fpsTime = 0;
  }
}

// ============================================================
// AWP 开镜（FOV / 遮罩 / 与 update 同步）
// ============================================================
function updateScope(dt) {
  const w = currentWeapon();
  const sniper = w.type === 'sniper';
  const boltLock = sniper && awpBoltAnimRemaining > 0;
  const reloadLock = sniper && isReloading;
  const want = !!(sniper && awpScopeStage > 0 && GAME.running && !GAME.paused && !boltLock && !reloadLock);
  if(want) {
    scopeZoomElapsed += dt;
    scopeBlend = Math.min(1, scopeZoomElapsed / SCOPE_ZOOM_DURATION);
  } else {
    scopeZoomElapsed = 0;
    scopeBlend = Math.max(0, scopeBlend - dt * 8);
  }
  const targetDZ = (want && awpScopeStage >= 2) ? 1 : 0;
  doubleZoomBlend = THREE.MathUtils.lerp(doubleZoomBlend, targetDZ, Math.min(1, dt * 15));
  const camScoped = THREE.MathUtils.lerp(CAM_FOV_SCOPED_1, CAM_FOV_SCOPED_2, doubleZoomBlend);
  // 第三人称与第一人称共用同一套开镜：世界相机 FOV + 全屏 scope-overlay（与多数 TPS 狙一致）
  camera.fov = THREE.MathUtils.lerp(CAM_FOV_HIP, camScoped, scopeBlend);
  camera.updateProjectionMatrix();
  if(viewmodelCamera) {
    const vmHipFov = sniper ? VM_FOV_AWP_HIP : VM_FOV_HIP;
    const vmScoped = THREE.MathUtils.lerp(VM_FOV_SCOPED_1, VM_FOV_SCOPED_2, doubleZoomBlend);
    viewmodelCamera.fov = THREE.MathUtils.lerp(vmHipFov, vmScoped, scopeBlend);
    viewmodelCamera.aspect = camera.aspect;
    viewmodelCamera.updateProjectionMatrix();
  }
  const ov = document.getElementById('scope-overlay');
  const ch = document.getElementById('crosshair');
  if(ov) {
    ov.style.opacity = (sniper && scopeBlend > 0.06) ? String(Math.min(1, scopeBlend * 0.97)) : '0';
  }
  const scCen = document.getElementById('scope-crosshair-center');
  if(scCen) {
    const movingScoped = want && (moveForward || moveBackward || moveLeft || moveRight);
    scCen.classList.toggle('scope-reticle-moving', movingScoped);
  }
  if(ch) {
    if(isReloading) {
      ch.style.opacity = '1';
    } else {
      const hide = sniper && scopeBlend > 0.25;
      ch.style.opacity = hide ? String(Math.max(0, 1 - (scopeBlend - 0.25) / 0.55)) : '1';
    }
  }
}

function clearMuzzleEffects() {
  while(muzzleFlashes.length) {
    const m = muzzleFlashes.pop();
    if(m.mesh && m.mesh.parent) scene.remove(m.mesh);
    if(m.mesh) { m.mesh.geometry.dispose(); m.mesh.material.dispose(); }
  }
}

// ============================================================
// WEAPON VIEW BOB
// ============================================================
function getWeaponBobOffset() {
  const isMoving = moveForward||moveBackward||moveLeft||moveRight;
  if(!isMoving) return { x:0, y:0 };
  const intensity = isSprinting ? 0.6 : 1.0;
  const bobX = Math.sin(weaponBob) * 0.015 * intensity;
  const bobY = Math.abs(Math.cos(weaponBob * 2)) * 0.012 * intensity;
  return { x:bobX, y:bobY };
}

function updateDevSpawnHud() {
  const wrap = document.getElementById('dev-spawn-hud');
  if(!wrap || !camera) return;
  if(!GAME.running) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  const el1 = document.getElementById('dev-coords-line1');
  const el2 = document.getElementById('dev-coords-line2');
  const elJ = document.getElementById('dev-jump-hint');
  const p = camera.position;
  const feetY = p.y - GAME.playerHeight;
  if(el1) {
    el1.textContent = `相机 X ${p.x.toFixed(3)}  Y ${p.y.toFixed(3)}  Z ${p.z.toFixed(3)}`;
  }
  if(el2) {
    el2.textContent = `脚底 X ${p.x.toFixed(3)}  Y ${feetY.toFixed(3)}  Z ${p.z.toFixed(3)}`;
  }
  if(elJ) {
    elJ.textContent = devInfiniteJump
      ? '无限跳：开（空格）| 再按 J 关闭'
      : '无限跳：关 | 按 J 开启（方便落回地面）';
  }
}

// ============================================================
// MAIN GAME LOOP
// ============================================================
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  despawnExpiredWorldWeaponDrops(performance.now());

  if(isPvpMultiplayerRoom() && !pvpMatchEnded) {
    const needTick = isMultiplayer1v1RoomMode()
      ? pvpRoundEndWallClockMs > 0 || pvp1v1OvertimeActive
      : pvpMatchEndWallClockMs > 0;
    if(needTick) updatePvpMatchTimerDisplay();
  }

  if(respawnUntilMs > 0) {
    const now = performance.now();
    const left = Math.max(0, Math.ceil((respawnUntilMs - now) / 1000));
    const cd = document.getElementById('respawn-countdown');
    if(cd) cd.textContent = String(left);
    if(now >= respawnUntilMs) {
      performRespawn();
    }
  }

  if(GAME.running) {
    updateScope(dt);
    updateDevSpawnHud();
  }
  const mpPvpLerp =
    !!(multiplayerData && multiplayerData.roomId && isPvpMultiplayerRoom() && remotePlayerMap.size);

  if(GAME.running && !GAME.paused) {
    updatePlayer(dt);
    updateRemotePlayersLerp(dt);
    updateEnemies(dt);
    updateParticles(dt);
    updateHeadshotFx(dt);
    updateCrosshair();
    updateMinimap();
    updateMeleeHeavySequence();
    updateMeleeLightSequence();
    updateViewmodel(dt);
    const _mw = currentWeapon();
    if(meleeLightHeld && pointerLocked && _mw.type === 'melee' && !isMeleeAttacking) {
      performMeleeAttack('light');
    }
    if(audioCtx && camera) syncAudioListenerFromCamera();

    // Weapon switch animation
    if(weaponSwitchAnim > 0) {
      weaponSwitchAnim = Math.max(0, weaponSwitchAnim - dt * 4);
    }

    // Animate dust
    if(GAME.dustPoints) {
      const pos = GAME.dustPoints.geometry.attributes.position;
      for(let i = 0; i < pos.count; i++) {
        pos.array[i*3+1] += Math.sin(performance.now()*0.0003 + i) * 0.002;
        if(pos.array[i*3+1] > 5) pos.array[i*3+1] = 0.2;
        if(pos.array[i*3+1] < 0) pos.array[i*3+1] = 4;
      }
      pos.needsUpdate = true;
    }
  } else if(mpPvpLerp && !GAME.paused) {
    /** 本地阵亡倒计时：不跑 updatePlayer，但仍插值远端模型 */
    updateRemotePlayersLerp(dt);
  }

  if(remotePlayerMap.size) updateRemotePlayerWeaponMatrices();

  if(isPvpMultiplayerRoom()) {
    const spNow = performance.now();
    updateRemoteSpawnProtectLights(spNow);
    updateLocalSpawnProtectHighlight(isLocalSpawnProtected(), spNow);
  }

  updateFPS(dt);

  if(GAME.running) updateViewmodelLighting();

  if(thirdPersonWeaponRoot && (!GAME.running || GAME.paused || !thirdPerson)) {
    thirdPersonWeaponRoot.visible = false;
  }

  applyThirdPersonCameraForRender(camera, thirdPerson);
  renderer.render(scene, camera);
  restoreThirdPersonCameraAfterRender(camera);

  if(GAME.running && !thirdPerson) {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(viewmodelScene, viewmodelCamera);
    renderer.autoClear = true;
  }
}

// ============================================================
// BOOT
// ============================================================
/** React 房间页用 iframe 嵌入时由父窗口 postMessage(init)；不可在地图加载较慢时弹出单机主菜单盖住对局 */
const isEmbeddedInParent = typeof window !== 'undefined' && window.parent !== window;
let hasReceivedInit = false;
if (isEmbeddedInParent) {
  const mm = document.getElementById('main-menu');
  if (mm) mm.style.display = 'none';
  const pingReady = () => {
    try {
      window.parent.postMessage({ type: 'csweb-game-ready' }, '*');
    } catch (_) {}
  };
  queueMicrotask(pingReady);
  setTimeout(pingReady, 200);
}
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'init') {
    hasReceivedInit = true;
    document.getElementById('main-menu').style.display = 'none';
  }
});

// 仅独立打开 game.html 时：无 init 则视为单机，1s 后显示主菜单（嵌入 iframe 永不靠此定时器弹出菜单）
setTimeout(() => {
  if (!hasReceivedInit && !isEmbeddedInParent) {
    document.getElementById('main-menu').style.display = 'flex';
  }
}, 1000);

// game.html 使用内联 onclick，ES 模块内函数不在全局作用域，需挂到 window
Object.assign(window, {
  quitToMenu,
  returnToRoomAfterMatchEnd,
  restartGame,
  showControls,
  showLoginOrLobby,
  startGame,
  resumeGame,
});

init().catch((err) => console.error('[game] init failed', err));
