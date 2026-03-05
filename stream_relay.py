import asyncio
import websockets
import logging
import time
from websockets.exceptions import ConnectionClosed

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
log = logging.getLogger('relay')

RELAY_PORT       = 8765
viewers          = set()
camera_ws        = None
camera_connected = False
frames_relayed   = 0
start_time       = time.time()


async def handle_connection(websocket):   # no 'path' argument — removed in websockets v11+
    global camera_ws, camera_connected, frames_relayed

    try:
        reg = await asyncio.wait_for(websocket.recv(), timeout=10)
    except asyncio.TimeoutError:
        log.warning(f'Timeout waiting for registration from {websocket.remote_address}')
        return

    # ── Camera client ─────────────────────────────────────────────────────────
    if reg in (b'CAMERA', 'CAMERA'):
        log.info(f'Camera connected: {websocket.remote_address}')
        camera_ws        = websocket
        camera_connected = True

        if viewers:
            await asyncio.gather(
                *[v.send(b'STATUS:CONNECTED') for v in viewers],
                return_exceptions=True
            )

        try:
            async for frame in websocket:
                if viewers:
                    results = await asyncio.gather(
                        *[v.send(frame) for v in viewers],
                        return_exceptions=True
                    )
                    # Remove dead viewer connections
                    dead = {v for v, r in zip(list(viewers), results) if isinstance(r, Exception)}
                    for v in dead:
                        viewers.discard(v)

                frames_relayed += 1
                if frames_relayed % 300 == 0:
                    elapsed = time.time() - start_time
                    log.info(f'Relayed: {frames_relayed} | '
                             f'{frames_relayed/elapsed:.1f} fps | '
                             f'{len(viewers)} viewer(s)')

        except ConnectionClosed:
            pass
        finally:
            camera_ws        = None
            camera_connected = False
            log.info('Camera disconnected')
            if viewers:
                await asyncio.gather(
                    *[v.send(b'STATUS:DISCONNECTED') for v in viewers],
                    return_exceptions=True
                )

    # ── Browser viewer ────────────────────────────────────────────────────────
    elif reg in (b'VIEWER', 'VIEWER'):
        log.info(f'Viewer connected: {websocket.remote_address} (total: {len(viewers) + 1})')
        viewers.add(websocket)

        status = b'STATUS:CONNECTED' if camera_connected else b'STATUS:DISCONNECTED'
        await websocket.send(status)

        try:
            await websocket.wait_closed()
        except ConnectionClosed:
            pass
        finally:
            viewers.discard(websocket)
            log.info(f'Viewer disconnected (remaining: {len(viewers)})')

    else:
        log.warning(f'Unknown registration message: {reg!r} from {websocket.remote_address}')


async def main():
    log.info(f'Stream relay starting on port {RELAY_PORT}')
    async with websockets.serve(
        handle_connection,
        '0.0.0.0',
        RELAY_PORT,
        max_size=10 * 1024 * 1024,
        ping_interval=20,
        ping_timeout=60,
        compression=None,
    ):
        log.info(f'Relay running on ws://0.0.0.0:{RELAY_PORT}')
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main())
