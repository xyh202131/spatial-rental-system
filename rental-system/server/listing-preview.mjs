export const MAX_PREVIEW_BYTES = 192 * 1024;

function invalidPhoto() {
  throw Object.assign(new Error('请上传有效的 JPEG 实拍图，单张不超过 192 KiB，长边不超过 1280 像素。'), { status: 422 });
}

export function previewJpeg(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_PREVIEW_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) invalidPhoto();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_PREVIEW_BYTES || bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) invalidPhoto();
  const parts = [bytes.subarray(0, 2)];
  let offset = 2, hasDimensions = false;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1], length = bytes.readUInt16BE(offset + 2), end = offset + 2 + length;
    if (length < 2 || end > bytes.length) invalidPhoto();
    if (marker === 0xc0) {
      if (hasDimensions || length < 11 || bytes[offset + 4] !== 8) invalidPhoto();
      const height = bytes.readUInt16BE(offset + 5), width = bytes.readUInt16BE(offset + 7);
      if (!width || !height || width > 1280 || height > 1280) invalidPhoto();
      hasDimensions = true;
    }
    if (marker === 0xda) {
      if (!hasDimensions) invalidPhoto();
      // 预览只接受浏览器导出的单扫描 JPEG，APP 和评论段不会写入公开文件。
      for (let markerAt = bytes.indexOf(0xff, end); markerAt >= 0; markerAt = bytes.indexOf(0xff, markerAt + 2)) {
        const next = bytes[markerAt + 1];
        if (next === 0xd9 && markerAt + 2 === bytes.length) {
          parts.push(bytes.subarray(offset));
          return Buffer.concat(parts);
        }
        if (next !== 0 && !(next >= 0xd0 && next <= 0xd7)) invalidPhoto();
      }
      invalidPhoto();
    }
    if ([0xc0, 0xc4, 0xdb, 0xdd].includes(marker)) parts.push(bytes.subarray(offset, end));
    else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) invalidPhoto();
    offset = end;
  }
  invalidPhoto();
}
