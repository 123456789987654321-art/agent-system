const test = require('node:test');
const assert = require('node:assert/strict');
const { createProportionMap } = require('../scripts/avatar-proportions.cjs');

const segments = [-1, 1].flatMap(side => {
  const shoulder = [side * .173, 1.348, .05];
  const elbow = [side * .232, 1.109, .05];
  const wrist = [side * .256, .88, .05];
  return [[shoulder, elbow], [elbow, wrist]];
});
const shape = createProportionMap(segments);
const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-10));

test('proportion refinement preserves head, hair and lower body dimensions', () => {
  for (const y of [0, .5, .84, 1.55, 1.7, 1.82]) {
    for (const x of [-.3, 0, .3]) near(shape([x, y, -.08]), [x, y, -.08]);
  }
});

test('proportion refinement keeps both sides symmetric across transition regions', () => {
  for (let y = .85; y <= 1.6; y += .017) {
    for (const x of [.08, .16, .24, .32]) {
      const left = shape([x, y, -.04]), right = shape([-x, y, -.04]);
      assert.ok(left.every(Number.isFinite));
      near(left, [-right[0], right[1], right[2]]);
    }
  }
});

test('shoulders move inward without lowering them and torso remains centered', () => {
  const shoulder = segments[2][0];
  const result = shape(shoulder);
  assert.ok(result[0] < shoulder[0] * .9);
  assert.equal(result[1], shoulder[1]);
  near(shape([0, 1.3, .05]), [0, 1.3, .05]);
});
