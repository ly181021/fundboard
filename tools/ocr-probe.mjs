/**
 * OCR 识别探测（真实截图 + 真实模型）：直接调 lib/ocr.js 客户端识别本地截图并打印结果，
 * 排查"识别不到/识别错"类问题、验证提示词改动的效果。不写任何数据。
 *
 * 用法：node tools/ocr-probe.mjs [图片路径]   （默认 Screenshot_20260830_225637.jpg）
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadOcrConfig, createOcrClient } from '../lib/ocr.js';

const path = process.argv[2] ?? 'Screenshot_20260830_225637.jpg';
const config = await loadOcrConfig({
  configPath: fileURLToPath(new URL('../ocr.config.json', import.meta.url)),
});
if (!config) {
  console.error('未配置模型（ocr.config.json 无有效三要素）');
  process.exit(1);
}
const buf = await readFile(new URL(`../${path}`, import.meta.url));
console.log(`识别图片：${path}（${(buf.length / 1024).toFixed(0)}KB，模型 ${config.model}）`);
const client = createOcrClient({ config });
const r = await client.extract(`data:image/jpeg;base64,${buf.toString('base64')}`);
console.log(JSON.stringify(r, null, 2));
