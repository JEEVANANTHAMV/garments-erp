module.exports = {
  apps: [
    {
      name: 'garments-erp-api',
      cwd: '/home/ubuntu/garments-erp/server',
      script: 'npx',
      args: 'tsx src/index.ts',
      env: {
        NODE_ENV: 'production',
        PORT: 4000
      },
      max_memory_restart: '500M'
    },
    {
      name: 'garments-erp-web',
      cwd: '/home/ubuntu/garments-erp/web',
      script: 'npm',
      args: 'run dev -- --host 0.0.0.0 --port 5173',
      env: {
        NODE_ENV: 'production'
      },
      max_memory_restart: '500M'
    }
  ]
};
