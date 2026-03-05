import cv2
import asyncio
import websockets
import socketio
import threading
import time
import sys
import logging

# ==============================================================================
# Configuration
# ==============================================================================
SERVER_IP    = '173.212.248.109'
STREAM_URL   = f'ws://{SERVER_IP}/stream'
CONTROL_URL  = f'http://{SERVER_IP}:5000'

CAMERA_INDEX = 0
TARGET_FPS   = 30
JPEG_QUALITY = 80
FRAME_WIDTH  = 1280
FRAME_HEIGHT = 960
# ==============================================================================

logging.getLogger('socketio').setLevel(logging.WARNING)
logging.getLogger('engineio').setLevel(logging.WARNING)


class ControlClient:
    def __init__(self, server_url):
        self.server_url = server_url
        self.sio = socketio.Client(
            reconnection=True,
            reconnection_attempts=0,
            reconnection_delay=1,
            reconnection_delay_max=5,
            logger=False,
            engineio_logger=False
        )
        self._setup()

    def _setup(self):
        @self.sio.on('connect')
        def on_connect():
            print('[Control] Connected as camera')

        @self.sio.on('disconnect')
        def on_disconnect():
            print('[Control] Disconnected')

        @self.sio.on('connection_response')
        def on_response(data):
            print(f'[Control] Server: {data}')

        @self.sio.on('motor_command')
        def on_motor(data):
            print(f'[Motor] {data.get("direction")} / {data.get("command")}')
            # TODO: control_motors(data['command'])

        @self.sio.on('joystick_command')
        def on_joystick(data):
            print(f'[Joystick] X={data.get("x", 0)}, Y={data.get("y", 0)}')
            # TODO: control_motors_analog(data['x'], data['y'])

        @self.sio.on('servo_command')
        def on_servo(data):
            print(f'[Servo] id={data.get("servo_id")} angle={data.get("angle", 90)}')
            # TODO: set_servo_angle(data['servo_id'], data['angle'])

    def run_forever(self):
        while True:
            try:
                print(f'[Control] Connecting to {self.server_url}...')
                self.sio.connect(
                    self.server_url,
                    auth={'type': 'camera'},   # identifies as camera at connect time
                    wait_timeout=10,
                    transports=['websocket', 'polling']
                )
                self.sio.wait()
            except Exception as e:
                print(f'[Control] Error: {e}')
            print('[Control] Reconnecting in 3s...')
            time.sleep(3)


def open_camera():
    backends = (
        [(cv2.CAP_DSHOW, 'DirectShow'), (cv2.CAP_MSMF, 'MSMF'), (cv2.CAP_ANY, 'Auto')]
        if sys.platform == 'win32' else
        [(cv2.CAP_V4L2, 'V4L2'), (cv2.CAP_ANY, 'Auto')]
    )
    for backend, name in backends:
        print(f'[Camera] Trying {name}...')
        try:
            cap = cv2.VideoCapture(CAMERA_INDEX + backend)
            if not cap.isOpened():
                cap.release()
                continue
            ok, _ = cap.read()
            if not ok:
                cap.release()
                continue
            cap.set(cv2.CAP_PROP_FRAME_WIDTH,  FRAME_WIDTH)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)
            cap.set(cv2.CAP_PROP_FPS,          TARGET_FPS)
            cap.set(cv2.CAP_PROP_BUFFERSIZE,   1)
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            print(f'[Camera] Opened with {name}: {w}x{h}')
            return cap
        except Exception as e:
            print(f'[Camera] {name} error: {e}')
    return None


async def stream_video():
    cap = open_camera()
    if cap is None:
        print('[Camera] Cannot open. Exiting.')
        return

    frame_interval = 1.0 / TARGET_FPS
    encode_param   = [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY]
    frames_sent    = 0
    start          = time.time()

    print(f'[Stream] {TARGET_FPS}fps {FRAME_WIDTH}x{FRAME_HEIGHT} Q{JPEG_QUALITY}')

    while True:
        try:
            async with websockets.connect(
                STREAM_URL,
                max_size=10 * 1024 * 1024,
                ping_interval=20,
                ping_timeout=60,
                compression=None,
            ) as ws:
                await ws.send('CAMERA')
                print('[Stream] Connected')

                while True:
                    t0 = time.time()
                    ret, frame = cap.read()
                    if not ret:
                        await asyncio.sleep(0.05)
                        continue
                    _, buf = cv2.imencode('.jpg', frame, encode_param)
                    await ws.send(buf.tobytes())
                    frames_sent += 1
                    if frames_sent % 100 == 0:
                        elapsed = time.time() - start
                        fps = frames_sent / elapsed
                        kb  = len(buf) // 1024
                        print(f'[Stream] {frames_sent} | {fps:.1f}fps | {kb}KB')
                    sleep = max(0, frame_interval - (time.time() - t0))
                    if sleep:
                        await asyncio.sleep(sleep)
        except Exception as e:
            print(f'[Stream] Lost: {e} — retrying...')
            await asyncio.sleep(2)


def main():
    print("=" * 55)
    print(f"  Stream  : {STREAM_URL}")
    print(f"  Control : {CONTROL_URL}")
    print(f"  FPS     : {TARGET_FPS}  Res: {FRAME_WIDTH}x{FRAME_HEIGHT}  Q: {JPEG_QUALITY}")
    print("=" * 55)

    ctrl = ControlClient(CONTROL_URL)
    threading.Thread(target=ctrl.run_forever, daemon=True).start()

    time.sleep(2)

    try:
        asyncio.run(stream_video())
    except KeyboardInterrupt:
        print('\nStopped.')


if __name__ == '__main__':
    main()