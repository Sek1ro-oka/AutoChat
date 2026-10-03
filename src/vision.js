// Only QQ CDN images from an authenticated, whitelisted OneBot event are downloaded.
// No local paths, arbitrary URLs, files API uploads, or persistent image storage.
export const IMAGE_TOKEN_RESERVE = 2048; // Official image ceiling 1024 + conservative margin.
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export function imageUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 8192) throw new Error('IMAGE_URL');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !(url.hostname === 'qpic.cn' || url.hostname.endsWith('.qpic.cn')
      || url.hostname === 'multimedia.nt.qq.com.cn')) throw new Error('IMAGE_URL');
  return url.href;
}
export function imageData(bytes) {
  let mime;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) mime = 'image/gif';
  else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') mime = 'image/webp';
  if (!mime || bytes.length > MAX_IMAGE_BYTES) throw new Error('IMAGE_FORMAT_OR_SIZE');
  return `data:${mime};base64,${bytes.toString('base64')}`;
}
export async function loadImages(segments, call, fetchImage = fetch) {
  if (segments.length > MAX_IMAGES) throw new Error('IMAGE_COUNT');
  const images = [];
  for (const segment of segments) {
    let raw = segment.data?.url;
    if (!raw && typeof segment.data?.file === 'string' && /^[\w.-]{1,256}$/.test(segment.data.file)) {
      const resolved = await call('get_image', { file: segment.data.file });
      raw = resolved?.url;
    }
    let url = imageUrl(raw), response;
    const signal = AbortSignal.timeout(15000);
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await fetchImage(url, { redirect: 'manual', signal });
      if (![301,302,303,307,308].includes(response.status)) break;
      await response.body?.cancel();
      if (redirects === 3) throw new Error('IMAGE_REDIRECT');
      url = imageUrl(new URL(response.headers.get('location'), url).href);
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error('IMAGE_DOWNLOAD'); }
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
      await response.body?.cancel(); throw new Error('IMAGE_SIZE');
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) throw new Error('IMAGE_SIZE');
      chunks.push(chunk);
    }
    images.push(imageData(Buffer.concat(chunks)));
  }
  return images;
}
