const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// Overrides belong to the account, including when the source is a shared built-in sample.
export function createSampleSettings(store) {
  const find = store.db.prepare('SELECT * FROM sample_settings WHERE user_id=? AND sample_id=?');
  const save = store.db.prepare(`INSERT INTO sample_settings(user_id,sample_id,title,note,up_axis,revision) VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id,sample_id) DO UPDATE SET title=excluded.title,note=excluded.note,up_axis=excluded.up_axis,revision=excluded.revision
    WHERE sample_settings.revision=?`);
  function apply(sample, userId) {
    const setting = find.get(userId, sample.id);
    return {
      ...sample, title:setting?.title ?? sample.title, name:setting?.title ?? sample.name,
      note:setting?.note ?? sample.note ?? '', upAxis:setting?.up_axis ?? sample.upAxis,
      ...(sample.rotationX !== undefined && setting && setting.up_axis !== sample.upAxis ? { rotationX: undefined } : {}),
      settingsRevision:setting?.revision ?? 0,
    };
  }
  function update(sample, userId, data) {
    if (Object.keys(data).some(key => !['title', 'note', 'upAxis', 'revision'].includes(key))) fail(400, '仅支持修改案例名称、备注和模型向上方向。');
    if (typeof data.title !== 'string' || !data.title.trim() || data.title.trim().length > 80) fail(400, '请填写 1–80 个字的案例名称。');
    if (typeof data.note !== 'string' || data.note.length > 500) fail(400, '案例备注不能超过 500 个字。');
    if (!['Z', 'Y'].includes(data.upAxis)) fail(400, '请选择有效的模型向上方向。');
    if (!Number.isSafeInteger(data.revision) || data.revision < 0) fail(400, '设置版本无效，请重新打开编辑窗口。');
    const current = find.get(userId, sample.id);
    if ((current?.revision ?? 0) !== data.revision) fail(409, '案例已在其他页面修改，请重新打开编辑窗口后再保存。');
    const saved = save.run(userId, sample.id, data.title.trim(), data.note.trim(), data.upAxis, data.revision + 1, data.revision);
    if (!saved.changes) fail(409, '案例已在其他页面修改，请重新打开编辑窗口后再保存。');
    return apply(sample, userId);
  }
  return { apply, update };
}
