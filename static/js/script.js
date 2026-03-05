// ── Two separate connections ─────────────────────────────────────────────────
// 1. Raw WebSocket  → /stream  (binary JPEG frames, zero overhead)
// 2. SocketIO       → /        (control commands only)

const socket = io();   // SocketIO for controls

// Raw WebSocket for video — connects to /stream which nginx proxies to stream_relay.py
const streamWs = new WebSocket(`ws://${location.host}/stream`);
streamWs.binaryType = 'blob';   // receive binary JPEG blobs directly

// ── Global state ─────────────────────────────────────────────────────────────
let isJoystickActive = false;
let joystickPosition = { x: 0, y: 0 };
let currentCommand   = 'stop';

// Frame rendering: single-slot buffer — only the latest frame ever gets painted
let pendingBlob  = null;
let rafScheduled = false;
let currentObjectURL = null;   // track current blob URL to revoke it

// FPS counter
let frameCount = 0;
let fpsTimer   = Date.now();

// ── DOM refs ──────────────────────────────────────────────────────────────────
const videoImg         = document.getElementById('video-stream');
const noSignal         = document.getElementById('no-signal');
const cameraBadge      = document.getElementById('camera-badge');
const fpsBadge         = document.getElementById('fps-badge');
const fpsDisplay       = document.getElementById('fps-display');
const controlButtons   = document.querySelectorAll('.dpad-btn');
const joystickArea     = document.getElementById('joystick-area');
const joystickStick    = document.getElementById('joystick-stick');
const joystickX        = document.getElementById('joystick-x');
const joystickY        = document.getElementById('joystick-y');
const directionStatus  = document.getElementById('direction-status');
const controlMode      = document.getElementById('control-mode');

// ── Raw WebSocket video ───────────────────────────────────────────────────────

streamWs.addEventListener('open', () => {
    console.log('[Stream] WebSocket connected');
    streamWs.send('VIEWER');   // register as viewer with relay
});

streamWs.addEventListener('close', () => {
    console.log('[Stream] WebSocket closed');
    setCameraStatus(false);
});

streamWs.addEventListener('error', (e) => {
    console.error('[Stream] WebSocket error', e);
});

streamWs.addEventListener('message', (event) => {
    // event.data is either a Blob (JPEG frame) or a string (status message)
    if (typeof event.data === 'string') {
        // Status messages from relay: 'STATUS:CONNECTED' / 'STATUS:DISCONNECTED'
        if (event.data === 'STATUS:CONNECTED')    setCameraStatus(true);
        if (event.data === 'STATUS:DISCONNECTED') setCameraStatus(false);
        return;
    }

    // It's a binary JPEG blob — store as pending, schedule paint
    // If a previous frame is already pending, it gets replaced (dropped).
    // This is intentional: we always show the NEWEST frame, never queue up stale ones.
    pendingBlob = event.data;

    if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(paintFrame);
    }

    // FPS counter
    frameCount++;
    const now = Date.now();
    if (now - fpsTimer >= 1000) {
        fpsDisplay.textContent = frameCount;
        frameCount = 0;
        fpsTimer = now;
    }
});

function paintFrame() {
    rafScheduled = false;
    if (!pendingBlob) return;

    const blob = pendingBlob;
    pendingBlob = null;

    // Revoke previous object URL to free memory immediately
    if (currentObjectURL) {
        URL.revokeObjectURL(currentObjectURL);
    }

    // Create a blob URL and assign it — browser decodes JPEG natively,
    // no base64 string processing, no JSON parsing
    currentObjectURL = URL.createObjectURL(blob);
    videoImg.src = currentObjectURL;

    noSignal.style.display  = 'none';
    videoImg.style.display  = 'block';
}

function setCameraStatus(connected) {
    if (connected) {
        cameraBadge.textContent = '📷 Camera Live';
        cameraBadge.style.color = '#10b981';
        fpsBadge.style.display  = '';
    } else {
        cameraBadge.textContent = '📷 No Camera';
        cameraBadge.style.color = '#ef4444';
        fpsBadge.style.display  = 'none';
        noSignal.style.display  = 'flex';
        videoImg.style.display  = 'none';
    }
}

// ── SocketIO control channel ──────────────────────────────────────────────────

socket.on('connect', () => {
    console.log('[Control] SocketIO connected');
    socket.emit('register_viewer');
});

socket.on('disconnect', () => {
    console.log('[Control] SocketIO disconnected');
});

socket.on('connection_response', (data) => {
    console.log('[Control] Server:', data);
});

// ── D-Pad controls ────────────────────────────────────────────────────────────

controlButtons.forEach(button => {
    button.addEventListener('mousedown',  () => handleButtonPress(button));
    button.addEventListener('mouseup',    () => handleButtonRelease(button));
    button.addEventListener('mouseleave', () => handleButtonRelease(button));
    button.addEventListener('touchstart', (e) => { e.preventDefault(); handleButtonPress(button); });
    button.addEventListener('touchend',   (e) => { e.preventDefault(); handleButtonRelease(button); });
});

function handleButtonPress(button) {
    const command = button.dataset.command;
    controlButtons.forEach(b => b.classList.remove('active'));
    button.classList.add('active');
    sendCommand(command);
    directionStatus.textContent = command.toUpperCase();
    controlMode.textContent = 'Button';
    currentCommand = command;
}

function handleButtonRelease(button) {
    if (button.dataset.command !== 'stop') {
        button.classList.remove('active');
        if (currentCommand !== 'stop') {
            sendCommand('stop');
            directionStatus.textContent = 'STOP';
            controlButtons.forEach(b => b.classList.remove('active'));
            document.getElementById('stop-btn').classList.add('active');
            currentCommand = 'stop';
        }
    }
}

function sendCommand(command) {
    fetch('/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
    })
    .then(r => r.json())
    .then(d => console.log('[Control] Command:', d))
    .catch(e => console.error('[Control] Error:', e));
}

// ── Joystick ──────────────────────────────────────────────────────────────────

joystickArea.addEventListener('mousedown', startJoystick);
joystickArea.addEventListener('touchstart', startJoystick);
document.addEventListener('mousemove', moveJoystick);
document.addEventListener('touchmove', moveJoystick, { passive: false });
document.addEventListener('mouseup', stopJoystick);
document.addEventListener('touchend', stopJoystick);

function startJoystick(e) {
    e.preventDefault();
    isJoystickActive = true;
    controlMode.textContent = 'Joystick';
    controlButtons.forEach(b => b.classList.remove('active'));
}

function moveJoystick(e) {
    if (!isJoystickActive) return;
    e.preventDefault();
    const rect    = joystickArea.getBoundingClientRect();
    const centerX = rect.left + rect.width  / 2;
    const centerY = rect.top  + rect.height / 2;
    const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    let dx = clientX - centerX;
    let dy = clientY - centerY;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const max  = rect.width / 2 - 30;
    if (dist > max) {
        const a = Math.atan2(dy, dx);
        dx = Math.cos(a) * max;
        dy = Math.sin(a) * max;
    }
    joystickStick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    const nx = Math.round((dx / max) *  100);
    const ny = Math.round((dy / max) * -100);
    joystickX.textContent = nx;
    joystickY.textContent = ny;
    joystickPosition = { x: nx, y: ny };
    socket.emit('joystick_move', joystickPosition);
    updateDirectionFromJoystick(nx, ny);
}

function stopJoystick(e) {
    if (!isJoystickActive) return;
    e.preventDefault();
    isJoystickActive = false;
    joystickStick.style.transform = 'translate(-50%, -50%)';
    joystickX.textContent = '0';
    joystickY.textContent = '0';
    socket.emit('joystick_move', { x: 0, y: 0 });
    directionStatus.textContent = 'STOP';
    currentCommand = 'stop';
    controlButtons.forEach(b => b.classList.remove('active'));
    document.getElementById('stop-btn').classList.add('active');
}

function updateDirectionFromJoystick(x, y) {
    const t = 20;
    if (Math.abs(x) < t && Math.abs(y) < t) { directionStatus.textContent = 'STOP'; return; }
    if (Math.abs(y) >= Math.abs(x))
        directionStatus.textContent = y > t ? 'FORWARD' : 'BACKWARD';
    else
        directionStatus.textContent = x > t ? 'RIGHT' : 'LEFT';
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

const keyMap = {
    'w': 'forward-btn',  'arrowup':    'forward-btn',
    's': 'backward-btn', 'arrowdown':  'backward-btn',
    'a': 'left-btn',     'arrowleft':  'left-btn',
    'd': 'right-btn',    'arrowright': 'right-btn',
};
document.addEventListener('keydown', (e) => {
    const id = keyMap[e.key.toLowerCase()];
    if (id) handleButtonPress(document.getElementById(id));
    if (e.key === ' ') { e.preventDefault(); handleButtonPress(document.getElementById('stop-btn')); }
});
document.addEventListener('keyup', (e) => {
    const id = keyMap[e.key.toLowerCase()];
    if (id) handleButtonRelease(document.getElementById(id));
});

// ── Servo controls ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('stop-btn').classList.add('active');

    document.querySelectorAll('.servo-slider-compact').forEach(slider => {
        slider.addEventListener('input', (e) => {
            const id    = e.target.dataset.servo;
            const angle = parseInt(e.target.value);
            document.getElementById(`servo${id}-value`).textContent = `${angle}°`;
            fetch('/servo_control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ servo_id: id, angle })
            }).catch(console.error);
        });
    });

    document.getElementById('servo-reset').addEventListener('click', () => {
        document.querySelectorAll('.servo-slider-compact').forEach(s => {
            s.value = 90;
            document.getElementById(`servo${s.dataset.servo}-value`).textContent = '90°';
            fetch('/servo_control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ servo_id: s.dataset.servo, angle: 90 })
            }).catch(console.error);
        });
    });
});
