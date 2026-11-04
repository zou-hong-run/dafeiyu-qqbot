// pm2 部署配置。启动：pm2 start ecosystem.config.cjs
// 查看状态：pm2 status    日志：pm2 logs dafeiyu
// 保存开机自启：pm2 save（先执行 pm2 startup）
const os = require('node:os')

function heapFor(totalMB) {
  if (totalMB < 2300) return 320
  if (totalMB < 5000) return 512
  if (totalMB < 11000) return 768
  return 1024
}

module.exports = {
  apps: [
    {
      name: 'dafeiyu',
      script: 'src/index.js',
      cwd: __dirname,

      // QQ 机器人同一 AppID 只能有一个连接，多实例会互相踢下线，必须 fork 单实例
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      watch: false,

      // 2C2G 机器：主进程堆压到 320M，整体 RSS 超 420M 就重启，别等系统 OOM
      // 堆上限按机器内存定，和 src/ops/budget.js 的档位保持一致：
      // <2.3G→320 / <5G→512 / <11G→768 / 更大→1024。环境变量显式设了优先。
      node_args: [`--max-old-space-size=${Number(process.env.MAIN_HEAP_MB || heapFor(os.totalmem() / 1048576))}`],
      max_memory_restart: process.env.MAX_RSS || '420M',

      // 防重启抖动：30 秒内挂掉不算启动成功，连续失败用指数退避
      min_uptime: '30s',
      max_restarts: 15,
      exp_backoff_restart_delay: 200,

      // 等应用发出 ready 信号才算启动成功（连上 QQ 网关后才会发）
      wait_ready: true,
      listen_timeout: 60000,

      // 留足时间优雅退出：落盘记忆、关闭 MCP 子进程、断开 QQ 连接
      kill_timeout: 10000,

      time: true,
      merge_logs: true,
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
