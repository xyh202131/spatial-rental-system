import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

async function verifyLandlord(page) {
  await page.getByLabel('密码', { exact: true }).fill('browser-test-only-123');
  await page.getByRole('button', { name: '登录并继续' }).click();
  await expect(page.locator('.topbar')).toBeVisible();
  await page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    const result = await fetch('/api/verification/reset', { method: 'POST', headers: { 'X-CSRF-Token': session.csrf } });
    if (!result.ok) throw new Error('测试账户核验状态未能重置。');
  });
  await page.reload();
  await page.getByRole('button', { name: '用户中心', exact: true }).click();
  for (const side of ['front', 'back', 'property']) {
    await page.locator(`[data-action="id-example"][data-side="${side}"]`).click();
  }
  await page.locator('[data-action="id-check"]').click();
  await expect(page.locator('#verification-status')).toContainText('已通过');
}

test('材料包空间从房东发布到租客看房、家具试摆和预约回执', async ({ page, browser }, info) => {
  const project = join(import.meta.dirname, '../..');
  test.skip(!existsSync(join(project, 'outputs/aholo/ARCHIVE20260912/room.ply')) ||
    !existsSync(join(project, 'materials/furniture/plant.glb')) ||
    !existsSync(join(project, 'materials/furniture/plant.usdz')), '需要本地材料包模型');
  test.setTimeout(90_000);
  const title = '双端联调测试 · 云谷空间';
  await page.goto('/cover/');
  await expect(page.locator('.art img')).toHaveJSProperty('complete', true);
  await page.getByRole('link', { name: '房东采集台', exact: true }).click();
  await verifyLandlord(page);
  await page.getByRole('button', { name: '房源与预约', exact: true }).click();
  const room = page.getByRole('combobox', { name: '空间成果', exact: true });
  await room.selectOption('sample-ARCHIVE20260912');
  await page.getByLabel('房源名称').fill(title);
  await page.getByLabel('片区').fill('课程样例');
  await page.getByLabel('月租（元）').fill('3200');
  await page.getByLabel('面积（㎡）').fill('42');
  await page.getByLabel('已验收入口视角、画面和公开内容').check();
  await page.getByRole('button', { name: '发布到租客端' }).click();
  await expect(page.locator('#publish-status')).toContainText('房源已发布');
  const tenantUrl = await page.getByRole('link', { name: '租客视角' }).getAttribute('href');
  const requested = new Date(Date.now() + 33 * 3600_000).toISOString().slice(0, 16);
  await page.getByLabel('新看房时段（北京时间）').fill(requested);
  await page.getByRole('button', { name: '开放 30 分钟时段' }).click();
  await expect(page.locator('#publish-status')).toContainText('已开放');

  const tenantContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4328', viewport: { width: 1240, height: 900 } });
  try {
    const tenant = await tenantContext.newPage();
    await tenant.goto('/tenant');
    await expect(tenant.getByRole('link', { name: title })).toBeVisible();
    await tenant.getByRole('link', { name: title }).click();
    await expect(tenant).toHaveURL(new RegExp(tenantUrl.replace('?', '\\?') + '$'));
    await expect(tenant.locator('#furnishing-viewer-status')).toContainText('房间已载入');
    await expect(tenant.locator('.viewer-viewport canvas')).toBeVisible();
    await tenant.locator('.viewer-viewport canvas').screenshot({ path: info.outputPath('archive-room.png') });
    await tenant.getByRole('button', { name: '添加', exact: true }).first().click();
    await expect(tenant.locator('#furnishing-count')).toHaveText('1');
    await tenant.getByRole('button', { name: '保存布局', exact: true }).click();
    await expect(tenant.locator('#layout-save-status')).toContainText('已保存');
    await tenant.reload();
    await expect(tenant.locator('#furnishing-count')).toHaveText('1');
    await expect(tenant.getByRole('link', { name: '下载 盆栽 USDZ' })).toBeVisible();

    await tenant.getByLabel('称呼').fill('测试租客');
    await tenant.getByLabel('联系方式').fill('test@example.invalid');
    await tenant.getByLabel('希望看房时间（北京时间）').selectOption(requested);
    await tenant.getByRole('button', { name: '提交预约' }).click();
    await expect(tenant.locator('#viewing-status')).toContainText('预约已提交');
    await tenant.getByRole('link', { name: '查看预约回执' }).click();
    await expect(tenant.locator('#receipt-status')).toHaveText('待房东确认');
    await page.getByRole('button', { name: '房源与预约', exact: true }).click();
    await page.getByRole('button', { name: '确认看房' }).click();
    await expect(page.locator('#viewing-list')).toContainText('房东已确认');
    await tenant.getByRole('button', { name: '刷新预约状态' }).click();
    await expect(tenant.locator('#receipt-status')).toHaveText('房东已确认');
    await page.getByRole('button', { name: '下架', exact: true }).click();
    await tenant.goto(tenantUrl);
    await expect(tenant.getByRole('alert')).toHaveText('房源已下架或不存在。');
  } finally {
    await tenantContext.close();
  }
});

test('两房导览和实拍图在三维加载失败时仍可完成预约', async ({ page, browser }) => {
  await page.goto('/landlord');
  await verifyLandlord(page);
  await page.getByRole('button', { name: '房源与预约', exact: true }).click();
  await page.getByRole('combobox', { name: '空间成果', exact: true }).selectOption('sample-DEMOLOUNGE');
  await page.getByLabel('其他空间成果').selectOption('sample-DEMOBEDROOM');
  await page.getByRole('button', { name: '加入房间' }).click();
  await page.getByLabel('房源名称').fill('合成两房联调');
  await page.getByLabel('片区').fill('测试片区');
  await page.getByLabel('月租（元）').fill('3200');
  await page.getByLabel('面积（㎡）').fill('45');
  await page.getByLabel('未采集区域说明').fill('厨房和阳台尚未采集');
  const rooms = page.locator('.listing-room');
  await rooms.nth(0).getByLabel('房间名称').fill('客厅');
  await rooms.nth(1).getByLabel('房间名称').fill('卧室');
  await rooms.nth(1).getByLabel('采集覆盖').selectOption('partial');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const context = canvas.getContext('2d');
    context.fillStyle = '#5193b0';
    context.fillRect(0, 0, 16, 16);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await rooms.nth(1).getByLabel('公开实拍图（可选）').setInputFiles({
    name: 'test-photo.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64'),
  });
  await rooms.nth(1).getByLabel('确认所选实拍图可公开').check();
  for (const room of await rooms.all()) await room.getByLabel('已验收入口视角、画面和公开内容').check();
  await page.getByRole('button', { name: '发布到租客端' }).click();
  await expect(page.locator('#publish-status')).toContainText('房源已发布');
  const link = page.locator('#published-list article').filter({ hasText: '合成两房联调' }).getByRole('link', { name: '租客视角' });
  const tenantUrl = await link.getAttribute('href');
  const requested = new Date(Date.now() + 35 * 3600_000).toISOString().slice(0, 16);
  await page.getByLabel('安排房源').selectOption({ label: '合成两房联调' });
  await page.getByLabel('新看房时段（北京时间）').fill(requested);
  await page.getByRole('button', { name: '开放 30 分钟时段' }).click();
  await expect(page.locator('#publish-status')).toContainText('已开放');

  const mobile = await browser.newContext({ baseURL: 'http://127.0.0.1:4328', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const tenant = await mobile.newPage();
    const listingId = new URL(tenantUrl, 'http://127.0.0.1:4328').searchParams.get('id');
    const response = await tenant.request.get(`/api/portal/listings/${listingId}`);
    const { listing } = await response.json();
    await tenant.route('**' + listing.spaces[1].modelUrl, route => route.abort());
    await tenant.goto(tenantUrl);
    await expect(tenant.getByText('厨房和阳台尚未采集')).toBeVisible();
    await expect(tenant.getByRole('img', { name: '卧室实拍图' })).toHaveJSProperty('naturalWidth', 16);
    await expect(tenant.locator('#tenant-furnishing canvas')).toHaveCount(0);
    await tenant.getByRole('button', { name: '查看三维 · 客厅' }).click();
    await expect(tenant.locator('#furnishing-viewer-status')).toContainText('房间已载入');
    await tenant.getByRole('button', { name: '查看三维 · 卧室' }).click();
    await expect(tenant.getByText('三维房间暂时无法加载。仍可查看上方实拍图和提交预约。')).toBeVisible();
    await expect(tenant.getByRole('img', { name: '卧室实拍图' })).toHaveJSProperty('naturalWidth', 16);
    await tenant.getByLabel('称呼').fill('测试访客');
    await tenant.getByLabel('联系方式').fill('portable@example.invalid');
    await tenant.getByLabel('希望看房时间（北京时间）').selectOption(requested);
    await tenant.getByRole('button', { name: '提交预约' }).click();
    await tenant.getByRole('link', { name: '查看预约回执' }).click();
    await expect(tenant.locator('#receipt-status')).toHaveText('待房东确认');
    await tenant.getByRole('button', { name: '取消预约' }).click();
    await expect(tenant.locator('#receipt-status')).toHaveText('预约已取消');
  } finally {
    await mobile.close();
  }
});
