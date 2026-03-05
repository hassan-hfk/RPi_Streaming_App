#!/bin/bash
# =============================================================================
# setup.sh — RPi Car Dashboard Server Setup
# Tested on Ubuntu 22.04 / Debian 12 (Contabo VPS)
# Usage: bash setup.sh
# =============================================================================

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Colour

log()     { echo -e "${GREEN}[✓]${NC} $1"; }
warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
error()   { echo -e "${RED}[✗]${NC} $1"; exit 1; }
section() { echo -e "\n${BLUE}══ $1 ══${NC}"; }

# ── Must run as root ──────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    error "Run as root: sudo bash setup.sh"
fi

# ── Detect project directory (where this script lives) ───────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"
VENV_DIR="$PROJECT_DIR/venv"

log "Project directory: $PROJECT_DIR"

# ── Verify required files exist ───────────────────────────────────────────────
section "Checking required files"
REQUIRED_FILES=(
    "app.py"
    "stream_relay.py"
    "templates/index.html"
    "static/css/style.css"
    "static/js/script.js"
    "nginx.conf"
)
for f in "${REQUIRED_FILES[@]}"; do
    if [[ ! -f "$PROJECT_DIR/$f" ]]; then
        error "Missing required file: $PROJECT_DIR/$f"
    fi
    log "Found: $f"
done

# =============================================================================
# STEP 1 — System packages
# =============================================================================
section "Installing system packages"

apt-get update -qq || error "apt update failed"

PACKAGES=(nginx python3 python3-pip python3-venv curl)
for pkg in "${PACKAGES[@]}"; do
    if dpkg -l "$pkg" &>/dev/null; then
        log "$pkg already installed"
    else
        apt-get install -y "$pkg" -qq && log "Installed $pkg" || error "Failed to install $pkg"
    fi
done

# =============================================================================
# STEP 2 — Python virtual environment
# =============================================================================
section "Setting up Python virtual environment"

if [[ -d "$VENV_DIR" ]]; then
    warn "venv already exists at $VENV_DIR — skipping creation"
else
    python3 -m venv "$VENV_DIR" || error "Failed to create venv"
    log "Virtual environment created at $VENV_DIR"
fi

# Upgrade pip inside venv
"$VENV_DIR/bin/pip" install --upgrade pip -q || warn "pip upgrade failed (non-fatal)"

# Install Python dependencies
section "Installing Python dependencies"
PYTHON_PACKAGES=(flask flask-socketio websockets)
for pkg in "${PYTHON_PACKAGES[@]}"; do
    "$VENV_DIR/bin/pip" install "$pkg" -q && log "Installed $pkg" || error "Failed to install $pkg"
done

# Verify installs
"$VENV_DIR/bin/python3" -c "import flask, flask_socketio, websockets" \
    && log "All Python packages verified" \
    || error "Python package verification failed"

# =============================================================================
# STEP 3 — nginx configuration
# =============================================================================
section "Configuring nginx"

NGINX_SITE="/etc/nginx/sites-enabled/default"
NGINX_AVAILABLE="/etc/nginx/sites-available/default"

# Backup existing config
if [[ -f "$NGINX_AVAILABLE" ]]; then
    cp "$NGINX_AVAILABLE" "$NGINX_AVAILABLE.bak.$(date +%s)"
    log "Backed up existing nginx config"
fi

# Copy our nginx config
cp "$PROJECT_DIR/nginx.conf" "$NGINX_AVAILABLE" || error "Failed to copy nginx config"

# Ensure symlink exists
if [[ ! -L "$NGINX_SITE" ]]; then
    ln -s "$NGINX_AVAILABLE" "$NGINX_SITE" || error "Failed to create nginx symlink"
fi

# Remove any stale .bak files nginx might pick up
find /etc/nginx/sites-enabled/ -name "*.bak*" -delete 2>/dev/null && log "Removed stale nginx backup files"

# Test nginx config
nginx -t || error "nginx config test failed — check $NGINX_AVAILABLE"
log "nginx config valid"

# =============================================================================
# STEP 4 — systemd services
# =============================================================================
section "Creating systemd services"

PYTHON_BIN="$VENV_DIR/bin/python3"

# ── stream_relay.service ──────────────────────────────────────────────────────
cat > /etc/systemd/system/stream_relay.service << EOF
[Unit]
Description=RPi Camera Stream Relay
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=root
WorkingDirectory=$PROJECT_DIR
ExecStart=$PYTHON_BIN $PROJECT_DIR/stream_relay.py
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
log "Created stream_relay.service"

# ── rpi_controls.service ──────────────────────────────────────────────────────
cat > /etc/systemd/system/rpi_controls.service << EOF
[Unit]
Description=RPi Car Controls Server (Flask)
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=root
WorkingDirectory=$PROJECT_DIR
ExecStart=$PYTHON_BIN $PROJECT_DIR/app.py
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
log "Created rpi_controls.service"

# =============================================================================
# STEP 5 — Enable and start services
# =============================================================================
section "Starting services"

systemctl daemon-reload || error "systemctl daemon-reload failed"

# Enable services (auto-start on boot)
systemctl enable stream_relay rpi_controls nginx \
    && log "Services enabled on boot" \
    || error "Failed to enable services"

# Start / restart services
for svc in stream_relay rpi_controls; do
    if systemctl is-active --quiet "$svc"; then
        systemctl restart "$svc" && log "Restarted $svc"
    else
        systemctl start "$svc" && log "Started $svc"
    fi
done

# Reload nginx (non-disruptive)
systemctl reload nginx && log "nginx reloaded" || systemctl restart nginx && log "nginx restarted"

# =============================================================================
# STEP 6 — Verify everything is running
# =============================================================================
section "Verifying services"

sleep 2  # give services a moment to start

ALL_OK=true

check_service() {
    if systemctl is-active --quiet "$1"; then
        log "$1 is running"
    else
        warn "$1 failed to start — check: journalctl -u $1 -n 20"
        ALL_OK=false
    fi
}

check_service stream_relay
check_service rpi_controls
check_service nginx

# Check ports
check_port() {
    if ss -tlnp | grep -q ":$1 "; then
        log "Port $1 is listening"
    else
        warn "Port $1 is NOT listening"
        ALL_OK=false
    fi
}

check_port 80
check_port 5000
check_port 8765

# =============================================================================
# Done
# =============================================================================
section "Setup Complete"

PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR_SERVER_IP")

if $ALL_OK; then
    echo -e "\n${GREEN}Everything is running!${NC}"
else
    echo -e "\n${YELLOW}Setup completed with warnings — check services above.${NC}"
fi

echo ""
echo -e "  Dashboard  : ${BLUE}http://$PUBLIC_IP${NC}"
echo -e "  Debug      : ${BLUE}http://$PUBLIC_IP/debug${NC}"
echo -e "  Stream WS  : ${BLUE}ws://$PUBLIC_IP/stream${NC}"
echo -e "  Controls   : ${BLUE}http://$PUBLIC_IP:5000${NC}"
echo ""
echo "Useful commands:"
echo "  sudo journalctl -fu stream_relay    # stream relay logs"
echo "  sudo journalctl -fu rpi_controls    # flask logs"
echo "  sudo systemctl restart stream_relay # restart relay"
echo "  sudo systemctl restart rpi_controls # restart flask"
echo ""
echo "Update code and restart:"
echo "  git pull && sudo systemctl restart stream_relay rpi_controls"
