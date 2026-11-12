import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const demoRooms = [
  { id: 'DEMOLOUNGE', stem: 'demo-lounge', title: '合成演示 · 客厅', upAxis: 'Y', kind: '合成样例',
    initialView: { position: [0, 1.6, 2.3], target: [0, 1.1, -1.8] },
    description: '程序生成的客厅，可用于测试发布和浏览。', facts: [['素材来源', '程序生成'], ['用途', '本地流程演示']] },
  { id: 'DEMOBEDROOM', stem: 'demo-bedroom', title: '合成演示 · 卧室', upAxis: 'Y', kind: '合成样例',
    initialView: { position: [0, 1.6, 2.3], target: [0, 1.1, -1.8] },
    description: '程序生成的卧室，可与客厅组合验证多房间导览。', facts: [['素材来源', '程序生成'], ['用途', '本地流程演示']] },
];

export function demoPly(index = 0) {
  const points = [];
  const step = .075;
  function surface(center, axisU, axisV, length, width, color) {
    for (let u = 0; u <= length; u += step) {
      for (let v = 0; v <= width; v += step) {
        const point = [...center];
        point[axisU] += u;
        point[axisV] += v;
        const tint = Math.sin(u * 27 + v * 43) * 5;
        points.push([...point, ...color.map(channel => ((channel + tint) / 255 - .5) / .28209479)]);
      }
    }
  }
  const wall = index ? [174, 190, 217] : [211, 199, 174];
  const furniture = index ? [83, 125, 172] : [72, 128, 116];
  surface([-2, 0, -3], 0, 2, 4, 5.6, [170, 144, 109]);
  surface([-2, 0, -3], 0, 1, 4, 2.65, wall);
  surface([-2, 0, -3], 2, 1, 5.6, 2.65, wall);
  surface([2, 0, -3], 2, 1, 5.6, 2.65, wall);
  surface([-.85, .5, -2.4], 0, 2, 1.7, index ? 2 : .85, furniture);
  surface([-.85, .06, -1.55], 0, 1, 1.7, .44, furniture);
  surface([-.85, .5, -2.4], 0, 1, 1.7, .58, furniture);
  surface([-.65, 1.22, -2.92], 0, 1, 1.3, .8, [155, 184, 199]);

  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = Buffer.from(['ply', 'format binary_little_endian 1.0', `element vertex ${points.length}`,
    ...names.map(name => `property float ${name}`), 'end_header', ''].join('\n'));
  const vertices = Buffer.alloc(points.length * names.length * 4);
  let offset = 0;
  const size = Math.log(.042);
  for (const point of points) {
    for (const value of [...point, 2.2, size, size, size, 1, 0, 0, 0]) {
      vertices.writeFloatLE(value, offset);
      offset += 4;
    }
  }
  return Buffer.concat([header, vertices]);
}

export function prepareDemoScenes(dir) {
  mkdirSync(dir, { recursive: true });
  for (const [index, room] of demoRooms.entries()) {
    const path = join(dir, room.stem + '.ply');
    if (!existsSync(path)) writeFileSync(path, demoPly(index));
  }
  return dir;
}
