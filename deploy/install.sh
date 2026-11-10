#!/bin/bash
# Runs on the server. Installs PostgreSQL, Caddy for HTTPS and Leo. Safe to run again.
set -euo pipefail
DOMAIN="$1"; BUCKET="$2"; SES_FROM="$3"
export DEBIAN_FRONTEND=noninteractive AWS_DEFAULT_REGION=ap-south-1
apt-get install -y -qq postgresql python3-venv caddy unattended-upgrades >/dev/null

id leo >/dev/null 2>&1 || useradd --system --home /opt/leo --shell /usr/sbin/nologin leo
PASSFILE=/etc/leo-db-password
[ -f "$PASSFILE" ] || { openssl rand -hex 24 > "$PASSFILE"; chmod 600 "$PASSFILE"; }
DB_PASS=$(cat "$PASSFILE")
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='leo'" | grep -q 1 || sudo -u postgres psql -qc "CREATE ROLE leo LOGIN PASSWORD '$DB_PASS'"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='leo'" | grep -q 1 || sudo -u postgres createdb -O leo leo

param() { aws ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text; }
umask 077
cat > /etc/leo.env <<ENV
LEO_ENV=production
LEO_BASE_URL=https://$DOMAIN
LEO_SECRET=$(param /leo/secret)
OPENAI_API_KEY=$(param /leo/openai_key 2>/dev/null || true)
DATABASE_URL=postgresql+psycopg://leo:$DB_PASS@127.0.0.1/leo
SES_FROM=$SES_FROM
AWS_REGION=ap-south-1
VOICE_ROUTE=${VOICE_ROUTE:-mumbai}
BEDROCK_MODEL_ID=${BEDROCK_MODEL_ID:-mistral.ministral-3-8b-instruct}
BEDROCK_SCORING_MODEL_ID=${BEDROCK_SCORING_MODEL_ID:-deepseek.v3.2}
BUDGET_USD=${BUDGET_USD:-2.5}
MAX_CONCURRENT_CALLS=2
MAX_CALLS_PER_HOUR=20
ENV
umask 022

python3 -m venv /opt/leo/.venv
/opt/leo/.venv/bin/pip install -q -r /opt/leo/requirements.txt
mkdir -p /opt/leo/data && chown -R leo:leo /opt/leo/data

cat > /etc/systemd/system/leo.service <<UNIT
[Unit]
Description=Leo
After=network-online.target postgresql.service
[Service]
User=leo
WorkingDirectory=/opt/leo
EnvironmentFile=/etc/leo.env
# One process only: live call tracking and spending limits are held in memory.
ExecStart=/opt/leo/.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1 --proxy-headers
Restart=always
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
  encode gzip
  request_body {
    max_size 450MB
  }
  reverse_proxy 127.0.0.1:8000
}
CADDY

cat > /etc/cron.daily/leo-backup <<CRON
#!/bin/bash
set -e
sudo -u postgres pg_dump leo | gzip | AWS_DEFAULT_REGION=ap-south-1 aws s3 cp - "s3://$BUCKET/backups/leo-\$(date +%F).sql.gz" --only-show-errors
CRON
chmod 755 /etc/cron.daily/leo-backup

chmod -R a+rX /opt/leo/app
systemctl daemon-reload
systemctl enable -q leo caddy
systemctl restart leo caddy
sleep 4
curl -fsS http://127.0.0.1:8000/health && echo " Leo is running at https://$DOMAIN"
