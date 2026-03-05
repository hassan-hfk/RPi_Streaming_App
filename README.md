# RPi Car Dashboard

A low-latency remote control dashboard for a Raspberry Pi car. Streams live camera video and transmits motor, servo, and joystick commands over the internet.

## Architecture

```
RPi / PC  ──────────────────────────────────────────  Contabo VPS
                                                      
  camera_client.py                                    nginx (port 80)
  ├── Raw WebSocket  ──── ws://SERVER/stream ────►   stream_relay.py (port 8765)
  │   sends JPEG frames                               pure byte relay, zero parsing
  │
  └── SocketIO  ────────── http://SERVER:5000 ────►  app.py (Flask, port 5000)
      receives motor /                                sends commands back to RPi
      servo / joystick commands
                                                      
Browser  ──── http://SERVER ────────────────────────► nginx
  ├── receives JPEG frames via WebSocket
  └── sends motor / servo / joystick via SocketIO
```

**Key design decisions:**
- Video uses raw WebSocket binary frames (no base64, no SocketIO overhead)
- Controls use SocketIO (reliable, auto-reconnecting)
- nginx proxies both on port 80 — only one port needs to be open
- Camera identified at connect time via `auth` parameter — no registration events

---

## Server Setup (Contabo VPS — Ubuntu 22.04)

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
```

### 2. Run setup

```bash
bash setup.sh
```

That's it. The script will:
- Install nginx, Python 3, pip
- Create a Python virtual environment
- Install all Python dependencies
- Configure nginx
- Create and start systemd services for auto-start on boot

### 3. Verify

```bash
sudo systemctl status stream_relay
sudo systemctl status rpi_controls
```

Open in browser: `http://YOUR_SERVER_IP`

---

## Camera Client Setup (RPi / PC)

### 1. Install dependencies

```bash
pip install opencv-python python-socketio websockets aiohttp
```

On Raspberry Pi:
```bash
pip install opencv-python-headless python-socketio websockets aiohttp
```

### 2. Configure

Edit `camera_client.py` and set your server IP:

```python
SERVER_IP = 'YOUR_CONTABO_IP'
```

Tune these for your connection speed:

```python
TARGET_FPS   = 30    # lower if connection is slow
JPEG_QUALITY = 80    # lower for less bandwidth (range: 20-95)
FRAME_WIDTH  = 640
FRAME_HEIGHT = 640
```

**Bandwidth guide:**

| Quality | Resolution | FPS | Upload needed |
|---------|-----------|-----|--------------|
| Q80 | 640x640 | 30 | ~600 KB/s |
| Q50 | 640x480 | 15 | ~200 KB/s |
| Q30 | 320x240 | 10 | ~50 KB/s |

### 3. Run

```bash
python camera_client.py
```

---

## Repo Structure

```
├── app.py                  # Flask server — controls only (motor/servo/joystick)
├── stream_relay.py         # Asyncio WebSocket relay — video frames
├── camera_client.py        # Runs on RPi/PC — sends video, receives commands
├── nginx.conf              # nginx reverse proxy config
├── setup.sh                # One-command server setup script
├── templates/
│   └── index.html          # Dashboard UI
└── static/
    ├── css/
    │   └── style.css
    └── js/
        └── script.js       # Raw WebSocket video + SocketIO controls
```

---

## Managing Services

```bash
# View live logs
sudo journalctl -fu stream_relay
sudo journalctl -fu rpi_controls

# Restart after updating code
git pull
sudo systemctl restart stream_relay rpi_controls

# Stop / start manually
sudo systemctl stop stream_relay rpi_controls
sudo systemctl start stream_relay rpi_controls
```

---

## Debug Endpoints

| URL | Description |
|-----|-------------|
| `http://SERVER/` | Main dashboard |
| `http://SERVER/debug` | Camera registration status |

`/debug` returns:
```json
{
  "camera_registered": true,
  "camera_sid": "abc123...",
  "direction": "STOP"
}
```

---

## Troubleshooting

**Dashboard shows "Waiting for camera"**
- Check `stream_relay` is running: `sudo systemctl status stream_relay`
- Check camera client is connected: look for `[Stream] Connected` in client terminal
- Check port 8765 is listening: `ss -tlnp | grep 8765`

**Controls not working**
- Open `http://SERVER/debug` — check `camera_registered` is `true`
- Check port 5000 is open: `ss -tlnp | grep 5000`
- Restart Flask: `sudo systemctl restart rpi_controls`

**High latency / lag**
- Lower `JPEG_QUALITY` and `TARGET_FPS` in `camera_client.py`
- Check server CPU: `top`
- Check upload speed on RPi/PC connection

**Camera not opening on Windows**
The client tries DirectShow first, then MSMF, then auto-detect.
If all fail, try changing `CAMERA_INDEX = 1` or `2`.

**GSM module connection**
Works the same as WiFi — RPi always initiates outbound connection so dynamic IP is not an issue.

---

## Requirements

**Server (VPS)**
- Ubuntu 22.04 or Debian 12
- nginx
- Python 3.10+
- Open ports: 80, 5000

**Camera client**
- Python 3.8+
- opencv-python
- python-socketio
- websockets

---

## License

MIT
