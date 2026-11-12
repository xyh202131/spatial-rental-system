import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { demoRooms } from './demo-scenes.mjs';

const definitions = [
  {
    id: '3FO4K4VCF7LG', stem: 'meeting-room', title: '现代办公会议室', name: 'Modern Office Meeting Room',
    source: 'https://studio.aholo3d.com/viewer?projectId=3FO4K4VCF7LG', upAxis: 'Z', kind: '外部导入',
    // Platform share/v2 camera, in the original model's Z-up coordinates.
    initialView: { position: [2.09142, .78628504, -.14368024], target: [1.6183219, .8178654, -.13051295] },
    description: '从 Aholo 已完成项目导入，可移动查看会议室空间与不同角度的细节。',
    notice: '这是从 Aholo 导入的已有模型，不是本次拍摄的结果。平台任务已完成，空间完整性与重建质量仍需人工对照验收。',
    facts: [['模型名称', 'Modern Office Meeting Room'], ['项目编号', '3FO4K4VCF7LG'], ['平台状态', '已完成'], ['质量状态', '待人工验收']],
  },
  {
    id: '3FO4K4XNH9NX', stem: 'workbench', title: '硬件工程师工作台', name: '硬件工程师工作台',
    source: 'https://studio.aholo3d.cn/viewer?projectId=3FO4K4XNH9NX', upAxis: 'Z', kind: '历史重建',
    description: '桌面、隔板和工具箱可辨认；细小工具、人物和场景边缘存在明显失真。',
    notice: '此样例由 35 张已有照片重建，存在模糊、拖影与漂浮伪影，仅用于体验预览。它不是本次拍摄的结果，也未通过正式看房验收。',
    facts: [['输入', '35 张照片'], ['重建模式', '极速预览 / low'], ['平台处理时间', '约 4 分钟'], ['质量状态', '未验收']],
  },
  {
    id: 'ARCHIVE20260912', stem: 'room', title: '云谷魔搭会议室', name: '云谷魔搭会议室',
    upAxis: 'Y', rotationX: Math.PI, kind: '实验材料',
    initialView: { position: [.85, .52, .65], target: [.85, .58, -1] },
    description: '来自《20260912浙大群核实验》的轻量 3DGS 房间。',
    notice: '课程样例。家具比例为示意，房间未做实测标定。',
    facts: [['原始文件', 'yungu-meeting-lite.ply'], ['高斯点数', '99,650'], ['素材用途', '本地演示']],
  },
];

// Only catalog IDs and formats resolve to files; request paths never become filesystem paths.
export function createSampleCatalog(root, workbenchDir, demoDir) {
  const entries = demoDir ? [...definitions, ...demoRooms] : definitions;
  function asset(id, format) {
    const entry = entries.find(item => item.id === id);
    if (!entry || !['spz', 'ply'].includes(format)) return null;
    const dir = entry.kind === '合成样例' ? demoDir
      : entry.stem === 'workbench' && workbenchDir ? workbenchDir : join(root, entry.id);
    const name = `${entry.stem}.${format}`, path = join(dir, name);
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0 ? { path, name } : null;
  }
  function list() {
    return entries.filter(entry => entry.id !== 'ARCHIVE20260912' || asset(entry.id, 'ply')).map(({ stem, ...entry }) => {
      const assets = Object.fromEntries(['spz', 'ply'].map(format => [format,
        asset(entry.id, format) ? `/api/samples/${entry.id}/model.${format}` : null,
      ]));
      return { ...entry, available: Boolean(assets.spz || assets.ply), assets };
    });
  }
  return { list, asset };
}
