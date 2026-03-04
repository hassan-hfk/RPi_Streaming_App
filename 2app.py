from flask import Flask, render_template, Response, jsonify, request
from flask_socketio import SocketIO, emit
import cv2
import numpy as np
from datetime import datetime
import json
import base64
import time
import logging

# Reduce logging noise
log = logging.getLogger('werkzeug')
log.setLevel(logging.WARNING)

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key-here'

# Enhanced SocketIO configuration for stability
socketio = SocketIO(
    app, 
    cors_allowed_origins="*", 
    ping_timeout=120,
    ping_interval=25,
    max_http_buffer_size=10**7,
    async_mode='threading',
    logger=False,
    engineio_logger=False
)

# Global variables for car control
current_speed = 0
current_direction = "STOP"
camera_client_sid = None  # Track camera client connection

# Video streaming variables
latest_frame = None
frame_timestamp = 0
camera_connected = False
last_frame_time = 0

class VideoCamera:
    def __init__(self):
        # For testing, we'll generate a test pattern
        # Replace this with actual RPi camera when ready
        self.frame_count = 0
        
    def __del__(self):
        pass
    
    def get_frame(self):
        global latest_frame, camera_connected, last_frame_time
        
        # Check if we have a real camera frame (less than 2 seconds old)
        if latest_frame and (time.time() - last_frame_time < 2):
            try:
                # Decode base64 frame
                img_data = base64.b64decode(latest_frame)
                nparr = np.frombuffer(img_data, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                
                if frame is not None:
                    camera_connected = True
                    ret, jpeg = cv2.imencode('.jpg', frame)
                    return jpeg.tobytes()
            except Exception as e:
                print(f"Error decoding frame: {e}")
        
        # Fallback to test pattern if no camera frame
        camera_connected = False
        return self.get_test_frame()
    
    def get_test_frame(self):
        # Generate test video pattern
        self.frame_count += 1
        
        # Create a test frame
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        
        # Add gradient background
        for i in range(480):
            frame[i, :] = [i//2, (i//3) % 255, 150]
        
        # Add moving circle
        center_x = int(320 + 200 * np.sin(self.frame_count * 0.05))
        center_y = int(240 + 100 * np.cos(self.frame_count * 0.05))
        cv2.circle(frame, (center_x, center_y), 50, (0, 255, 255), -1)
        
        # Add "No Camera" warning
        cv2.rectangle(frame, (160, 200), (480, 280), (0, 0, 0), -1)
        cv2.rectangle(frame, (160, 200), (480, 280), (0, 0, 255), 3)
        cv2.putText(frame, "Camera Not Connected", (180, 240), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
        
        # Add timestamp
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cv2.putText(frame, f"Test Video Feed", (10, 30), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        cv2.putText(frame, timestamp, (10, 60), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
        cv2.putText(frame, f"Frame: {self.frame_count}", (10, 90), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
        
        # Encode frame
        ret, jpeg = cv2.imencode('.jpg', frame)
        return jpeg.tobytes()

def gen(camera):
    while True:
        frame = camera.get_frame()
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n\r\n')

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/video_feed')
def video_feed():
    return Response(gen(VideoCamera()),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/camera_status')
def camera_status():
    """Endpoint to check camera connection status"""
    global camera_connected, last_frame_time
    return jsonify({
        'connected': camera_connected,
        'last_frame': last_frame_time,
        'age': time.time() - last_frame_time if last_frame_time > 0 else -1
    })

@app.route('/control', methods=['POST'])
def control():
    global current_direction, current_speed
    data = request.json
    command = data.get('command', '')
    
    # Process movement commands
    if command in ['forward', 'backward', 'left', 'right', 'stop']:
        current_direction = command.upper()
        print(f"Car Command: {current_direction}")
        
        # Send command to camera client (RPi) via WebSocket
        socketio.emit('motor_command', {
            'command': command,
            'direction': current_direction,
            'timestamp': time.time()
        }, room=camera_client_sid)
        
    return jsonify({
        'status': 'success',
        'command': command,
        'direction': current_direction
    })

@socketio.on('joystick_move')
def handle_joystick(data):
    global current_speed, current_direction
    x = data.get('x', 0)
    y = data.get('y', 0)
    
    print(f"Joystick: X={x}, Y={y}")
    
    # Send joystick data to camera client (RPi)
    socketio.emit('joystick_command', {
        'x': x,
        'y': y,
        'timestamp': time.time()
    }, room=camera_client_sid)
    
    emit('joystick_response', {
        'x': x,
        'y': y,
        'status': 'received'
    })

@app.route('/servo_control', methods=['POST'])
def servo_control():
    data = request.json
    servo_id = data.get('servo_id')
    angle = data.get('angle', 90)
    
    # Ensure angle is within range
    angle = max(0, min(180, angle))
    
    print(f"Servo {servo_id}: {angle}°")
    
    # Send servo command to camera client (RPi) via WebSocket
    socketio.emit('servo_command', {
        'servo_id': servo_id,
        'angle': angle,
        'timestamp': time.time()
    }, room=camera_client_sid)
    
    return jsonify({
        'status': 'success',
        'servo_id': servo_id,
        'angle': angle
    })

# Camera streaming handlers
@socketio.on('camera_frame')
def handle_camera_frame(data):
    """Receive frame from camera client"""
    global latest_frame, frame_timestamp, camera_connected, last_frame_time, camera_client_sid
    
    try:
        latest_frame = data['frame']
        frame_timestamp = time.time()
        last_frame_time = frame_timestamp
        camera_connected = True
        
        # Store camera client session ID
        if camera_client_sid is None:
            camera_client_sid = request.sid
            print(f"📹 Camera client registered: {camera_client_sid}")
        
    except Exception as e:
        print(f'❌ Error handling camera frame: {e}')
        camera_connected = False

@socketio.on('connect')
def handle_connect():
    print(f'✅ Client connected')
    emit('connection_response', {'status': 'connected'})

@socketio.on('disconnect')
def handle_disconnect():
    global camera_client_sid
    
    # Check if disconnecting client is camera client
    if request.sid == camera_client_sid:
        print(f'📹 Camera client disconnected')
        camera_client_sid = None
    else:
        print(f'❌ Client disconnected')

@socketio.on_error_default
def default_error_handler(e):
    print(f'❌ SocketIO Error: {e}')
    return False

if __name__ == '__main__':
    print('🚀 Starting RPi Car Dashboard Server...')
    print(f'📡 Server will be available at: http://0.0.0.0:5000')
    print(f'🌐 Access from browser at: http://YOUR_PUBLIC_IP:5000')
    print('Press Ctrl+C to stop\n')
    
    socketio.run(
        app, 
        host='0.0.0.0', 
        port=5000, 
        debug=False,
        allow_unsafe_werkzeug=True,
        log_output=False
    )
