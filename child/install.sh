#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo."
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.12 or newer is required."
  exit 1
fi

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
id duck-child >/dev/null 2>&1 || useradd --system --home-dir /opt/duck-child --shell /usr/sbin/nologin duck-child
install -d -m 0750 -o duck-child -g duck-child /opt/duck-child /opt/duck-child/src /opt/duck-child/child-data
install -m 0644 -o root -g root "$SOURCE_DIR/package.json" /opt/duck-child/package.json
install -m 0644 -o root -g root "$SOURCE_DIR/src/agent.js" /opt/duck-child/src/agent.js
install -m 0644 -o root -g root "$SOURCE_DIR/duck-child.service" /etc/systemd/system/duck-child.service
if [ ! -e /etc/duck-child.env ]; then
  install -m 0600 -o root -g root "$SOURCE_DIR/.env.template" /etc/duck-child.env
  echo "Created /etc/duck-child.env. Add the one-time token before starting."
fi
chown -R duck-child:duck-child /opt/duck-child/child-data
systemctl daemon-reload
echo "Installed safely. Edit /etc/duck-child.env, then run: sudo systemctl enable --now duck-child"
