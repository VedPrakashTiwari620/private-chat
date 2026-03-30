const express = require('express');
const app     = express();
const http    = require('http');
const server  = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });
const path = require('path');

app.use(express.static('public'));
app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
/* ── Presence ── */
const onlineSockets = new Set();

/* ── Pending call (for Scenario 1: late join) ── */
let pendingCall = null; // { callerSocketId, data, timer }

function cancelPendingCall() {
    if (pendingCall) {
        clearTimeout(pendingCall.timer);
        pendingCall = null;
    }
}

const CALL_TIMEOUT_MS = 30000; // 30 seconds ring time

io.on('connection', (socket) => {

    /* ─── PRESENCE ─── */
    socket.on('user-online', (email) => {
        socket.userEmail = email;
        onlineSockets.add(socket.id);

        // Tell partner this user just came online
        socket.broadcast.emit('partner-status', 'online');

        // Tell THIS user if partner is already online
        if (onlineSockets.size > 1) {
            socket.emit('partner-status', 'online');

            // Scenario 1: Partner joined late — deliver pending incoming call
            if (pendingCall && pendingCall.callerSocketId !== socket.id) {
                socket.emit('incoming-call', pendingCall.data);
            }
        }
    });

    socket.on('disconnect', () => {
        onlineSockets.delete(socket.id);

        // If the CALLER disconnected, cancel the pending call ring
        if (pendingCall && pendingCall.callerSocketId === socket.id) {
            cancelPendingCall();
            socket.broadcast.emit('call-cancelled');
        }

        socket.broadcast.emit('partner-status', 'offline');
    });

    /* ─── CALL SIGNALING ─── */
    socket.on('initiate-call', (data) => {
        cancelPendingCall(); // safety: clear any leftover call

        // Deliver to any already-online partner
        socket.broadcast.emit('incoming-call', data);

        // ★ 30-second auto-timeout (Scenario 2)
        const timer = setTimeout(() => {
            pendingCall = null;
            socket.emit('call-not-answered');         // → caller: auto-close UI
            socket.broadcast.emit('call-was-missed'); // → receiver (if online): close incoming UI
        }, CALL_TIMEOUT_MS);

        pendingCall = { callerSocketId: socket.id, data, timer };
    });

    socket.on('accept-call', () => {
        cancelPendingCall();
        socket.broadcast.emit('call-accepted');
    });

    socket.on('reject-call', () => {
        cancelPendingCall();
        socket.broadcast.emit('call-rejected'); // tells caller
    });

    socket.on('cancel-call', () => {
        cancelPendingCall();
        socket.broadcast.emit('call-cancelled'); // tells receiver
    });

    /* ─── WEBRTC ─── */
    socket.on('offer',         (d) => socket.broadcast.emit('offer',         d));
    socket.on('answer',        (d) => socket.broadcast.emit('answer',        d));
    socket.on('ice-candidate', (d) => socket.broadcast.emit('ice-candidate', d));
    socket.on('end-call',      ()  => socket.broadcast.emit('call-ended'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
