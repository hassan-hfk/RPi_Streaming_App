const socket = io();

// Global variables
let isJoystickActive = false;
let joystickPosition = { x: 0, y: 0 };
let currentCommand = 'stop';

// DOM Elements
const controlButtons = document.querySelectorAll('.dpad-btn');
const joystickArea = document.getElementById('joystick-area');
const joystickStick = document.getElementById('joystick-stick');
const joystickX = document.getElementById('joystick-x');
const joystickY = document.getElementById('joystick-y');
const connectionStatus = document.getElementById('connection-status');
const directionStatus = document.getElementById('direction-status');
const controlMode = document.getElementById('control-mode');

// Socket.IO event handlers
socket.on('connect', () => {
    console.log('Connected to server');
    const statusText = connectionStatus.querySelector('.status-dot') ?
        connectionStatus.childNodes[2] : connectionStatus;
    if (statusText.nodeType === Node.TEXT_NODE) {
        statusText.textContent = ' Connected';
    }
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
    const statusText = connectionStatus.querySelector('.status-dot') ?
        connectionStatus.childNodes[2] : connectionStatus;
    if (statusText.nodeType === Node.TEXT_NODE) {
        statusText.textContent = ' Disconnected';
    }
});

socket.on('connection_response', (data) => {
    console.log('Connection response:', data);
});

socket.on('joystick_response', (data) => {
    console.log('Joystick response:', data);
});

// Button control handlers
controlButtons.forEach(button => {
    button.addEventListener('mousedown', () => handleButtonPress(button));
    button.addEventListener('mouseup', () => handleButtonRelease(button));
    button.addEventListener('mouseleave', () => handleButtonRelease(button));
    
    // Touch events for mobile
    button.addEventListener('touchstart', (e) => {
        e.preventDefault();
        handleButtonPress(button);
    });
    button.addEventListener('touchend', (e) => {
        e.preventDefault();
        handleButtonRelease(button);
    });
});

function handleButtonPress(button) {
    const command = button.dataset.command;
    
    // Remove active class from all buttons
    controlButtons.forEach(btn => btn.classList.remove('active'));
    
    // Add active class to pressed button
    button.classList.add('active');
    
    // Send command to server
    sendCommand(command);
    
    // Update status
    directionStatus.textContent = command.toUpperCase();
    controlMode.textContent = 'Button';
    currentCommand = command;
}

function handleButtonRelease(button) {
    // Only remove active if it's not the stop button
    if (button.dataset.command !== 'stop') {
        button.classList.remove('active');
        
        // Auto-stop when button is released
        if (currentCommand !== 'stop') {
            sendCommand('stop');
            directionStatus.textContent = 'STOP';
            
            // Activate stop button
            const stopBtn = document.getElementById('stop-btn');
            controlButtons.forEach(btn => btn.classList.remove('active'));
            stopBtn.classList.add('active');
            currentCommand = 'stop';
        }
    }
}

function sendCommand(command) {
    fetch('/control', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ command: command })
    })
    .then(response => response.json())
    .then(data => {
        console.log('Command sent:', data);
    })
    .catch(error => {
        console.error('Error sending command:', error);
    });
}

// Joystick control handlers
joystickArea.addEventListener('mousedown', startJoystickControl);
joystickArea.addEventListener('touchstart', startJoystickControl);

document.addEventListener('mousemove', moveJoystick);
document.addEventListener('touchmove', moveJoystick);

document.addEventListener('mouseup', stopJoystickControl);
document.addEventListener('touchend', stopJoystickControl);

function startJoystickControl(e) {
    e.preventDefault();
    isJoystickActive = true;
    controlMode.textContent = 'Joystick';
    
    // Remove active class from all buttons
    controlButtons.forEach(btn => btn.classList.remove('active'));
}

function moveJoystick(e) {
    if (!isJoystickActive) return;
    
    e.preventDefault();
    
    const rect = joystickArea.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    let clientX, clientY;
    
    if (e.type === 'touchmove') {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }
    
    let deltaX = clientX - centerX;
    let deltaY = clientY - centerY;
    
    // Calculate distance from center
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    const maxDistance = rect.width / 2 - 30; // 30px for stick radius
    
    // Limit joystick movement to circular area
    if (distance > maxDistance) {
        const angle = Math.atan2(deltaY, deltaX);
        deltaX = Math.cos(angle) * maxDistance;
        deltaY = Math.sin(angle) * maxDistance;
    }
    
    // Update joystick stick position
    joystickStick.style.transform = `translate(calc(-50% + ${deltaX}px), calc(-50% + ${deltaY}px))`;
    
    // Calculate normalized values (-100 to 100)
    const normalizedX = Math.round((deltaX / maxDistance) * 100);
    const normalizedY = Math.round((deltaY / maxDistance) * -100); // Invert Y for intuitive control
    
    // Update display
    joystickX.textContent = normalizedX;
    joystickY.textContent = normalizedY;
    
    // Update position
    joystickPosition = { x: normalizedX, y: normalizedY };
    
    // Send joystick data via socket
    socket.emit('joystick_move', joystickPosition);
    
    // Update direction status based on joystick position
    updateDirectionFromJoystick(normalizedX, normalizedY);
}

function stopJoystickControl(e) {
    if (!isJoystickActive) return;
    
    e.preventDefault();
    isJoystickActive = false;
    
    // Reset joystick position
    joystickStick.style.transform = 'translate(-50%, -50%)';
    joystickX.textContent = '0';
    joystickY.textContent = '0';
    
    // Send stop position
    socket.emit('joystick_move', { x: 0, y: 0 });
    
    // Update status
    directionStatus.textContent = 'STOP';
    currentCommand = 'stop';
    
    // Activate stop button
    const stopBtn = document.getElementById('stop-btn');
    controlButtons.forEach(btn => btn.classList.remove('active'));
    stopBtn.classList.add('active');
}

function updateDirectionFromJoystick(x, y) {
    const threshold = 20; // Minimum value to register movement
    
    if (Math.abs(x) < threshold && Math.abs(y) < threshold) {
        directionStatus.textContent = 'STOP';
        return;
    }
    
    // Determine primary direction
    if (Math.abs(y) > Math.abs(x)) {
        if (y > threshold) {
            directionStatus.textContent = 'FORWARD';
        } else if (y < -threshold) {
            directionStatus.textContent = 'BACKWARD';
        }
    } else {
        if (x > threshold) {
            directionStatus.textContent = 'RIGHT';
        } else if (x < -threshold) {
            directionStatus.textContent = 'LEFT';
        }
    }
}

// Keyboard controls (optional enhancement)
document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    
    switch(key) {
        case 'w':
        case 'arrowup':
            handleButtonPress(document.getElementById('forward-btn'));
            break;
        case 's':
        case 'arrowdown':
            handleButtonPress(document.getElementById('backward-btn'));
            break;
        case 'a':
        case 'arrowleft':
            handleButtonPress(document.getElementById('left-btn'));
            break;
        case 'd':
        case 'arrowright':
            handleButtonPress(document.getElementById('right-btn'));
            break;
        case ' ':
            e.preventDefault();
            handleButtonPress(document.getElementById('stop-btn'));
            break;
    }
});

document.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    
    switch(key) {
        case 'w':
        case 'arrowup':
            handleButtonRelease(document.getElementById('forward-btn'));
            break;
        case 's':
        case 'arrowdown':
            handleButtonRelease(document.getElementById('backward-btn'));
            break;
        case 'a':
        case 'arrowleft':
            handleButtonRelease(document.getElementById('left-btn'));
            break;
        case 'd':
        case 'arrowright':
            handleButtonRelease(document.getElementById('right-btn'));
            break;
    }
});

// Initialize - set stop button as active
document.addEventListener('DOMContentLoaded', () => {
    const stopBtn = document.getElementById('stop-btn');
    stopBtn.classList.add('active');
    
    console.log('Dashboard initialized');
    
    // Initialize servo controls
    initServoControls();
});

// Servo Control Functions
function initServoControls() {
    const servoSliders = document.querySelectorAll('.servo-slider-compact');
    const resetButton = document.getElementById('servo-reset');
    
    // Add event listeners to each slider
    servoSliders.forEach(slider => {
        slider.addEventListener('input', handleServoChange);
    });
    
    // Reset button handler
    resetButton.addEventListener('click', resetAllServos);
}

function handleServoChange(e) {
    const slider = e.target;
    const servoId = slider.dataset.servo;
    const angle = parseInt(slider.value);
    
    // Update display value
    const valueDisplay = document.getElementById(`servo${servoId}-value`);
    valueDisplay.textContent = `${angle}°`;
    
    // Add visual feedback
    valueDisplay.style.color = '#10b981';
    setTimeout(() => {
        valueDisplay.style.color = '#10b981';
    }, 200);
    
    // Send to server
    sendServoCommand(servoId, angle);
}

function sendServoCommand(servoId, angle) {
    fetch('/servo_control', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            servo_id: servoId,
            angle: angle
        })
    })
    .then(response => response.json())
    .then(data => {
        console.log(`Servo ${servoId} set to ${angle}°:`, data);
    })
    .catch(error => {
        console.error('Error setting servo:', error);
    });
}

function resetAllServos() {
    const servoSliders = document.querySelectorAll('.servo-slider-compact');
    
    servoSliders.forEach(slider => {
        slider.value = 90;
        const servoId = slider.dataset.servo;
        const valueDisplay = document.getElementById(`servo${servoId}-value`);
        valueDisplay.textContent = '90°';
        
        // Send reset command
        sendServoCommand(servoId, 90);
    });
    
    // Visual feedback on reset button
    const resetBtn = document.getElementById('servo-reset');
    resetBtn.style.transform = 'rotate(360deg)';
    setTimeout(() => {
        resetBtn.style.transform = 'rotate(0deg)';
    }, 500);
}
