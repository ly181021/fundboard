import http from 'node:http';
// 临时 mock 文本模型：返回固定 AI 解读文本（E2E 验证用，验证完即停）
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '今日组合小幅回撤，主因医疗持仓走弱；集中度尚可，建议保持定投节奏。（mock）',
            },
          },
        ],
      }),
    );
  });
});
server.listen(8125, () => console.log('text mock up on 8125'));
