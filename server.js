const express = require('express');
const app     = express();
const helmet  = require('helmet');
const http    = require('http');
const server  = http.createServer(app);
const { Server } = require('socket.io');

// Enable rigorous Header Security using Helmet
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            connectSrc: ["'self'", "https://*.firebaseio.com", "https://*.googleapis.com", "wss://*.firebaseio.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://*.firebaseapp.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https://dummyimage.com", "blob:"],
            mediaSrc: ["'self'", "blob:"] // For WebRTC streams
        }
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    xFrameOptions: { action: "deny" } // 100% blocks Clickjacking / iFrame embedding
}));

const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });
const path = require('path');

app.use(express.static('public'));
app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
/* ── Presence (Strict Single Session) ── */
const activeSessions = new Map(); // role -> socket.id

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

    /* ─── PRESENCE & PROTOCOL ─── */
    socket.on('user-online', ({ email, role }) => {
        if (!role) return;

        // 1. Strict Security: Session Hijack / Multi-Login Prevention
        if (activeSessions.has(role)) {
            const oldSocketId = activeSessions.get(role);
            if (oldSocketId !== socket.id) {
                // Kick out the old session and alert them of the security breach!
                io.to(oldSocketId).emit('security-kick');
                const oldSocket = io.sockets.sockets.get(oldSocketId);
                if (oldSocket) oldSocket.disconnect(true);
            }
        }

        // 2. Register current valid session
        activeSessions.set(role, socket.id);
        socket.userRole = role;

        // 3. Notify the Partner (since there's max 1 other socket, broadcast targets only partner)
        socket.broadcast.emit('partner-status', 'online');

        // 4. Notify THIS socket if the partner is ALREADY online
        const partnerRole = role === 'user1' ? 'user2' : 'user1';
        if (activeSessions.has(partnerRole)) {
            socket.emit('partner-status', 'online');

            // Deliver pending delayed call
            if (pendingCall && pendingCall.callerSocketId !== socket.id) {
                socket.emit('incoming-call', pendingCall.data);
            }
        }
    });

    socket.on('disconnect', () => {
        // Only broadcast offline if the disconnected socket was the explicitly AUTHORIZED active session
        if (socket.userRole && activeSessions.get(socket.userRole) === socket.id) {
            activeSessions.delete(socket.userRole);

            // If the CALLER disconnected, cancel the pending call ring
            if (pendingCall && pendingCall.callerSocketId === socket.id) {
                cancelPendingCall();
                socket.broadcast.emit('call-cancelled');
            }

            socket.broadcast.emit('partner-status', 'offline');
        }
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
// Force Render redeploy
