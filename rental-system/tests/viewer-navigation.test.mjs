import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { createNavigation } from '../src/viewer-navigation.js';

function fixture(options = {}) {
  const camera = new PerspectiveCamera(55, 1, .01, 1000);
  const controls = { target: new Vector3(), enabled: true, enableDamping: true, update() { camera.lookAt(this.target); } };
  const navigation = createNavigation(camera, controls, { center: new Vector3(1, 2, 3), distance: 4, ...options });
  return { camera, controls, navigation };
}
const near = (a, b) => assert.ok(a.distanceTo(b) < 1e-7, `${a.toArray()} != ${b.toArray()}`);

test('an imported initial view survives movement and presets without being pushed outside by the zoom limit', () => {
  const initialView = { position: new Vector3(2.09142, -.14368024, -.78628504), target: new Vector3(1.6183219, -.13051295, -.8178654) };
  const { camera, controls, navigation } = fixture({ distance:25, initialView });
  near(camera.position, initialView.position); near(controls.target, initialView.target);
  assert.ok(controls.minDistance < camera.position.distanceTo(controls.target));
  const heading = camera.quaternion.clone();
  navigation.setMode('walk'); navigation.update(.05, new Set(['forward', 'up'])); navigation.rotate(.7, -.2);
  navigation.preset('top'); navigation.reset();
  near(camera.position, initialView.position); near(controls.target, initialView.target);
  assert.ok(camera.quaternion.angleTo(heading) < 1e-7);
  assert.equal(controls.enabled, true);
  navigation.zoom(.5); assert.ok(camera.position.distanceTo(controls.target) < initialView.position.distanceTo(initialView.target));
});

test('WASD translates eye and target together, stays level and normalizes diagonal movement', () => {
  const { camera, controls, navigation } = fixture();
  const eye = camera.position.clone(), target = controls.target.clone();
  navigation.update(.05, new Set(['forward']));
  const delta = camera.position.clone().sub(eye);
  near(controls.target.clone().sub(target), delta);
  assert.equal(delta.y, 0);
  navigation.reset(); navigation.update(.05, new Set(['forward', 'right']));
  assert.ok(Math.abs(camera.position.distanceTo(eye) - delta.length()) < 1e-7);
  navigation.update(.05, new Set(['up'])); assert.ok(camera.position.y > eye.y);
});

test('orbit turns around target; free roam turns without moving the eye', () => {
  const { camera, controls, navigation } = fixture();
  const eye = camera.position.clone(), target = controls.target.clone();
  const distance = eye.distanceTo(target);
  navigation.rotate(.3, .1);
  near(controls.target, target);
  assert.ok(camera.position.distanceTo(eye) > .1);
  assert.ok(Math.abs(camera.position.distanceTo(target) - distance) < 1e-7);
  navigation.setMode('walk'); const standing = camera.position.clone();
  navigation.rotate(.3, .1); near(camera.position, standing);
  assert.equal(controls.enabled, false);
  assert.ok(controls.target.distanceTo(target) > .1);
});

test('presets and reset recover from movement; zoom is bounded and empty input cannot drift', () => {
  const { camera, controls, navigation } = fixture();
  const eye = camera.position.clone(), target = controls.target.clone(), heading = camera.quaternion.clone();
  navigation.preset('side'); navigation.update(.05, new Set(['left', 'up'])); navigation.setMode('walk');
  navigation.rotate(.7, .3); navigation.zoom(.5);
  navigation.reset(); near(camera.position, eye); near(controls.target, target);
  assert.ok(camera.quaternion.angleTo(heading) < 1e-7);
  assert.equal(controls.enabled, true);
  navigation.zoom(.00001);
  assert.ok(Math.abs(camera.position.distanceTo(target) - controls.minDistance) < 1e-7);
  navigation.zoom(1e8);
  assert.ok(Math.abs(camera.position.distanceTo(target) - controls.maxDistance) < 1e-7);
  navigation.preset('top'); assert.ok(camera.position.y > controls.target.y + 4);
  const paused = camera.position.clone(); navigation.update(.05, new Set()); near(camera.position, paused);
  assert.ok(camera.quaternion.toArray().every(Number.isFinite));
});
