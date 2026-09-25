import http from 'node:http';
// 临时 mock 视觉大模型：返回固定识别结果（E2E 验证用，验证完即停）
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const auth = req.headers.authorization || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                trades: [
                  {
                    code: '110020',
                    name: '演示沪深300联接A',
                    type: '买入',
                    amount: 500,
                    shares: 265,
                    date: '2026-08-30',
                  },
                  {
                    code: '161017',
                    name: '演示中证500',
                    type: 'sell',
                    shares: 100,
                    amount: null,
                    date: '2026-08-29',
                  },
                ],
              }),
            },
          },
        ],
        __echoAuth: auth,
      }),
    );
  });
});
server.listen(8125, () => console.log('mock llm up on 8125'));
