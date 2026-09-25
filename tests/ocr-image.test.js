import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTileRegions } from '../js/ocr-image.js';

// ---- 长截图切块几何 ----

test('computeTileRegions：不超过 maxHeight 的图返回整图单块', () => {
  assert.deepEqual(computeTileRegions(1080, 1000), [{ x: 0, y: 0, w: 1080, h: 1000 }]);
  assert.deepEqual(computeTileRegions(1080, 2200, { maxHeight: 2200 }), [
    { x: 0, y: 0, w: 1080, h: 2200 },
  ]);
});

test('computeTileRegions：长图切多块、相邻重叠 ≥100px、最后一块贴底', () => {
  const regions = computeTileRegions(1080, 8000, { maxHeight: 2200, overlap: 0.15 });
  assert.ok(regions.length > 1);
  // 每块全宽、高度不超过 maxHeight
  for (const r of regions) {
    assert.equal(r.x, 0);
    assert.equal(r.w, 1080);
    assert.ok(r.h > 0 && r.h <= 2200);
  }
  // 相邻块重叠 ≥100px
  for (let i = 1; i < regions.length; i++) {
    const prevEnd = regions[i - 1].y + regions[i - 1].h;
    assert.ok(prevEnd - regions[i].y >= 100, `第 ${i} 块重叠不足`);
  }
  // 最后一块贴底
  const last = regions[regions.length - 1];
  assert.equal(last.y + last.h, 8000);
});

test('computeTileRegions：非法尺寸返回空数组', () => {
  assert.deepEqual(computeTileRegions(0, 100), []);
  assert.deepEqual(computeTileRegions(100, -1), []);
  assert.deepEqual(computeTileRegions(NaN, 100), []);
});
