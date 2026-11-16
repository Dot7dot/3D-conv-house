'use strict';

const { createApp } = require('./app');

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '0.0.0.0';

let app;
try {
  app = createApp();
} catch (err) {
  console.error('❌ 啟動失敗：', err.message);
  process.exit(1);
}

const server = app.listen(port, host, () => {
  console.log(`🏠 3D-conv-house 已啟動：http://localhost:${port}`);
  for (const c of app.locals.converters) {
    console.log(`   ${c.icon} ${c.name}（${c.id}）：${c.endpoint || '尚未上線'}`);
  }
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
