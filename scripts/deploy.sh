#!/usr/bin/env bash
set -e

# ==============================================================================
# Garment ERP Production Deployment Script
# ==============================================================================
# Usage:
#   npm run deploy:prod
#   ./scripts/deploy.sh
# ==============================================================================

PROD_USER="${PROD_USER:-ubuntu}"
PROD_HOST="${PROD_HOST:-98.93.252.153}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/garments-erp}"

# Locate SSH Key
KEY_CANDIDATES=(
  "${PROD_SSH_KEY}"
  "${HOME}/Downloads/Beta-College.pem"
  "./Beta-College.pem"
  "${HOME}/.ssh/Beta-College.pem"
  "/Users/poonthamil/Downloads/Beta-College.pem"
)

SSH_KEY=""
for k in "${KEY_CANDIDATES[@]}"; do
  if [ -n "$k" ] && [ -f "$k" ]; then
    SSH_KEY="$k"
    break
  fi
done

if [ -z "$SSH_KEY" ]; then
  echo "❌ Error: Could not find Beta-College.pem SSH key."
  echo "Please place Beta-College.pem in ~/Downloads/ or set PROD_SSH_KEY=/path/to/key.pem"
  exit 1
fi

chmod 400 "$SSH_KEY" 2>/dev/null || true

echo "🚀 Deploying Garment ERP to ${PROD_USER}@${PROD_HOST}..."
echo "🔑 Using SSH Key: ${SSH_KEY}"

# 1. Sync local codebase to remote server (excluding node_modules, .git, and server/.env)
echo "📦 1/4 Syncing codebase to remote server..."
rsync -avz --delete \
  -e "ssh -o StrictHostKeyChecking=no -i ${SSH_KEY}" \
  --exclude "node_modules" \
  --exclude ".git" \
  --exclude "*.log" \
  --exclude ".DS_Store" \
  --exclude "server/.env" \
  --exclude "dist" \
  ./ "${PROD_USER}@${PROD_HOST}:${REMOTE_DIR}/"

# 2. Run remote installation, database seeding, and PM2 reload
echo "⚙️  2/4 Updating dependencies, database seeds, and restarting services..."
ssh -o StrictHostKeyChecking=no -i "${SSH_KEY}" "${PROD_USER}@${PROD_HOST}" bash << 'REMOTE_SCRIPT'
  set -e
  cd /home/ubuntu/garments-erp

  # Ensure server .env exists with production DB settings
  if [ ! -f server/.env ]; then
    echo "Creating server/.env for production..."
    cat << 'EOF' > server/.env
PORT=4000
NODE_ENV=production
CORS_ORIGIN=*

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=crm_user
DB_PASSWORD=crm123
DB_NAME=garment_erp
DB_CONNECTION_LIMIT=15

JWT_ACCESS_SECRET=garments-erp-jwt-access-secret-2026-prod
JWT_REFRESH_SECRET=garments-erp-jwt-refresh-secret-2026-prod
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
BCRYPT_ROUNDS=10

SEED_ADMIN_USERNAME=admin
SEED_ADMIN_PASSWORD=Admin@123
EOF
  fi

  # Install any newly added dependencies
  echo "Installing server & web packages..."
  (cd server && npm install --prefer-offline --no-audit)
  (cd web && npm install --prefer-offline --no-audit)

  # Apply database schema updates & idempotent seeds
  echo "Applying database seeds and configuration updates..."
  (cd server && npm run db:seed)

  # Ensure PM2 ecosystem configuration exists
  if [ ! -f ecosystem.config.cjs ]; then
    cat << 'EOF' > ecosystem.config.cjs
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
EOF
  fi

  # Reload services via PM2
  echo "Restarting applications with PM2..."
  pm2 startOrRestart ecosystem.config.cjs
  pm2 save
REMOTE_SCRIPT

# 3. Verify Health Check
echo "🔍 3/4 Running health checks..."
sleep 3
API_STATUS=$(ssh -o StrictHostKeyChecking=no -i "${SSH_KEY}" "${PROD_USER}@${PROD_HOST}" "curl -s http://127.0.0.1:4000/api/health || echo 'FAILED'")
WEB_STATUS=$(ssh -o StrictHostKeyChecking=no -i "${SSH_KEY}" "${PROD_USER}@${PROD_HOST}" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/ || echo '000'")

echo "✅ 4/4 Deployment completed successfully!"
echo "--------------------------------------------------------"
echo "🌐 Web Application: http://${PROD_HOST}:5173"
echo "🔌 API Health Check: ${API_STATUS}"
echo "📄 Web HTTP Status:  ${WEB_STATUS}"
echo "👤 Demo Admin:       admin / Admin@123"
echo "--------------------------------------------------------"
