import * as THREE from './vendor/three/three.module.js';

// Follow the actual bone-to-child segment rather than assuming a local Y axis.
// Use model-local targets so scene rotation and scale do not alter the pose.
function aimSegment(model, boneName, childName, direction) {
  const bone = model.getObjectByName(boneName);
  const child = model.getObjectByName(childName);
  if (!bone?.isBone || !child?.isBone || child.parent !== bone) return false;
  model.updateMatrixWorld(true);
  const origin = bone.getWorldPosition(new THREE.Vector3());
  const current = child.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
  const target = new THREE.Vector3(...direction).transformDirection(model.matrixWorld);
  const swing = new THREE.Quaternion().setFromUnitVectors(current, target);
  const world = bone.getWorldQuaternion(new THREE.Quaternion());
  const parentInverse = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  bone.quaternion.copy(parentInverse.multiply(swing).multiply(world)).normalize();
  model.updateMatrixWorld(true);
  return true;
}

export function relaxArms(model) {
  // Keep clearance at the shoulder and a small forward bend at the elbow.
  // Preserve the authored wrist roll and all finger joints.
  for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
    aimSegment(model, side + 'Arm', side + 'ForeArm', [sign * .24, -.97, -.025]);
    aimSegment(model, side + 'ForeArm', side + 'Hand', [sign * .10, -.96, .26]);
  }
}
