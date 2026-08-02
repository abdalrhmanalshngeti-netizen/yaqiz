module.exports = {
  apps: [{
    name:         'yaqiz-backend',
    script:       'src/app.js',
    instances:    'max',
    exec_mode:    'cluster',
    watch:        false,
    max_memory_restart: '500M',

    env_production: {
      NODE_ENV:    'production',
      PORT:        3000,
    },

    // Logs
    out_file:  './logs/pm2-out.log',
    error_file: './logs/pm2-err.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',

    // Restart policy
    restart_delay: 3000,
    max_restarts:  10,
    min_uptime:    '5s',
  }]
};
