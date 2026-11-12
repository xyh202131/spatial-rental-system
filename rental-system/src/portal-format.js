export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

export const viewingStatus = { pending: '待房东确认', confirmed: '房东已确认', declined: '房东已婉拒' };
export const viewingTime = value => String(value).replace('T', ' ') + '（北京时间）';
