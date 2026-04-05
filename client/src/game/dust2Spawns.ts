// @ts-nocheck
/**
 * de_dust2 常用出生点：用包围盒归一化 UV（0~1）描述，适配任意缩放/朝向的 GLB。
 * 若某点仍落在模型外，可在 constants 里微调 u/v 或略改 dust2MapRotationY。
 */
import * as THREE from 'three';

export type Dust2SpawnUv = { id: string; u: number; v: number };

/** T / CT / 中路 / A / B / 长 A / 短（猫道）/ B 洞 —— 经典 dust2 八区 */
export const DUST2_SPAWN_UV: Dust2SpawnUv[] = [
  { id: 't_spawn', u: 0.5, v: 0.9 },
  { id: 'ct_spawn', u: 0.5, v: 0.1 },
  { id: 'mid', u: 0.5, v: 0.5 },
  { id: 'a_site', u: 0.76, v: 0.26 },
  { id: 'b_site', u: 0.24, v: 0.38 },
  { id: 'long_a', u: 0.88, v: 0.34 },
  { id: 'cat_short', u: 0.62, v: 0.44 },
  { id: 'b_tunnels', u: 0.28, v: 0.64 },
];

/**
 * @param jitter 相对包围盒宽/深的随机偏移比例（约 0.008～0.03）
 * @param edgeMargin 将 u/v 限制在 [edgeMargin, 1-edgeMargin]，减少贴 AABB 边缘出生在模型外
 */
export function dust2SpawnXZ(
  bounds: THREE.Box3,
  uv: Dust2SpawnUv,
  jitter = 0.028,
  edgeMargin = 0.005
): { x: number; z: number } {
  const w = bounds.max.x - bounds.min.x;
  const d = bounds.max.z - bounds.min.z;
  const em = Math.min(0.48, Math.max(0.002, edgeMargin));
  let u = uv.u + (Math.random() - 0.5) * 2 * jitter;
  let v = uv.v + (Math.random() - 0.5) * 2 * jitter;
  u = Math.min(1 - em, Math.max(em, u));
  v = Math.min(1 - em, Math.max(em, v));
  return {
    x: bounds.min.x + u * w,
    z: bounds.min.z + v * d,
  };
}

/** 无抖动：固定 u,v → 世界 XZ（测试出生点用） */
export function dust2UvToXZExact(
  bounds: THREE.Box3,
  u: number,
  v: number,
  edgeMargin = 0.02
): { x: number; z: number } {
  const w = bounds.max.x - bounds.min.x;
  const d = bounds.max.z - bounds.min.z;
  const em = Math.min(0.48, Math.max(0.002, edgeMargin));
  const uu = Math.min(1 - em, Math.max(em, u));
  const vv = Math.min(1 - em, Math.max(em, v));
  return {
    x: bounds.min.x + uu * w,
    z: bounds.min.z + vv * d,
  };
}
