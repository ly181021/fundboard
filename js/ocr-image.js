/**
 * 截图预处理：长截图切块、超大图压缩，零依赖 Canvas 实现。
 * computeTileRegions 为纯函数（node 可测）；prepareOcrImage 依赖浏览器 Image/Canvas，
 * 在页面里调用。切块后每块 JPEG 远小于服务端 9MB 请求上限。
 */

/**
 * 纵向切块区域（全宽、自上而下；相邻块重叠 ≥100px，最后一块贴底）。
 * 高度不超过 maxHeight 时返回整图单块；非法尺寸返回空数组。
 */
export function computeTileRegions(width, height, { maxHeight = 2200, overlap = 0.15 } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  if (height <= maxHeight) return [{ x: 0, y: 0, w: width, h: height }];
  // 步长 = 块高 × (1-重叠率)，且保证重叠至少 100px（跨块接缝处信息不丢）
  const step = Math.max(1, Math.round(Math.min(maxHeight * (1 - overlap), maxHeight - 100)));
  const regions = [];
  for (let y = 0; y < height; y += step) {
    regions.push({ x: 0, y, w: width, h: Math.min(maxHeight, height - y) });
  }
  return regions;
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

function regionToJpeg(img, region, quality = 0.85) {
  const canvas = document.createElement('canvas');
  canvas.width = region.w;
  canvas.height = region.h;
  canvas
    .getContext('2d')
    .drawImage(img, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * 预处理一张截图 → 返回 1..n 个 dataUrl（顺序自上而下）：
 * 首先看高度：超过 maxHeight → 按 computeTileRegions 切块，每块 JPEG；
 * 其次看体积：单图但 dataUrl 超过 maxBytes（base64 膨胀可能撞服务端 9MB 上限）→ 重编码为 JPEG；
 * 否则原样返回。
 */
export async function prepareOcrImage(
  dataUrl,
  { maxHeight = 2200, maxBytes = 6 * 1024 * 1024 } = {},
) {
  const img = await loadImage(dataUrl);
  const { naturalWidth: w, naturalHeight: h } = img;
  const regions = computeTileRegions(w, h, { maxHeight });
  if (regions.length > 1) return regions.map((r) => regionToJpeg(img, r));
  if (dataUrl.length > maxBytes) return [regionToJpeg(img, { x: 0, y: 0, w, h })];
  return [dataUrl];
}
