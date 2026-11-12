import { Vector3, Spherical, MathUtils } from 'three';

// Movement uses model-relative units: reconstruction files do not establish a measured scale.
export function createNavigation(camera, controls, { center, distance, initialView }) {
  const origin = center.clone();
  const up = new Vector3(0, 1, 0);
  let mode = 'orbit';
  const minDistance = Math.min(Math.max(.05, distance * .025), initialView ? initialView.position.distanceTo(initialView.target) * .1 : Infinity);
  const maxDistance = distance * 5;
  controls.minDistance = minDistance;
  controls.maxDistance = maxDistance;

  function settle() {
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = damping;
  }
  function sync() { camera.lookAt(controls.target); controls.update(); }
  function setMode(value) {
    settle();
    mode = value;
    controls.enabled = mode !== 'walk';
  }
  function preset(value = 'overall') {
    settle();
    if (value === 'overall' && initialView) {
      camera.position.copy(initialView.position); controls.target.copy(initialView.target);
      sync(); return;
    }
    const directions = {
      overall: [.65, .38, .9], front: [0, .05, 1.2],
      side: [1.2, .05, 0], top: [0, 1.2, .001],
    };
    camera.position.copy(origin).add(new Vector3(...(directions[value] || directions.overall)).multiplyScalar(distance));
    controls.target.copy(origin);
    sync();
  }
  function reset() { setMode('orbit'); preset(); }
  function rotate(yaw, pitch) {
    settle();
    const offset = mode === 'walk' ? controls.target.clone().sub(camera.position) : camera.position.clone().sub(controls.target);
    const spherical = new Spherical().setFromVector3(offset);
    spherical.theta += mode === 'walk' ? yaw : -yaw;
    spherical.phi = MathUtils.clamp(spherical.phi - pitch, .015, Math.PI - .015);
    offset.setFromSpherical(spherical);
    if (mode === 'walk') controls.target.copy(camera.position).add(offset);
    else camera.position.copy(controls.target).add(offset);
    sync();
  }
  function translate(delta) {
    settle();
    camera.position.add(delta);
    controls.target.add(delta);
    sync();
  }
  function pan(dx, dy, height) {
    const scale = 2 * camera.position.distanceTo(controls.target) * Math.tan(MathUtils.degToRad(camera.fov / 2)) / Math.max(1, height);
    const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const vertical = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    translate(right.multiplyScalar(-dx * scale).addScaledVector(vertical, dy * scale));
  }
  function zoom(factor) {
    settle();
    const offset = camera.position.clone().sub(controls.target);
    const length = offset.length();
    if (mode === 'walk') {
      // Wheel/zoom buttons advance in the viewing direction without changing the look distance.
      translate(offset.normalize().multiplyScalar((factor - 1) * distance * .7));
    } else {
      offset.setLength(MathUtils.clamp(length * factor, minDistance, maxDistance));
      camera.position.copy(controls.target).add(offset);
      sync();
    }
  }
  function update(seconds, actions, speed = 1) {
    const dt = MathUtils.clamp(seconds, 0, .08);
    if (!dt || !actions.size) return;
    const axis = (positive, negative) => Number(actions.has(positive)) - Number(actions.has(negative));
    const forward = new Vector3(); camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < .000001) forward.set(0, 0, -1);
    forward.normalize();
    const right = forward.clone().cross(up).normalize();
    const move = forward.multiplyScalar(axis('forward', 'backward'))
      .addScaledVector(right, axis('right', 'left')).addScaledVector(up, axis('up', 'down'));
    if (move.lengthSq()) translate(move.normalize().multiplyScalar(distance * .55 * speed * dt));
    const yaw = axis('turn-left', 'turn-right'), pitch = axis('look-up', 'look-down');
    if (yaw || pitch) rotate(yaw * dt * .65, pitch * dt * .65);
    const dolly = axis('zoom-out', 'zoom-in');
    if (dolly) zoom(Math.exp(dolly * dt * 1.2));
  }
  reset();
  return { reset, preset, setMode, update, rotate, pan, zoom };
}
