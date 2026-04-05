// @ts-nocheck
import * as THREE from 'three';
import { THIRD_PERSON_DIST, THIRD_PERSON_Y_LIFT, THIRD_PERSON_SHOULDER_OFFSET } from './constants';

const _tpFwd = new THREE.Vector3();
const _tpRight = new THREE.Vector3();
const _tpWorldUp = new THREE.Vector3(0, 1, 0);
let _tpSavedPos = null;
let _tpSavedQuat = null;

/**
 * 第三人称：只平移机位，不改变朝向（与第一人称相同的 quaternion）。
 * 若使用 lookAt(眼部)，屏幕中心会永远指向自己头部，准星必挡脸；
 * 保持朝向后，屏幕中心射线与 aimFwd 一致，与第一人称瞄准一致。
 */
export function applyThirdPersonCameraForRender(camera, thirdPerson) {
  if(!thirdPerson) return;
  _tpSavedPos = camera.position.clone();
  _tpSavedQuat = camera.quaternion.clone();
  const eye = _tpSavedPos;
  _tpFwd.set(0, 0, -1).applyQuaternion(_tpSavedQuat);
  _tpRight.set(1, 0, 0).applyQuaternion(_tpSavedQuat);
  camera.position.copy(eye).addScaledVector(_tpFwd, -THIRD_PERSON_DIST).addScaledVector(_tpRight, THIRD_PERSON_SHOULDER_OFFSET);
  camera.position.y += THIRD_PERSON_Y_LIFT;
}

export function restoreThirdPersonCameraAfterRender(camera) {
  if(!_tpSavedPos) return;
  camera.position.copy(_tpSavedPos);
  camera.quaternion.copy(_tpSavedQuat);
  _tpSavedPos = null;
  _tpSavedQuat = null;
}

/**
 * 与 applyThirdPersonCameraForRender 一致：射线起点为第三人称机位，方向为 aimFwd（与准星/第一人称一致）
 */
export function getThirdPersonShootRay(eye, aimFwd, camQuat) {
  const origin = eye.clone().addScaledVector(aimFwd, -THIRD_PERSON_DIST);
  if(camQuat) {
    _tpRight.set(1, 0, 0).applyQuaternion(camQuat);
  } else {
    _tpRight.crossVectors(aimFwd, _tpWorldUp);
    if(_tpRight.lengthSq() < 1e-10) _tpRight.set(1, 0, 0);
    else _tpRight.normalize();
  }
  origin.addScaledVector(_tpRight, THIRD_PERSON_SHOULDER_OFFSET);
  origin.y += THIRD_PERSON_Y_LIFT;
  const direction = aimFwd.clone();
  if(direction.lengthSq() > 1e-10) direction.normalize();
  return { origin, direction };
}
