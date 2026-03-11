#!/usr/bin/env bash
set -euo pipefail

SSH_KEY="/Users/shashanksrivastava/Documents/projects/sparky/avani/naturalkey.pem"
SERVER_USER="azureuser"
SERVER_IP="98.70.32.0"
SERVER_PATH="/home/azureuser/projects/PicTinder/website"
DOMAIN="pictinder.com"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SSH_CMD="ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no ${SERVER_USER}@${SERVER_IP}"

echo "==> Deploying PicTinder website to ${SERVER_USER}@${SERVER_IP}:${SERVER_PATH}"

# Ensure remote directory exists
$SSH_CMD "mkdir -p ${SERVER_PATH}"

# Sync website files (exclude deploy.sh itself)
rsync -avz --delete \
  --exclude='deploy.sh' \
  -e "ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no" \
  "${SCRIPT_DIR}/" \
  "${SERVER_USER}@${SERVER_IP}:${SERVER_PATH}/"

echo "==> Files synced."

# Only set up nginx if the config doesn't exist yet (first deploy)
$SSH_CMD << 'REMOTE_SETUP'
set -euo pipefail

DOMAIN="pictinder.com"
WEB_ROOT="/home/azureuser/projects/PicTinder/website"
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}"

if [ -f "$NGINX_CONF" ]; then
  echo "==> nginx config already exists — skipping config write (preserves SSL)."
  echo "    Reloading nginx to pick up new files..."
  sudo nginx -t 2>&1 && sudo systemctl reload nginx
else
  echo "==> First deploy — writing nginx config..."

  if ! command -v nginx &>/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq nginx
  fi
  if ! command -v certbot &>/dev/null; then
    sudo apt-get install -y -qq certbot python3-certbot-nginx
  fi

  sudo tee "$NGINX_CONF" > /dev/null << NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN};

    root ${WEB_ROOT};
    index index.html;

    location / {
        try_files \$uri \$uri.html \$uri/ =404;
    }

    location ~* \.(css|js|jpg|jpeg|png|gif|webp|svg|ico|woff2?)$ {
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
NGINX

  sudo ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/${DOMAIN}"
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t
  sudo systemctl enable nginx
  sudo systemctl reload nginx

  echo ""
  echo "==> nginx configured. Run certbot for SSL:"
  echo "    sudo certbot --nginx -d ${DOMAIN}"
fi

REMOTE_SETUP

echo ""
echo "=============================="
echo " Deploy complete!"
echo " https://${DOMAIN}"
echo "=============================="
