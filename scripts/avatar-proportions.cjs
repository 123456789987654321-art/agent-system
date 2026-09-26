// Shape the complete clothed character before mesh compression. Keeping this in
// the asset build preserves the same silhouette in the live model and poster.
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function createProportionMap(segments) {
  return point => {
    let [x, y, z] = point;
    // The head, face and hair are unchanged. The shoulders and upper torso are
    // narrower without scaling the character's height or reducing head size.
    const upper = smooth(.90, 1.23, y) * (1 - smooth(1.48, 1.55, y));
    let nearest, distance = Infinity;
    for (const [a, b] of segments) {
      const ab = b.map((v, k) => v - a[k]);
      const t = Math.max(0, Math.min(1, point.reduce((sum, v, k) => sum + (v - a[k]) * ab[k], 0) / ab.reduce((sum, v) => sum + v * v, 0)));
      const axis = a.map((v, k) => v + t * ab[k]);
      const d = Math.hypot(...point.map((v, k) => v - axis[k]));
      if (d < distance) { distance = d; nearest = axis; }
    }
    if (nearest) {
      const sleeve = .22 * smooth(.15, .23, Math.abs(x)) * smooth(.85, .99, y)
        * (1 - smooth(1.48, 1.55, y)) * (1 - smooth(.11, .16, distance));
      x += (nearest[0] - x) * sleeve;
      y += (nearest[1] - y) * sleeve;
      z += (nearest[2] - z) * sleeve;
    }
    x *= 1 - .17 * upper;
    z = .05 + (z - .05) * (1 - .12 * upper);
    return [x, y, z];
  };
}

function refineProportions(doc, THREE) {
  const root = doc.getRoot();
  const joints = [...new Set(root.listSkins().flatMap(s => s.listJoints()))];
  const oldWorld = new Map(joints.map(n => [n, new THREE.Matrix4().fromArray(n.getWorldMatrix())]));
  const findPoint = name => {
    const node = joints.find(n => n.getName() === name);
    if (!node) throw Error('Missing proportion anchor: ' + name);
    return new THREE.Vector3().setFromMatrixPosition(oldWorld.get(node)).toArray();
  };
  const segments = ['Left', 'Right'].flatMap(side => {
    const shoulder = findPoint(side + 'Arm'), elbow = findPoint(side + 'ForeArm'), wrist = findPoint(side + 'Hand');
    return [[shoulder, elbow], [elbow, wrist]];
  });
  const shape = createProportionMap(segments);
  const seen = new Set();
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || seen.has(mesh)) continue;
    seen.add(mesh);
    const world = new THREE.Matrix4().fromArray(node.getWorldMatrix());
    const inverse = world.clone().invert();
    const map = p => new THREE.Vector3(...shape(new THREE.Vector3(...p).applyMatrix4(world).toArray())).applyMatrix4(inverse).toArray();
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      const normal = primitive.getAttribute('NORMAL');
      const original = Array.from({ length: position.getCount() }, (_, i) => position.getElement(i, []));
      for (const target of primitive.listTargets()) {
        const delta = target.getAttribute('POSITION');
        if (!delta) continue;
        original.forEach((p, i) => {
          const d = delta.getElement(i, []), base = map(p), end = map(p.map((v, k) => v + d[k]));
          delta.setElement(i, end.map((v, k) => v - base[k]));
        });
      }
      original.forEach((p, i) => {
        position.setElement(i, map(p));
        if (!normal) return;
        // Transform the existing smooth normal by the local deformation
        // Jacobian, preserving UV seams and the untouched face's shading.
        const h = 1e-4, columns = [0, 1, 2].map(axis => {
          const low = p.slice(), high = p.slice();low[axis] -= h;high[axis] += h;
          const a = map(low), b = map(high);return b.map((v, k) => (v - a[k]) / (2 * h));
        });
        const jacobian = new THREE.Matrix3().fromArray(columns.flat());
        const n = new THREE.Vector3(...normal.getElement(i, [])).applyMatrix3(jacobian.invert().transpose()).normalize();
        normal.setElement(i, n.toArray());
      });
    }
  }

  // Move joint anchors with the same deformation and rebase inverse bind
  // matrices; shrinking only the jacket would reintroduce skin intersections.
  const newWorld = new Map(joints.map(node => {
    const matrix = oldWorld.get(node).clone();
    matrix.setPosition(new THREE.Vector3(...shape(new THREE.Vector3().setFromMatrixPosition(matrix).toArray())));
    return [node, matrix];
  }));
  for (const node of joints) {
    const parent = node.getParentNode();
    const parentWorld = newWorld.get(parent) || new THREE.Matrix4().fromArray(parent ? parent.getWorldMatrix() : new THREE.Matrix4().toArray());
    node.setMatrix(parentWorld.clone().invert().multiply(newWorld.get(node)).toArray());
  }
  for (const skin of root.listSkins()) {
    const before = skin.getInverseBindMatrices();
    const after = before.clone().setArray(new Float32Array(before.getArray()));
    skin.listJoints().forEach((node, i) => {
      const matrix = newWorld.get(node).clone().invert().multiply(oldWorld.get(node))
        .multiply(new THREE.Matrix4().fromArray(before.getElement(i, [])));
      after.setElement(i, matrix.toArray());
    });
    skin.setInverseBindMatrices(after);
  }
  console.log('Proportions refined:', { meshes: seen.size, joints: joints.length, shoulderWidthScale: .83, upperTorsoDepthScale: .88, maximumSleeveRadiusScale: .78 });
}

module.exports = { createProportionMap, refineProportions };
