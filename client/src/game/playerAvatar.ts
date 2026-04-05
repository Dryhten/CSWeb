// @ts-nocheck
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SkeletonUtils } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  GAME,
  PLAYER_AVATAR_GLB,
  PLAYER_AVATAR_YAW_OFFSET,
  PLAYER_AVATAR_FEET_LIFT,
} from './constants';

let localPlayerAvatarLoading = false;
let localPlayerAvatarMixer = null;
let localPlayerAvatarActionIdle = null;
let localPlayerAvatarActionWalk = null;
let localPlayerAvatarActionRun = null;
let localPlayerAvatarCurrentAction = null;
let localPlayerAvatarAnimState = '';
const _v3Feet = new THREE.Vector3();
let localPlayerAvatar = null;

let avatarBody = null;
let avatarHead = null;
/** 上臂旋转轴（肩） */
let avatarArmPivotL = null;
let avatarArmPivotR = null;
/** 大腿旋转轴（髋） */
let avatarLegPivotL = null;
let avatarLegPivotR = null;
let avatarUpperBody = null;
let avatarLowerBody = null;

function pickAvatarClip(animations, regexes, useFirstFallback) {
  if(!animations || !animations.length) return null;
  for(let i = 0; i < regexes.length; i++) {
    const found = animations.find(a => regexes[i].test(a.name));
    if(found) return found;
  }
  return useFirstFallback ? animations[0] : null;
}

function computeAvatarWorldBounds(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  let has = false;
  root.traverse(o => {
    if(!o.isMesh || !o.geometry) return;
    const geo = o.geometry;
    if(!geo.boundingBox) geo.computeBoundingBox();
    const lb = geo.boundingBox.clone();
    lb.applyMatrix4(o.matrixWorld);
    if(!has) {
      box.copy(lb);
      has = true;
    } else box.union(lb);
  });
  if(!has) box.setFromObject(root);
  return box;
}

function snapAvatarMeshBottomToGround(model) {
  for(let pass = 0; pass < 4; pass++) {
    model.updateMatrixWorld(true);
    const box = computeAvatarWorldBounds(model);
    if(box.min.y >= -0.002) break;
    model.position.y -= box.min.y;
  }
}

function alignPlayerAvatarFeetToGround(model) {
  model.updateMatrixWorld(true);
  let minNamed = Infinity;
  let minAll = Infinity;
  let hasNamed = false;
  const v = new THREE.Vector3();
  model.traverse(o => {
    if(o.isBone) {
      o.getWorldPosition(v);
      minAll = Math.min(minAll, v.y);
      if(/foot|toe|ankle|heel/i.test(o.name)) {
        minNamed = Math.min(minNamed, v.y);
        hasNamed = true;
      }
    }
    if(!o.isSkinnedMesh || !o.skeleton || !o.skeleton.bones) return;
    o.skeleton.bones.forEach(b => {
      b.getWorldPosition(v);
      minAll = Math.min(minAll, v.y);
      if(/foot|toe|ankle|heel/i.test(b.name)) {
        minNamed = Math.min(minNamed, v.y);
        hasNamed = true;
      }
    });
  });
  let minY;
  if(hasNamed && isFinite(minNamed)) minY = minNamed;
  else if(isFinite(minAll) && minAll !== Infinity) minY = minAll;
  else {
    const box = computeAvatarWorldBounds(model);
    minY = box.min.y;
  }
  if(isFinite(minY)) model.position.y -= minY;
  snapAvatarMeshBottomToGround(model);
  model.position.y += PLAYER_AVATAR_FEET_LIFT;
}

function resolveAvatarAnimationClips(anims) {
  const cIdle = pickAvatarClip(anims, [
    /idle|stand|breath|relax|wait|neutral|t-?pose|tpose/i
  ], true);
  let cWalk = pickAvatarClip(anims, [
    /walk|strut|stride|march|pace|locomotion/i,
    /mixamo\.com\|.*walk|mixamo.*walk|Armature\|.*walk/i
  ], false);
  let cRun = pickAvatarClip(anims, [
    /run|sprint|jog|dash|gallop|fast/i,
    /mixamo\.com\|.*run|mixamo.*run|Armature\|.*run/i
  ], false);
  if(cWalk && cRun && cWalk === cRun) cRun = null;
  const rest = anims.filter(c => c !== cIdle && c !== cWalk && c !== cRun);
  if(!cWalk && rest.length) {
    const w = rest.find(c => /walk|step|move|forward|locom/i.test(c.name));
    cWalk = w || rest[0];
  }
  if(!cRun && rest.length) {
    const r = rest.find(c => c !== cWalk && /run|jog|fast|sprint/i.test(c.name));
    cRun = r || (rest.length > 1 ? rest.find(c => c !== cWalk) : null);
  }
  return { cIdle, cWalk, cRun };
}

function setupPlayerAvatarFromGLTF(gltf, scene) {
  if(localPlayerAvatar) {
    scene.remove(localPlayerAvatar);
    localPlayerAvatar.traverse(ch => {
      if(ch.isMesh) {
        if(ch.geometry) ch.geometry.dispose();
        if(ch.material) {
          const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
          mats.forEach(m => m.dispose && m.dispose());
        }
      }
    });
  }
  localPlayerAvatarMixer = null;
  localPlayerAvatarActionIdle = localPlayerAvatarActionWalk = localPlayerAvatarActionRun = null;
  localPlayerAvatarCurrentAction = null;
  localPlayerAvatarAnimState = '';

  const model = gltf.scene;
  model.traverse(ch => {
    if(ch.isMesh) {
      ch.castShadow = true;
      ch.receiveShadow = true;
    }
  });
  let box = computeAvatarWorldBounds(model);
  const size = box.getSize(_v3Feet);
  if(size.y > 1e-4) {
    const s = GAME.playerHeight / size.y;
    model.scale.setScalar(s);
    model.updateMatrixWorld(true);
    box = computeAvatarWorldBounds(model);
    const cx = (box.min.x + box.max.x) * 0.5;
    const cz = (box.min.z + box.max.z) * 0.5;
    model.position.x -= cx;
    model.position.z -= cz;
    model.updateMatrixWorld(true);
    alignPlayerAvatarFeetToGround(model);
  }
  model.userData.isLocalPlayerAvatar = true;
  localPlayerAvatar = model;
  localPlayerAvatar.visible = false;
  scene.add(localPlayerAvatar);

  const anims = gltf.animations;
  if(anims && anims.length && typeof THREE.AnimationMixer !== 'undefined') {
    localPlayerAvatarMixer = new THREE.AnimationMixer(model);
    const { cIdle, cWalk, cRun } = resolveAvatarAnimationClips(anims);
    const mk = (clip) => {
      if(!clip) return null;
      const a = localPlayerAvatarMixer.clipAction(clip);
      a.setLoop(THREE.LoopRepeat, Infinity);
      a.clampWhenFinished = false;
      return a;
    };
    localPlayerAvatarActionIdle = mk(cIdle);
    localPlayerAvatarActionWalk = (cWalk && cWalk !== cIdle) ? mk(cWalk) : null;
    localPlayerAvatarActionRun = (cRun && cRun !== cIdle && cRun !== cWalk) ? mk(cRun) : null;
    if(localPlayerAvatarActionIdle) {
      localPlayerAvatarActionIdle.play();
      localPlayerAvatarCurrentAction = localPlayerAvatarActionIdle;
      localPlayerAvatarAnimState = 'idle';
    }
  }
}

function crossFadePlayerAvatar(nextState) {
  if(!localPlayerAvatarMixer) return;
  let next = null;
  if(nextState === 'run') next = localPlayerAvatarActionRun || localPlayerAvatarActionWalk || localPlayerAvatarActionIdle;
  else if(nextState === 'walk') next = localPlayerAvatarActionWalk || localPlayerAvatarActionRun || localPlayerAvatarActionIdle;
  else next = localPlayerAvatarActionIdle;
  if(!next) return;
  if(localPlayerAvatarAnimState === nextState && localPlayerAvatarCurrentAction === next) return;
  const dur = 0.2;
  if(localPlayerAvatarCurrentAction && localPlayerAvatarCurrentAction !== next) {
    localPlayerAvatarCurrentAction.fadeOut(dur);
  }
  next.reset().fadeIn(dur).play();
  localPlayerAvatarCurrentAction = next;
  localPlayerAvatarAnimState = nextState;
}

function updateLocalPlayerAvatarAnimation(input) {
  if(!localPlayerAvatarMixer) return;
  const moving = input.moveForward || input.moveBackward || input.moveLeft || input.moveRight;
  let st = 'idle';
  if(moving) {
    if(input.isSprinting) {
      if(localPlayerAvatarActionWalk) st = 'walk';
      else if(localPlayerAvatarActionRun) st = 'run';
      else st = 'idle';
    } else {
      if(localPlayerAvatarActionRun) st = 'run';
      else if(localPlayerAvatarActionWalk) st = 'walk';
      else st = 'idle';
    }
  }
  crossFadePlayerAvatar(st);
}

let animTime = 0;
function updateProceduralAvatarAnimation(dt, moving, isRunning) {
  if(!avatarHead || !avatarUpperBody) return;
  animTime += dt;
  const t = animTime;
  const speed = isRunning ? 10 : (moving ? 5.5 : 1.2);
  const walkAmp = isRunning ? 0.55 : 0.38;
  const phase = t * speed;

  if(moving) {
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    avatarHead.rotation.y = s * 0.04;
    avatarHead.rotation.x = s * 0.06;
    avatarHead.rotation.z = c * 0.03;
    avatarUpperBody.rotation.z = s * 0.06;
    avatarUpperBody.rotation.x = -Math.abs(s) * 0.04;
    if(avatarLowerBody) avatarLowerBody.rotation.z = -s * 0.05;
    if(avatarLegPivotL && avatarLegPivotR) {
      avatarLegPivotL.rotation.x = -s * walkAmp;
      avatarLegPivotR.rotation.x = s * walkAmp;
    }
    if(avatarArmPivotL && avatarArmPivotR) {
      avatarArmPivotL.rotation.x = s * walkAmp * 0.85 + 0.15;
      avatarArmPivotR.rotation.x = -s * walkAmp * 0.85 + 0.15;
    }
  } else {
    const b = Math.sin(phase * 0.9) * 0.015;
    avatarHead.rotation.set(b * 0.5, b * 0.3, b * 0.2);
    avatarUpperBody.rotation.x = b * 0.2;
    avatarUpperBody.rotation.z = b * 0.15;
    if(avatarLowerBody) avatarLowerBody.rotation.z = b * 0.1;
    if(avatarLegPivotL && avatarLegPivotR) {
      avatarLegPivotL.rotation.x *= 0.8;
      avatarLegPivotR.rotation.x *= 0.8;
      if(Math.abs(avatarLegPivotL.rotation.x) < 0.002) avatarLegPivotL.rotation.x = 0;
      if(Math.abs(avatarLegPivotR.rotation.x) < 0.002) avatarLegPivotR.rotation.x = 0;
    }
    if(avatarArmPivotL && avatarArmPivotR) {
      avatarArmPivotL.rotation.x = THREE.MathUtils.lerp(avatarArmPivotL.rotation.x, 0.06, 0.15);
      avatarArmPivotR.rotation.x = THREE.MathUtils.lerp(avatarArmPivotR.rotation.x, 0.06, 0.15);
    }
  }
}

function createLocalPlayerAvatarGroup() {
  const group = new THREE.Group();

  const skinMat = new THREE.MeshStandardMaterial({
    color: 0xdcb8a0,
    roughness: 0.78,
    metalness: 0.04,
  });
  const pantsMat = new THREE.MeshStandardMaterial({
    color: 0x3d4f60,
    roughness: 0.88,
    metalness: 0.06,
  });
  const vestMat = new THREE.MeshStandardMaterial({
    color: 0x3a5a78,
    roughness: 0.72,
    metalness: 0.12,
  });
  const shoeMat = new THREE.MeshStandardMaterial({
    color: 0x1a1c20,
    roughness: 0.65,
    metalness: 0.25,
  });

  const HIP_Y = 0.395;
  const LEG_LEN = 0.385;
  const FOOT_H = 0.045;
  /** 与骨盆上沿衔接（原 0.84 会在缩放前留下腰臀大缝） */
  const WAIST_Y = 0.445;

  avatarLowerBody = new THREE.Group();
  const pelvis = new THREE.Mesh(
    new THREE.CylinderGeometry(0.125, 0.14, 0.2, 12),
    pantsMat
  );
  pelvis.position.y = 0.33;
  pelvis.userData.bodyPart = 'limb';
  avatarLowerBody.add(pelvis);

  function makeLeg(side) {
    const pivot = new THREE.Group();
    const x = side * 0.088;
    pivot.position.set(x, HIP_Y, 0);
    const thigh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.058, 0.064, LEG_LEN, 10),
      pantsMat
    );
    thigh.position.y = -LEG_LEN * 0.5;
    thigh.userData.bodyPart = 'limb';
    pivot.add(thigh);
    const foot = new THREE.Mesh(
      new THREE.BoxGeometry(0.095, FOOT_H, 0.17),
      shoeMat
    );
    foot.position.set(0, -LEG_LEN - FOOT_H * 0.5 + 0.01, 0.025);
    foot.userData.bodyPart = 'limb';
    pivot.add(foot);
    return pivot;
  }

  avatarLegPivotL = makeLeg(-1);
  avatarLegPivotR = makeLeg(1);
  avatarLowerBody.add(avatarLegPivotL);
  avatarLowerBody.add(avatarLegPivotR);

  group.add(avatarLowerBody);

  avatarUpperBody = new THREE.Group();
  avatarUpperBody.position.y = WAIST_Y;

  const torso = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.168, 0.38, 12),
    vestMat
  );
  torso.position.y = 0.24;
  torso.userData.bodyPart = 'torso';
  avatarUpperBody.add(torso);

  const belt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.135, 0.16, 0.07, 12),
    pantsMat
  );
  belt.position.y = 0.02;
  belt.userData.bodyPart = 'torso';
  avatarUpperBody.add(belt);

  const UPPER_ARM = 0.21;
  const FOREARM = 0.19;
  const shoulderY = 0.44;
  const shoulderX = 0.2;

  function makeArm(side) {
    const pivot = new THREE.Group();
    const x = side * shoulderX;
    pivot.position.set(x, shoulderY, 0);
    pivot.rotation.z = side * 0.08;
    const upper = new THREE.Mesh(
      new THREE.CylinderGeometry(0.048, 0.052, UPPER_ARM, 8),
      vestMat
    );
    upper.position.y = -UPPER_ARM * 0.45;
    upper.userData.bodyPart = 'limb';
    pivot.add(upper);
    const fore = new THREE.Mesh(
      new THREE.CylinderGeometry(0.042, 0.045, FOREARM, 8),
      skinMat
    );
    fore.position.y = -UPPER_ARM - FOREARM * 0.45;
    fore.userData.bodyPart = 'limb';
    pivot.add(fore);
    const hand = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 8, 6),
      skinMat
    );
    hand.position.y = -UPPER_ARM - FOREARM - 0.02;
    hand.userData.bodyPart = 'limb';
    pivot.add(hand);
    return pivot;
  }

  avatarArmPivotL = makeArm(-1);
  avatarArmPivotR = makeArm(1);
  avatarUpperBody.add(avatarArmPivotL);
  avatarUpperBody.add(avatarArmPivotR);

  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.058, 0.09, 8),
    skinMat
  );
  neck.position.y = 0.475;
  neck.userData.bodyPart = 'torso';
  avatarUpperBody.add(neck);

  avatarHead = new THREE.Mesh(
    new THREE.SphereGeometry(0.105, 16, 12),
    skinMat
  );
  avatarHead.position.y = 0.62;
  avatarHead.userData.bodyPart = 'head';
  avatarUpperBody.add(avatarHead);

  const hairMat = new THREE.MeshStandardMaterial({
    color: 0x2a2420,
    roughness: 0.9,
    metalness: 0.02,
  });
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.108, 14, 10), hairMat);
  hair.scale.set(1, 0.42, 1.02);
  hair.position.y = 0.68;
  hair.userData.bodyPart = 'head';
  avatarUpperBody.add(hair);

  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.35 });
  const eyeGeo = new THREE.SphereGeometry(0.016, 8, 6);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.036, 0.64, 0.09);
  eyeL.userData.bodyPart = 'head';
  avatarUpperBody.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(0.036, 0.64, 0.09);
  eyeR.userData.bodyPart = 'head';
  avatarUpperBody.add(eyeR);

  group.add(avatarUpperBody);

  avatarBody = avatarUpperBody;

  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  const h = box.max.y - box.min.y;
  if(h > 1e-4) {
    group.scale.setScalar(GAME.playerHeight / h);
  }
  group.updateMatrixWorld(true);
  // 头部中心到脚底距离 = 玩家眼高（与相机相对脚底一致），第三人称头与视角齐平
  const fullBox = new THREE.Box3().setFromObject(group);
  const headBox = new THREE.Box3().setFromObject(avatarHead);
  const headCy = (headBox.min.y + headBox.max.y) * 0.5;
  const feetToHead = headCy - fullBox.min.y;
  if(feetToHead > 1e-4) {
    group.scale.multiplyScalar(GAME.playerHeight / feetToHead);
  }
  group.updateMatrixWorld(true);
  const boxGround = new THREE.Box3().setFromObject(group);
  group.position.y -= boxGround.min.y;

  group.updateMatrixWorld(true);
  group.traverse(ch => {
    if(ch.isMesh) {
      ch.castShadow = true;
      ch.receiveShadow = true;
    }
  });
  group.userData.isLocalPlayerAvatar = true;
  group.userData.isProcedural = true;
  return group;
}

export function ensureLocalPlayerAvatar(scene) {
  if(localPlayerAvatar || !scene || localPlayerAvatarLoading) return;
  if(!PLAYER_AVATAR_GLB) {
    localPlayerAvatar = createLocalPlayerAvatarGroup();
    localPlayerAvatar.visible = false;
    scene.add(localPlayerAvatar);
    return;
  }
  if(typeof GLTFLoader === 'undefined') {
    localPlayerAvatar = createLocalPlayerAvatarGroup();
    localPlayerAvatar.visible = false;
    scene.add(localPlayerAvatar);
    return;
  }
  localPlayerAvatarLoading = true;
  const loader = new GLTFLoader();
  loader.load(
    PLAYER_AVATAR_GLB,
    gltf => {
      localPlayerAvatarLoading = false;
      setupPlayerAvatarFromGLTF(gltf, scene);
    },
    undefined,
    () => {
      localPlayerAvatarLoading = false;
      if(!localPlayerAvatar) {
        localPlayerAvatar = createLocalPlayerAvatarGroup();
        localPlayerAvatar.visible = false;
        scene.add(localPlayerAvatar);
      }
    }
  );
}

export function syncLocalPlayerAvatar(dt, ctx) {
  if(!localPlayerAvatar) return;
  const feetY = ctx.camera.position.y - GAME.playerHeight;
  localPlayerAvatar.position.set(ctx.camera.position.x, feetY, ctx.camera.position.z);
  localPlayerAvatar.rotation.y = ctx.yaw + PLAYER_AVATAR_YAW_OFFSET;
  const vis = !!(ctx.thirdPerson && GAME.running && !GAME.paused);
  localPlayerAvatar.visible = vis;
  if(vis) {
    if(localPlayerAvatar.userData.isProcedural) {
      const moving = ctx.moveForward || ctx.moveBackward || ctx.moveLeft || ctx.moveRight;
      const isRunning = ctx.isSprinting;
      updateProceduralAvatarAnimation(dt, moving, isRunning);
    } else if(localPlayerAvatarMixer) {
      updateLocalPlayerAvatarAnimation(ctx);
      localPlayerAvatarMixer.update(dt);
    }
  }
}

export function resetPlayerAvatarForQuit() {
  if(localPlayerAvatar) localPlayerAvatar.visible = false;
  if(localPlayerAvatarMixer) localPlayerAvatarMixer.stopAllAction();
}

export function isLocalPlayerAvatarReady() {
  return !!localPlayerAvatar;
}

/** GLTF 子网格若无名且无 bodyPart，按名称跳过枪械等装饰，避免挡在头前时射击判成躯干 */
const REMOTE_WEAPON_NAME_RE =
  /weapon|rifle|gun|pistol|muzzle|mag|sight|scope|silencer|suppressor|flash|barrel|stock|rail|knife|optic|handguard|receiver|holster|magwell|trigger/i;

/** 克隆本地第三人称模型作为其他玩家（需在 ensureLocalPlayerAvatar 已创建本地模型后调用） */
export function cloneAvatarForRemotePlayer(scene, socketId) {
  if(!localPlayerAvatar || !scene) return null;
  const clone = SkeletonUtils.clone(localPlayerAvatar);
  clone.visible = true;
  clone.userData.remoteSocketId = socketId;
  clone.userData.isRemotePlayerAvatar = true;
  clone.traverse((ch) => {
    if(!ch.isMesh) return;
    const ud = ch.userData || (ch.userData = {});
    if(ud.bodyPart) return;
    const n = ch.name || '';
    if(n && REMOTE_WEAPON_NAME_RE.test(n)) ud.skipBulletRaycast = true;
  });
  scene.add(clone);
  return clone;
}

export function setRemotePlayerAvatarTransform(group, x, feetY, z, yawRad) {
  if(!group) return;
  group.rotation.order = 'YXZ';
  group.position.set(x, feetY, z);
  group.rotation.x = 0;
  group.rotation.z = 0;
  group.rotation.y = yawRad + PLAYER_AVATAR_YAW_OFFSET;
}

/** 联机远端玩家阵亡：后仰倒地，脚底略下沉贴地（无独立死亡动画时的折中） */
export function setRemotePlayerCorpsePose(group, x, feetY, z, yawRad) {
  if(!group) return;
  group.rotation.order = 'YXZ';
  const fallPitch = Math.PI * 0.48;
  const sink = 0.44;
  group.position.set(x, feetY - sink, z);
  group.rotation.y = yawRad + PLAYER_AVATAR_YAW_OFFSET;
  group.rotation.x = fallPitch;
  group.rotation.z = 0;
}

export function clearRemotePlayerCorpsePose(group) {
  if(!group) return;
  group.rotation.x = 0;
  group.rotation.z = 0;
}

const SPAWN_PROT_LIGHT_COLOR = 0xffe8a0;

/** 第三人称本地模型：复活无敌淡黄色闪烁点光（父级 visible 为 false 时不照亮场景） */
export function updateLocalSpawnProtectHighlight(active, nowMs) {
  if(!localPlayerAvatar) return;
  let lit = localPlayerAvatar.userData._spawnProtLight;
  if(!active) {
    if(lit) lit.intensity = 0;
    return;
  }
  if(!lit) {
    lit = new THREE.PointLight(SPAWN_PROT_LIGHT_COLOR, 0.5, 3.2, 2);
    lit.position.set(0, 1.08, 0);
    localPlayerAvatar.add(lit);
    localPlayerAvatar.userData._spawnProtLight = lit;
  }
  const t = nowMs * 0.012;
  lit.intensity = 0.38 + Math.sin(t) * 0.16 + Math.sin(t * 2.35) * 0.055;
}

export function disposeRemotePlayerAvatar(scene, group) {
  if(!group || !scene) return;
  scene.remove(group);
  group.traverse((ch) => {
    if(ch.isMesh) {
      if(ch.geometry) ch.geometry.dispose();
      if(ch.material) {
        const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
        mats.forEach((m) => m.dispose && m.dispose());
      }
    }
  });
}
