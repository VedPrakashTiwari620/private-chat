const express = require('express');
const app     = express();
const helmet  = require('helmet');
const http    = require('http');
const server  = http.createServer(app);
const { Server } = require('socket.io');
const path = require('path');

// ── Firebase Admin (FCM push notifications) ─────────────────────────────────
// Setup: Firebase Console → Project Settings → Service Accounts → Generate Key
// Deploy env var: FIREBASE_SERVICE_ACCOUNT = contents of the JSON key file
let fcmMessaging = null;
try {
  const admin = require('firebase-admin');
  const raw   = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    fcmMessaging = admin.messaging();
    console.log('✅ FCM: Firebase Admin initialized — push notifications active');
  } else {
    console.log('ℹ️  FCM: Set FIREBASE_SERVICE_ACCOUNT env var to enable push notifications');
  }
} catch (e) {
  console.log('⚠️  FCM init failed (non-fatal):', e.message);
}

// In-memory FCM token store  role → device token
const fcmTokens = new Map();

/**
 * Send FCM push notification to a specific user role.
 * Silently fails if FCM is not configured or token is missing.
 */
async function sendFCM(toRole, { title, body }, data = {}) {
  const token = fcmTokens.get(toRole);
  if (!fcmMessaging || !token) return;
  try {
    await fcmMessaging.send({
      token,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])),
      android: {
        priority: 'high',
        notification: {
          channelId: 'gcapbank_call_channel',
          priority: 'max',
          defaultSound: true,
          defaultVibrateTimings: true,
          visibility: 'PUBLIC',
        },
      },
    });
  } catch (e) {
    console.log('FCM send failed (token may be stale):', e.code || e.message);
    if (e.code === 'messaging/registration-token-not-registered') {
      fcmTokens.delete(toRole);
    }
  }
}

// ── Security Headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: [
        "'self'",
        "https://*.firebaseio.com",
        "https://*.googleapis.com",
        "wss://*.firebaseio.com",
        "https://api.agora.io",
        "wss://*.agora.io",
      ],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://*.firebaseapp.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      fontSrc:    ["'self'", "https://cdnjs.cloudflare.com"],
      imgSrc:     ["'self'", "data:", "blob:", "https://firebasestorage.googleapis.com"],
      mediaSrc:   ["'self'", "blob:"],
    },
  },
  hsts:         { maxAge: 31536000, includeSubDomains: true, preload: true },
  xFrameOptions: { action: 'deny' },
}));

const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(express.static('public'));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── State ────────────────────────────────────────────────────────────────────
const activeSessions = new Map(); // role → socket.id
let pendingCall = null;           // { callerSocketId, data, timer }
const CALL_TIMEOUT_MS = 30_000;

function cancelPendingCall() {
  if (pendingCall) { clearTimeout(pendingCall.timer); pendingCall = null; }
}

// ── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  /* ─── PRESENCE ─── */
  socket.on('user-online', ({ email, role }) => {
    if (!role) return;

    // Kick duplicate session
    if (activeSessions.has(role)) {
      const oldId = activeSessions.get(role);
      if (oldId !== socket.id) {
        io.to(oldId).emit('security-kick');
        const old = io.sockets.sockets.get(oldId);
        if (old) old.disconnect(true);
      }
    }

    activeSessions.set(role, socket.id);
    socket.userRole = role;
    socket.broadcast.emit('partner-status', 'online');

    const partnerRole = role === 'user1' ? 'user2' : 'user1';
    if (activeSessions.has(partnerRole)) {
      socket.emit('partner-status', 'online');
      if (pendingCall && pendingCall.callerSocketId !== socket.id) {
        socket.emit('incoming-call', pendingCall.data);
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.userRole && activeSessions.get(socket.userRole) === socket.id) {
      activeSessions.delete(socket.userRole);
      if (pendingCall && pendingCall.callerSocketId === socket.id) {
        cancelPendingCall();
        socket.broadcast.emit('call-cancelled');
      }
      socket.broadcast.emit('partner-status', 'offline');
    }
  });

  /* ─── FCM TOKEN ─── */
  socket.on('fcm-token', ({ role, token }) => {
    if (role && token) {
      fcmTokens.set(role, token);
      console.log(`FCM token registered for ${role}`);
    }
  });

  /* ─── CALL SIGNALING ─── */
  socket.on('initiate-call', (data) => {
    cancelPendingCall();
    socket.broadcast.emit('incoming-call', data);

    // Push notification to receiver (even if app is killed)
    const callerRole   = socket.userRole;
    const receiverRole = callerRole === 'user1' ? 'user2' : 'user1';
    const callLabel    = data.type === 'video' ? '📹 Incoming Video Call' : '📞 Incoming Audio Call';
    sendFCM(receiverRole,
      { title: callLabel, body: 'Tap to answer...' },
      { type: 'call', callType: data.type || 'audio' }
    );

    const timer = setTimeout(() => {
      pendingCall = null;
      socket.emit('call-not-answered');
      socket.broadcast.emit('call-was-missed');
    }, CALL_TIMEOUT_MS);

    pendingCall = { callerSocketId: socket.id, data, timer };
  });

  socket.on('accept-call', () => { cancelPendingCall(); socket.broadcast.emit('call-accepted'); });
  socket.on('reject-call', () => { cancelPendingCall(); socket.broadcast.emit('call-rejected'); });
  socket.on('cancel-call', () => { cancelPendingCall(); socket.broadcast.emit('call-cancelled'); });

  /* ─── MESSAGE NOTIFICATION ─── */
  // Client emits this so the server can push FCM to offline partner
  socket.on('message-sent', ({ toRole, preview }) => {
    // Only send FCM if the partner is NOT currently online via socket
    if (!activeSessions.has(toRole)) {
      sendFCM(toRole,
        { title: '💬 New Message', body: preview || 'You have a new message' },
        { type: 'message' }
      );
    }
  });

  /* ─── WEBRTC / AGORA SIGNALING ─── */
  socket.on('offer',         (d) => socket.broadcast.emit('offer',         d));
  socket.on('answer',        (d) => socket.broadcast.emit('answer',        d));
  socket.on('ice-candidate', (d) => socket.broadcast.emit('ice-candidate', d));
  socket.on('end-call',      ()  => socket.broadcast.emit('call-ended'));

  /* ─── HOLD / RESUME (native GSM call interruption) ─── */
  socket.on('call-hold',   () => socket.broadcast.emit('call-held'));
  socket.on('call-resume', () => socket.broadcast.emit('call-resumed'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
