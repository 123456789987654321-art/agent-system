const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
// Load the exact browser math implementation without adding a second Three.js
// dependency or changing this CommonJS application's package type.
const setup = (async () => {
  const core = moduleURL(await fs.readFile(path.join(root, 'public/vendor/three/three.core.js'), 'utf8'));
  const math = await import(core);
  const source = await fs.readFile(path.join(root, 'public/avatar-rig.mjs'), 'utf8');
  const rig = await import(moduleURL(source.replace('./vendor/three/three.module.js', core)));
  const binary = await fs.readFile(path.join(root, 'public/assets/home-assistant.glb'));
  const gltf = JSON.parse(binary.subarray(20, 20 + binary.readUInt32LE(12)));
  return { THREE: math, relaxArms: rig.relaxArms, gltf };
})();

function skeleton(THREE, gltf) {
  const joints = new Set(gltf.skins.flatMap(s => s.joints));
  const nodes = gltf.nodes.map((n, i) => {
    const o = joints.has(i) ? new THREE.Bone() : new THREE.Group();
    o.name = n.name;
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  gltf.nodes.forEach((n, i) => (n.children || []).forEach(j => nodes[i].add(nodes[j])));
  const model = new THREE.Group();
  gltf.scenes[gltf.scene || 0].nodes.forEach(i => model.add(nodes[i]));
  return model;
}

test('actual avatar has forward elbow bends, clearance and symmetric arms', async () => {
  const { THREE, relaxArms, gltf } = await setup;
  const model = skeleton(THREE, gltf);
  const wrists = ['LeftHand', 'RightHand'].map(n => model.getObjectByName(n).quaternion.clone());
  const lengths = side => {
    model.updateMatrixWorld(true);
    const p = ['Arm', 'ForeArm', 'Hand'].map(n => model.getObjectByName(side + n).getWorldPosition(new THREE.Vector3()));
    return [p[0].distanceTo(p[1]), p[1].distanceTo(p[2])];
  };
  const before = lengths('Left');
  relaxArms(model);
  const after = lengths('Left');
  after.forEach((v,i)=>assert(Math.abs(v-before[i])<1e-6, 'bone length is preserved'));
  for (const [side,sign,index] of [['Left',1,0],['Right',-1,1]]) {
    const p = ['Arm','ForeArm','Hand'].map(n=>model.getObjectByName(side+n).getWorldPosition(new THREE.Vector3()));
    const upper = p[1].clone().sub(p[0]), lower=p[2].clone().sub(p[1]);
    const angle = upper.angleTo(lower)*180/Math.PI;
    assert(angle>12 && angle<25, 'relaxed elbow bend remains in the intended range');
    assert(p[2].z>p[1].z+.04, 'wrist bends forward');
    assert(sign*p[1].x>sign*p[0].x+.04, 'upper arm clears the torso');
    assert(sign*p[2].x>sign*p[1].x, 'forearm does not cross the body');
    assert(model.getObjectByName(side+'Hand').quaternion.angleTo(wrists[index])<1e-6, 'wrist roll is preserved');
  }
  const left=model.getObjectByName('LeftHand').getWorldPosition(new THREE.Vector3());
  const right=model.getObjectByName('RightHand').getWorldPosition(new THREE.Vector3());
  assert(Math.abs(left.x+right.x)<1e-5 && Math.abs(left.y-right.y)<1e-5 && Math.abs(left.z-right.z)<1e-5);
});

test('pose is stable when reapplied and independent of model transform', async () => {
  const { THREE, relaxArms, gltf } = await setup;
  const a=skeleton(THREE,gltf), b=skeleton(THREE,gltf);
  b.rotation.set(.1,.7,-.15);b.position.set(2,3,4);b.scale.setScalar(.8);
  relaxArms(a);relaxArms(b);
  for(const name of ['LeftArm','LeftForeArm','RightArm','RightForeArm']) {
    const expected=a.getObjectByName(name).quaternion.clone();
    assert(expected.angleTo(b.getObjectByName(name).quaternion)<1e-5, name+' follows the model');
    relaxArms(a);
    assert(expected.angleTo(a.getObjectByName(name).quaternion)<1e-5, name+' does not accumulate rotation');
  }
});

test('bone aiming supports non-Y bind axes and missing optional limbs', async () => {
  const { THREE, relaxArms } = await setup;
  const model=new THREE.Group(), arm=new THREE.Bone(), elbow=new THREE.Bone(), hand=new THREE.Bone();
  arm.name='LeftArm';elbow.name='LeftForeArm';hand.name='LeftHand';
  elbow.position.set(.3,0,0);hand.position.set(.25,0,0);model.add(arm);arm.add(elbow);elbow.add(hand);
  assert.doesNotThrow(()=>relaxArms(model));
  const p=elbow.getWorldPosition(new THREE.Vector3());
  assert(p.y<-.28 && p.x>.06, 'uses the real segment rather than a fixed local axis');
  assert.doesNotThrow(()=>relaxArms(new THREE.Group()));
});
