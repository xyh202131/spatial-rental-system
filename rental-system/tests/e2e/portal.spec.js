import { test, expect } from '@playwright/test';

test('材料包空间从房东发布到租客看房、家具试摆和预约回执', async ({ page, browser }, info) => {
  test.setTimeout(90_000);
  const title = '双端联调测试 · 云谷空间';
  await page.goto('/cover/');
  await expect(page.locator('.art img')).toHaveJSProperty('complete', true);
  await page.getByRole('link', { name: '房东采集台', exact: true }).click();
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
  await page.getByRole('button', { name: '房源与预约', exact: true }).click();
  const room = page.getByLabel('空间成果');
  await room.selectOption('sample-ARCHIVE20260912');
  await page.getByLabel('房源名称').fill(title);
  await page.getByLabel('片区').fill('课程样例');
  await page.getByLabel('月租（元）').fill('3200');
  await page.getByLabel('面积（㎡）').fill('42');
  await page.getByRole('button', { name: '发布到租客端' }).click();
  await expect(page.locator('#publish-status')).toContainText('房源已发布');
  const tenantUrl = await page.getByRole('link', { name: '租客视角' }).getAttribute('href');

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
    const requested = new Date(Date.now() + 33 * 3600_000).toISOString().slice(0, 16);
    await tenant.getByLabel('希望看房时间（北京时间）').fill(requested);
    await tenant.getByRole('button', { name: '提交预约' }).click();
    await expect(tenant.locator('#viewing-status')).toContainText('预约已提交');
    await tenant.getByRole('link', { name: '查看预约回执' }).click();
    await expect(tenant.getByRole('status')).toHaveText('待房东确认');
    await page.getByRole('button', { name: '房源与预约', exact: true }).click();
    await page.getByRole('button', { name: '确认看房' }).click();
    await expect(page.locator('#viewing-list')).toContainText('房东已确认');
    await tenant.getByRole('link', { name: '刷新预约状态' }).click();
    await expect(tenant.getByRole('status')).toHaveText('房东已确认');
    await page.getByRole('button', { name: '下架', exact: true }).click();
    await tenant.goto(tenantUrl);
    await expect(tenant.getByRole('alert')).toHaveText('房源已下架或不存在。');
  } finally {
    await tenantContext.close();
  }
});
