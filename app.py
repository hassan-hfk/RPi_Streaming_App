from flask import Flask, render_template, jsonify, request
from flask_socketio import SocketIO, emit, join_room
import time
import logging

logging.getLogger('werkzeug').setLevel(logging.WARNING)

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key-here'

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    ping_timeout=60,
    ping_interval=25,
    async_mode='threading',
    logger=False,
    engineio_logger=False
)

current_direction = "STOP"
camera_client_sid = None


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/control', methods=['POST'])
def control():
    global current_direction
    command = request.json.get('command', '')
    if command in ['forward', 'backward', 'left', 'right', 'stop']:
        current_direction = command.upper()
        if camera_client_sid:
            socketio.emit('motor_command', {
                'command':   command,
                'direction': current_direction,
                'timestamp': time.time()
            }, to=camera_client_sid)
            print(f'Motor: {command}')
        else:
            print(f'Motor: {command} — no camera')
    return jsonify({'status': 'success', 'command': command, 'direction': current_direction})


@app.route('/servo_control', methods=['POST'])
def servo_control():
    data     = request.json
    servo_id = data.get('servo_id')
    angle    = max(0, min(180, data.get('angle', 90)))
    if camera_client_sid:
        socketio.emit('servo_command', {
            'servo_id':  servo_id,
            'angle':     angle,
            'timestamp': time.time()
        }, to=camera_client_sid)
    return jsonify({'status': 'success', 'servo_id': servo_id, 'angle': angle})


@app.route('/debug')
def debug():
    return jsonify({
        'camera_registered': camera_client_sid is not None,
        'camera_sid': camera_client_sid,
        'direction': current_direction
    })


@socketio.on('connect')
def handle_connect(auth):
    global camera_client_sid
    # Identify camera at connection time via auth dict — no separate event needed
    if auth and auth.get('type') == 'camera':
        camera_client_sid = request.sid
        join_room('camera')
        print(f'Camera connected: {camera_client_sid}')
        emit('connection_response', {'status': 'connected', 'role': 'camera'})
    else:
        join_room('viewers')
        print(f'Viewer connected: {request.sid}')
        emit('connection_response', {'status': 'connected', 'role': 'viewer'})


@socketio.on('disconnect')
def handle_disconnect(reason=None):
    global camera_client_sid
    if request.sid == camera_client_sid:
        camera_client_sid = None
        print(f'Camera disconnected')
    else:
        print(f'Viewer disconnected')


@socketio.on('joystick_move')
def handle_joystick(data):
    if camera_client_sid:
        socketio.emit('joystick_command', {
            'x':         data.get('x', 0),
            'y':         data.get('y', 0),
            'timestamp': time.time()
        }, to=camera_client_sid)
    emit('joystick_response', {'status': 'received'})


@socketio.on_error_default
def error_handler(e):
    print(f'SocketIO error: {e}')


if __name__ == '__main__':
    print('Controls server on port 5000...')
    print('Debug: http://YOUR_IP/debug')
    socketio.run(app, host='0.0.0.0', port=5000,
                 debug=False, allow_unsafe_werkzeug=True)
