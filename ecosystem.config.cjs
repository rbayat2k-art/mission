module.exports = {
  apps: [{
    name: "rahkar-taprasystem",
    script: "app.cjs",
    cwd: __dirname,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    max_memory_restart: "600M",
    env: {
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: "3000",
    },
  }],
};
