// pm2 部署配置。启动：pm2 start ecosystem.config.cjs
// 查看状态：pm2 status    日志：pm2 logs dafeiyu
// 保存开机自启：pm2 save（先执行 pm2 startup）
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
      max_memory_restart: '512M',

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
