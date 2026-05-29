import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import { signOut } from 'firebase/auth';
import { encryptData, decryptData } from '../utils/crypto.js';
import {
  collection, addDoc, onSnapshot, query, where,
  doc, updateDoc, arrayUnion, serverTimestamp,
  getDocs, writeBatch, setDoc, getDoc, Timestamp, deleteDoc
} from 'firebase/firestore';
import { auth, db } from '../firebase.js';
import { useAuth } from '../context/AuthContext.jsx';
import { formatTime, formatLastSeen } from '../utils/helpers.js';
import AgoraRTC from 'agora-rtc-sdk-ng';

// ── Push Notifications (FCM) ─
const PushNotifications = window.Capacitor?.Plugins?.PushNotifications ?? null;

// Agora.io — 10,000 free minutes/month, resets monthly
// Works across ALL networks: WiFi, mobile data, different cities, different countries
const AGORA_APP_ID  = import.meta.env.VITE_AGORA_APP_ID || '82d2a689a7a34616a90ffd778665e86a';
const AGORA_CHANNEL = 'gcapbank-private'; // fixed private channel for this 2-person app



export default function ChatPage() {
  const { currentUser } = useAuth();
  const navigate        = useNavigate();
  const role            = localStorage.getItem('userRole');
  const partnerRole     = role === 'user1' ? 'user2' : 'user1';

  /* ── STATE ── */
  const [messages,     setMessages]     = useState([]);
  const [text,         setText]         = useState('');
  const [pOnline,      setPOnline]      = useState(false);
  const [pStatus,      setPStatus]      = useState('Offline');
  const [showCall,     setShowCall]     = useState(false);
  const [showIncoming, setShowIncoming] = useState(false);
  const [incomingData, setIncomingData] = useState(null);
  const [callType,        setCallType]        = useState(null);
  const [audioMuted,      setAudioMuted]      = useState(false);
  const [videoOff,        setVideoOff]        = useState(false);
  const [speakerOn,       setSpeakerOn]       = useState(false);
  const [showCamera,      setShowCamera]      = useState(false);
  const [facingMode,      setFacingMode]      = useState('environment');
  const [callStatus,      setCallStatus]      = useState('ringing');
  const [callCamFacing,   setCallCamFacing]   = useState('user');
  const [callDuration,    setCallDuration]    = useState(0);
  const [pTyping,         setPTyping]         = useState(false);
  const [nativeCallActive, setNativeCallActive] = useState(false);
  const [callMinimized,   setCallMinimized]   = useState(false);
  const [remoteHeld,      setRemoteHeld]      = useState(false);
  const [inPiP,           setInPiP]           = useState(false);

  // ★ Signal features
  const [replyTo,         setReplyTo]         = useState(null);  // message being replied to
  const [editingMsg,      setEditingMsg]       = useState(null);  // message being edited
  const [searchQuery,     setSearchQuery]     = useState('');
  const [searchMode,      setSearchMode]      = useState(false);
  const [ctxMenu,         setCtxMenu]         = useState(null);  // { msg, x, y }
  const [disappearTimer,  setDisappearTimer]  = useState(0);     // 0=off, seconds
  const [showDisappearMenu, setShowDisappearMenu] = useState(false);
  const [showReactions,   setShowReactions]   = useState(null);  // msg.id showing picker

  /* ── CALL TIMER LOGIC ── */
  const timerRef = useRef(null);
  
  useEffect(() => {
    if (callStatus === 'connected') {
      setCallDuration(0);
      timerRef.current = setInterval(() => setCallDuration(p => p + 1), 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [callStatus]);

  const formatDuration = sec => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  /* ── REFS ── */
  const socketRef        = useRef(null);
  const agoraClient      = useRef(null);  // Agora RTC client (replaces RTCPeerConnection)
  const localAudioTrack  = useRef(null);  // Agora local mic track
  const localVideoTrack  = useRef(null);  // Agora local camera track
  const camStream        = useRef(null);
  const callTypeRef      = useRef(null);
  const callerRef        = useRef(false);
  const activeRef        = useRef(false);
  const localVid         = useRef(null);
  const remoteVid        = useRef(null);
  const camPreview       = useRef(null);
  const camCanvas        = useRef(null);
  const galleryInput     = useRef(null);
  const msgEnd           = useRef(null);
  const typingTimerRef   = useRef(null);
  const audioMutedRef    = useRef(false);

  /* ── PRESENCE ── */
  const writeMyPresence = useCallback(async (online) => {
    if (!role) return;
    try {
      await setDoc(doc(db, 'presence', role), {
        online,
        // ★ Use Timestamp.now() (client-side) instead of serverTimestamp()
        //   so the write succeeds even during beforeunload with no server round-trip
        lastSeen: online ? null : Timestamp.now()
      });
    } catch {}
  }, [role]);

  // ★ Read partner's lastSeen on mount (for already-offline partners)
  useEffect(() => {
    if (!partnerRole) return;
    getDoc(doc(db, 'presence', partnerRole)).then(snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      if (d.online !== true && d.lastSeen?.toDate) {
        setPStatus(formatLastSeen(d.lastSeen));
      }
    }).catch(() => {});
  }, []);

  /* ── NATIVE PLUGIN HELPERS (Capacitor Android only — safe no-op on browser) ── */
  const nativePlugin = () => window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins.AudioRoute : null;

  // ★ Route audio to EARPIECE (front speaker) — call BEFORE join() per Agora guide
  // Equivalent to setDefaultAudioRouteToSpeakerphone(false) in native Agora SDK
  const nativeStartEarpiece = useCallback(() => {
    try { nativePlugin()?.startEarpiece(); } catch (e) { console.warn('startEarpiece:', e); }
  }, []);

  // ★ Route audio to SPEAKERPHONE — called when user taps speaker toggle
  // Equivalent to setEnableSpeakerphone(true) in native Agora SDK
  const nativeStartSpeaker = useCallback(() => {
    try { nativePlugin()?.startSpeaker(); } catch (e) { console.warn('startSpeaker:', e); }
  }, []);

  // Reset audio mode after call
  const nativeStopAudio = useCallback(() => {
    try { nativePlugin()?.stopAudio(); } catch (e) { console.warn('stopAudio:', e); }
  }, []);

  // Play ringtone + vibration on incoming call
  const nativePlayRingtone = useCallback(async () => {
    try { await nativePlugin()?.playRingtone(); } catch (e) { console.warn('playRingtone:', e); }
  }, []);

  // Stop ringtone + vibration
  const nativeStopRingtone = useCallback(() => {
    try { nativePlugin()?.stopRingtone(); } catch (e) { console.warn('stopRingtone:', e); }
  }, []);

  // Save image to phone gallery via native MediaStore
  const nativeSaveImage = useCallback(async (base64, filename) => {
    try {
      const plugin = nativePlugin();
      if (!plugin) return false;
      await plugin.saveImageToGallery({ base64, filename: filename || `GCapBank_${Date.now()}.jpg` });
      return true;
    } catch (e) { console.warn('saveImageToGallery:', e); return false; }
  }, []);

  /* ── CALL HELPERS ── */

  // ★ Agora: stop all tracks and leave channel cleanly
  const agoraLeave = useCallback(async () => {
    try { localAudioTrack.current?.close(); } catch {}
    try { localVideoTrack.current?.close(); } catch {}
    localAudioTrack.current = null;
    localVideoTrack.current = null;
    try { await agoraClient.current?.leave(); } catch {}
  }, []);

  const endCall = useCallback(async () => {
    nativeStopRingtone();
    nativeStopAudio();
    // Tell native: call ended
    try { nativePlugin()?.setCallActive({ active: false }); } catch {}
    try { nativePlugin()?.stopForegroundService(); } catch {}
    try { nativePlugin()?.stopProximitySensor(); } catch {}
    try { nativePlugin()?.abandonAudioFocus(); } catch {}
    activeRef.current = false;
    setShowCall(false);
    setShowIncoming(false);
    setCallStatus('ringing');
    setCallCamFacing('user');
    setNativeCallActive(false);
    setCallMinimized(false);
    setRemoteHeld(false);
    setInPiP(false);
    setSpeakerOn(false);
    audioMutedRef.current = false;
    await agoraLeave();
    if (localVid.current)  localVid.current.srcObject  = null;
    if (remoteVid.current) remoteVid.current.srcObject = null;
    setAudioMuted(false);
    setVideoOff(false);
  }, [nativeStopAudio, nativeStopRingtone, agoraLeave]);

  // ★ Agora: join channel, create and publish local tracks
  const agoraJoin = useCallback(async (type) => {
    // Initialize client once
    if (!agoraClient.current) {
      const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });

      // Remote user published their tracks — subscribe and play
      client.on('user-published', async (user, mediaType) => {
        try {
          await client.subscribe(user, mediaType);
          if (mediaType === 'video' && remoteVid.current) {
            user.videoTrack.play(remoteVid.current);
          }
          if (mediaType === 'audio') {
            user.audioTrack.play();
            // ★ Re-confirm routing after remote audio arrives (800ms delay as safety net)
            setTimeout(() => nativeStartEarpiece(), 800);
          }
        } catch (e) { console.warn('Agora subscribe error:', e); }
      });

      client.on('user-unpublished', (user, mediaType) => {
        if (mediaType === 'video' && remoteVid.current) {
          remoteVid.current.srcObject = null;
        }
      });

      agoraClient.current = client;
    }

    try {
      // Create microphone audio track
      localAudioTrack.current = await AgoraRTC.createMicrophoneAudioTrack({
        encoderConfig: { sampleRate: 48000, bitrate: 128, stereo: false },
        AEC: true, ANS: true, AGC: true,
      });

      // Create camera video track for video calls
      if (type === 'video') {
        localVideoTrack.current = await AgoraRTC.createCameraVideoTrack({
          encoderConfig: { width: 1280, height: 720, frameRate: 30, bitrateMax: 2000 },
          facingMode: 'user',
        });
      }

      // ★ STEP 1: Request audio focus BEFORE join (ducks music, ensures voice comm priority)
      try { await nativePlugin()?.requestAudioFocus(); } catch {}

      // UID: user1=1, user2=2 (unique integers per channel)
      const uid = role === 'user1' ? 1 : 2;

      // ★ STEP 2: Set earpiece BEFORE join() — setDefaultAudioRouteToSpeakerphone(false) equivalent
      nativeStartEarpiece();

      await agoraClient.current.join(AGORA_APP_ID, AGORA_CHANNEL, null, uid);

      const tracks = [localAudioTrack.current, localVideoTrack.current].filter(Boolean);
      await agoraClient.current.publish(tracks);

      // ★ STEP 3: Tell MainActivity call is active (PiP auto-trigger on Home press)
      try { nativePlugin()?.setCallActive({ active: true }); } catch {}

      // ★ STEP 4: Start foreground service — persistent notification + keeps app alive
      try { nativePlugin()?.startForegroundService({ callType: type }); } catch {}

      // ★ STEP 5: Enable proximity sensor — screen off when near ear
      try { nativePlugin()?.startProximitySensor(); } catch {}

      // ★ STEP 6: Re-confirm earpiece 800ms after publish (Agora audio fully ready)
      setTimeout(() => nativeStartEarpiece(), 800);

      // Show local video preview
      if (type === 'video') {
        setTimeout(() => {
          if (localVid.current && localVideoTrack.current) {
            localVideoTrack.current.play(localVid.current);
          }
        }, 80);
      }
    } catch (e) {
      alert('Could not access camera/mic: ' + e.message);
      throw e;
    }
  }, [role]);

  const getParticipants = () => {
    return [import.meta.env.VITE_USER1_UID || "UID1", import.meta.env.VITE_USER2_UID || "UID2"];
  };

  const logCallEvent = async (event, cType) => {
    try {
      await addDoc(collection(db, 'messages'), {
        isSystemEvent: true, event, callType: cType,
        sender: currentUser.email,
        participants: getParticipants(),
        deletedFor: [], seenBy: [], timestamp: serverTimestamp()
      });
    } catch { /* suppress */ }
  };

  // ★ Agora: caller already joined channel in initiateCall.
  // When callee joins and publishes, user-published fires automatically on BOTH sides.
  const handleCallAccepted = useCallback(async () => {
    activeRef.current = true;
    setCallStatus('connected');
    if (callerRef.current) logCallEvent('started', callTypeRef.current);
  }, []);

  const handleCallRejected = useCallback(() => {
    logCallEvent('missed', callTypeRef.current);
    setCallStatus('declined');
    setTimeout(() => endCall(), 2500);
  }, [endCall]);

  // ★ Server 30s auto-timeout — nobody answered (Scenario 2)
  const handleCallNotAnswered = useCallback(() => {
    logCallEvent('not_answered', callTypeRef.current);
    setCallStatus('not_answered');
    // Show "Not Answered" on screen for 2.5s then auto-close
    setTimeout(() => endCall(), 2500);
  }, [endCall]);

  // ★ Receiver: close incoming UI when call timed out server-side
  const handleCallWasMissed = useCallback(() => {
    setShowIncoming(false);
  }, []);

  // Caller cancelled before answer
  const handleCallCancelled = useCallback(() => {
    nativeStopRingtone();
    setShowIncoming(false);
    endCall();
  }, [endCall, nativeStopRingtone]);

  /* ── TYPING HELPERS ── */
  const writeTyping = useCallback(async (isTyping) => {
    if (!role) return;
    try { await updateDoc(doc(db, 'presence', role), { typing: isTyping }); } catch {}
  }, [role]);

  const handleTypingInput = useCallback((val) => {
    setText(val);
    writeTyping(true);
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => writeTyping(false), 3000);
  }, [writeTyping]);

  /* ── MAIN SETUP ── */
  useEffect(() => {
    if (!role) { navigate('/select', { replace: true }); return; }

    // NOTE: Camera/mic permissions are handled automatically by Capacitor's WebView
    // when getUserMedia() is called — do NOT call ActivityCompat.requestPermissions()
    // at startup, it pauses the Activity and causes WebView to go blank!

    // Mark me online in Firestore
    writeMyPresence(true);

    // Connect to backend — explicit URL needed since app now loads from
    // bundled local assets (server.url removed from capacitor.config.json)
    const BACKEND = import.meta.env.VITE_BACKEND_URL || 'https://gcapbank.onrender.com';
    const socket = io(BACKEND, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });
    socketRef.current = socket;
    socket.emit('user-online', { email: currentUser.email, role });

    // Single-Session Enforcement
    socket.on('security-kick', () => {
      const toast = document.createElement('div');
      toast.innerHTML = `<i class="fas fa-shield-alt" style="margin-right:10px;color:#ff5e98;"></i>Account logged in by another device`;
      Object.assign(toast.style, {
        position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
        background: '#1f1f1f', color: '#e9edef', padding: '14px 22px',
        borderRadius: '12px', fontSize: '14px', fontWeight: '600',
        boxShadow: '0 8px 30px rgba(0,0,0,0.6)', zIndex: '99999',
        border: '1px solid rgba(255,94,152,0.4)', display: 'flex',
        alignItems: 'center', fontFamily: 'Inter,sans-serif',
      });
      document.body.appendChild(toast);
      setTimeout(() => { document.body.removeChild(toast); handleLogout(); }, 2500);
    });

    // Re-send user-online on socket reconnect
    socket.on('reconnect', () => socket.emit('user-online', { email: currentUser.email, role }));

    // Partner online/offline status via socket
    socket.on('partner-status', async (status) => {
      if (status === 'online') {
        setPOnline(true);
        setPStatus('Online');
      } else {
        setPOnline(false);
        setPTyping(false);
        setPStatus('Offline');
        if (activeRef.current || callTypeRef.current !== null) endCall();
        setTimeout(async () => {
          try {
            const snap = await getDoc(doc(db, 'presence', partnerRole));
            const data = snap.exists() ? snap.data() : null;
            const ls = data?.lastSeen?.toDate ? formatLastSeen(data.lastSeen) : 'Offline';
            setPStatus(ls);
          } catch { setPStatus('Offline'); }
        }, 2000);
      }
    });

    // Incoming call — play ringtone
    socket.on('incoming-call', data => {
      callerRef.current  = false;
      callTypeRef.current = data.type;
      setIncomingData(data);
      setShowIncoming(true);
      nativePlayRingtone(); // ★ ring + vibrate
    });

    socket.on('call-accepted',     handleCallAccepted);
    socket.on('call-rejected',     handleCallRejected);
    socket.on('call-not-answered', handleCallNotAnswered);
    socket.on('call-was-missed',   handleCallWasMissed);
    socket.on('call-cancelled',    handleCallCancelled);
    // offer/answer/ice-candidate NOT needed — Agora handles media internally
    socket.on('call-ended', () => { if (activeRef.current) logCallEvent('ended', callTypeRef.current); endCall(); });
    // ★ WhatsApp-style hold: partner answered a native call
    socket.on('call-held',    () => setRemoteHeld(true));
    socket.on('call-resumed', () => setRemoteHeld(false));

    // Messages listener — with error handler to prevent crash on permission error
    const q = query(collection(db, 'messages'), where('participants', 'array-contains', currentUser.uid));
    const unsubMsg = onSnapshot(q, snap => {
      const msgs = [];
      snap.forEach(d => {
        const data = d.data();
        if (!data.deletedFor?.includes(currentUser.email)) {
          if (data.text)     data.text     = decryptData(data.text);
          if (data.imageUrl) data.imageUrl = decryptData(data.imageUrl);
          msgs.push({ id: d.id, ...data });
        }
      });
      msgs.sort((a, b) => (a.timestamp?.seconds || 0) - (b.timestamp?.seconds || 0));
      setMessages(msgs);
    }, (err) => {
      // Firestore permission error — fail silently, don't crash
      console.warn('Messages listener error:', err.code, err.message);
    });

    // ★ Firestore real-time listener for partner TYPING state
    // Wrapped in try/catch + error handler to gracefully handle security rule rejections
    let unsubTyping = () => {}; // default no-op unsubscribe
    try {
      unsubTyping = onSnapshot(
        doc(db, 'presence', partnerRole),
        snap => {
          if (!snap.exists()) return;
          const d = snap.data();
          setPTyping(d.typing === true && d.online === true);
        },
        err => {
          // Permission denied — typing indicator won't work, but app doesn't crash
          console.warn('Typing listener error (non-fatal):', err.code);
          setPTyping(false);
        }
      );
    } catch (e) {
      console.warn('Could not start typing listener:', e);
    }

    // ★ Native phone call state — auto-mute WebRTC when native call arrives
    // ★ "End Call" from notification button → end the call from JS side
    let notifEndSub = null;
    const plugin = nativePlugin();
    if (plugin?.addListener) {
      Promise.resolve(
        plugin.addListener('callEndedFromNotification', () => {
          if (activeRef.current) endCall();
        })
      ).then(h => { notifEndSub = h; }).catch(() => {});
    }

    // Native phone call state listener (GSM → mute Agora)
    let nativeCallSub = null;
    if (plugin?.addListener) {
      // Capacitor native addListener() can return EITHER:
      //   a) Promise<PluginListenerHandle>  (web/PWA)
      //   b) PluginListenerHandle directly  (Android native bridge)
      // Promise.resolve() safely wraps both cases.
      Promise.resolve(
        plugin.addListener('nativeCallState', (data) => {
          if (data.state === 'active') {
            // Native call started — mute app call audio + signal partner
            setNativeCallActive(true);
            localAudioTrack.current?.setEnabled(false);
            socketRef.current?.emit('call-hold'); // ★ tell partner: show HOLD
          } else if (data.state === 'idle') {
            // Native call ended — restore app call audio + signal partner
            setNativeCallActive(false);
            if (!audioMutedRef.current) {
              localAudioTrack.current?.setEnabled(true);
            }
            socketRef.current?.emit('call-resume'); // ★ tell partner: remove HOLD
          }
        })
      ).then(handle => { nativeCallSub = handle; }).catch(() => {});
    }

    // Presence
    const handleVis = () => writeMyPresence(!document.hidden);
    document.addEventListener('visibilitychange', handleVis);
    window.addEventListener('beforeunload', () => writeMyPresence(false));

    // ★ PiP state listener: MainActivity notifies JS when PiP starts/ends
    const handlePiP = (e) => {
      const isInPiP = e.detail?.inPiP ?? false;
      setInPiP(isInPiP);
      if (!isInPiP && activeRef.current) {
        // PiP exited — restore full call screen
        setShowCall(true);
        setCallMinimized(false);
      }
    };
    window.addEventListener('pip-state', handlePiP);

    // Android hardware back button
    // ★ FIX: Use activeRef (not showCall state) to avoid stale closure bug
    // showCall captured in closure would always be false (initial value)
    const handleBackBtn = () => {
      if (activeRef.current) {
        // Call is active — for video calls: enter PiP; for audio: minimize with banner
        if (callTypeRef.current === 'video') {
          // Try native PiP first (Android 8+), fallback to JS minimize
          try {
            nativePlugin()?.enterPiP();
          } catch {}
        }
        setShowCall(false);
        setCallMinimized(true);
      } else {
        navigate('/select', { replace: true });
      }
    };
    document.addEventListener('backbutton', handleBackBtn, false);

    return () => {
      socket.disconnect();
      unsubMsg();
      unsubTyping();
      nativeCallSub?.remove?.();
      notifEndSub?.remove?.();
      endCall();
      writeTyping(false);
      clearTimeout(typingTimerRef.current);
      writeMyPresence(false);
      document.removeEventListener('visibilitychange', handleVis);
      document.removeEventListener('backbutton', handleBackBtn, false);
      window.removeEventListener('pip-state', handlePiP);
    };
  }, [role]);


  // Scroll to bottom
  useEffect(() => { msgEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // ★ Mark partner's messages as SEEN when visible
  useEffect(() => {
    if (!messages.length || !role || document.hidden) return;
    const batch = writeBatch(db);
    let dirty = false;
    messages.forEach(msg => {
      if (msg.sender !== currentUser.email && !msg.seenBy?.includes(role) && !msg.isSystemEvent) {
        batch.update(doc(db, 'messages', msg.id), { seenBy: arrayUnion(role) });
        dirty = true;
      }
    });
    if (dirty) batch.commit().catch(console.error);
  }, [messages]);

  // ★ Disappearing messages — auto-delete expired messages from UI
  useEffect(() => {
    if (!messages.length) return;
    const now = Date.now();
    messages.forEach(msg => {
      if (msg.expiresAt) {
        const expMs = msg.expiresAt?.toDate?.()?.getTime?.() || 0;
        if (expMs > 0 && expMs <= now) {
          deleteDoc(doc(db, 'messages', msg.id)).catch(() => {});
        }
      }
    });
  }, [messages]);

  // ★ Register FCM token for push notifications (background/killed app)
  useEffect(() => {
    const registerFCM = async () => {
      if (!PushNotifications || !socketRef.current) return;
      try {
        const perm = await PushNotifications.requestPermissions();
        if (perm.receive !== 'granted') return;
        await PushNotifications.register();
        PushNotifications.addListener('registration', ({ value: token }) => {
          socketRef.current?.emit('fcm-token', { role, token });
        });
        // When notification tapped while app is in background
        PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const data = action.notification.data;
          if (data?.type === 'call' && !activeRef.current) {
            // App was opened from call notification — socket will deliver incoming-call
          }
        });
      } catch (e) { console.warn('FCM setup:', e); }
    };
    // Delay slightly to ensure socket is connected
    const t = setTimeout(registerFCM, 2000);
    return () => clearTimeout(t);
  }, [role]);

  /* ── MESSAGING ── */
  const sendMessage = async () => {
    // Edit mode
    if (editingMsg) {
      const newText = text.trim();
      if (newText && newText !== decryptData(editingMsg.text)) {
        try {
          await updateDoc(doc(db, 'messages', editingMsg.id), {
            text: encryptData(newText), edited: true, editedAt: serverTimestamp()
          });
        } catch (e) { console.error(e); }
      }
      setEditingMsg(null);
      setText('');
      return;
    }
    const t = text.trim(); if (!t) return;
    clearTimeout(typingTimerRef.current);
    writeTyping(false);
    try {
      const msgData = {
        text: encryptData(t),
        sender: currentUser.email,
        participants: getParticipants(),
        deletedFor: [], seenBy: [],
        timestamp: serverTimestamp(),
        reactions: {}, starred: [],
        edited: false, deletedForEveryone: false,
      };
      if (replyTo) {
        msgData.replyTo = { id: replyTo.id, text: replyTo.text, sender: replyTo.sender };
      }
      if (disappearTimer > 0) {
        const exp = new Date(Date.now() + disappearTimer * 1000);
        msgData.expiresAt = Timestamp.fromDate(exp);
      }
      await addDoc(collection(db, 'messages'), msgData);
      setText('');
      setReplyTo(null);
      // FCM to offline partner
      socketRef.current?.emit('message-sent', { toRole: partnerRole, preview: t.substring(0, 60) });
    } catch (e) { console.error(e); }
  };

  const deleteMsg = async msg => {
    if (!window.confirm('Delete this message?')) return;
    try {
      if (msg.deletedFor?.length === 1 && !msg.deletedFor.includes(currentUser.email)) {
        await deleteDoc(doc(db, 'messages', msg.id));
      } else {
        await updateDoc(doc(db, 'messages', msg.id), { deletedFor: arrayUnion(currentUser.email) });
      }
    } catch (e) { console.error('Delete failed:', e); }
  };

  // ★ Delete for everyone (Signal/WhatsApp style)
  const deleteForEveryone = async msg => {
    if (!window.confirm('Delete for everyone?')) return;
    try {
      await updateDoc(doc(db, 'messages', msg.id), {
        deletedForEveryone: true,
        text: encryptData('This message was deleted'),
      });
    } catch (e) { console.error(e); }
  };

  // ★ Emoji reaction
  const reactToMessage = async (msg, emoji) => {
    const reactions = { ...(msg.reactions || {}) };
    const cur = reactions[emoji] || [];
    if (cur.includes(role)) {
      const updated = cur.filter(r => r !== role);
      if (updated.length === 0) delete reactions[emoji];
      else reactions[emoji] = updated;
    } else {
      reactions[emoji] = [...cur, role];
    }
    try { await updateDoc(doc(db, 'messages', msg.id), { reactions }); } catch (e) { console.error(e); }
  };

  // ★ Star/unstar
  const toggleStar = async msg => {
    const starred = msg.starred || [];
    const next = starred.includes(role) ? starred.filter(r => r !== role) : [...starred, role];
    try { await updateDoc(doc(db, 'messages', msg.id), { starred: next }); } catch (e) { console.error(e); }
  };

  // ★ Filtered messages for search
  const visibleMessages = searchMode && searchQuery
    ? messages.filter(m => {
        if (m.isSystemEvent) return false;
        try { return decryptData(m.text)?.toLowerCase().includes(searchQuery.toLowerCase()); }
        catch { return false; }
      })
    : messages;

  const clearChat = async () => {
    if (!window.confirm('Clear entire chat history for yourself?')) return;
    try {
      const q = query(collection(db, 'messages'), where('participants', 'array-contains', currentUser.uid));
      const snap  = await getDocs(q);
      const batch = writeBatch(db);
      snap.docs.forEach(d => {
        const data = d.data();
        if (!data.deletedFor?.includes(currentUser.email)) {
          // If already deleted by partner, deleteDoc completely. Otherwise, just hide for self.
          if (data.deletedFor && data.deletedFor.length === 1 && !data.deletedFor.includes(currentUser.email)) {
             batch.delete(d.ref); 
          } else {
             batch.update(d.ref, { deletedFor: arrayUnion(currentUser.email) });
          }
        }
      });
      await batch.commit();
    } catch (e) {
      console.error("Clear chat blocked: ", e);
    }
  };

  /* ── IMAGE ── */
  const compressAndSend = file => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = async () => {
        const c = document.createElement('canvas');
        // Aggressive compression: max 800px, 0.70 quality to ensure AES encrypted text payload stays safely under 1MB limit
        const MAX = 800;
        let [w, h] = [img.width, img.height];
        if (w > h && w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
        else if (h > MAX)     { w = Math.round(w * MAX / h); h = MAX; }
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        await sendImage(c.toDataURL('image/jpeg', 0.70));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  const sendImage = async dataUrl => {
    try {
      // Due to Firebase Storage free-tier region limitations, we store the compressed
      // Base64 image completely AES ENCRYPTED directly inside the Firestore Document!
      // This is even more secure since no physical image file or public URL ever exists online!
      await addDoc(collection(db, 'messages'), {
        imageUrl: encryptData(dataUrl), 
        sender: currentUser.email,
        participants: getParticipants(),
        deletedFor: [], seenBy: [], timestamp: serverTimestamp()
      });
    } catch (e) { 
      console.error("Firestore image upload error: ", e);
      alert('Upload failed. Image may be too large or there was a network error.'); 
    }
  };

  /* ── CAMERA ── */
  const openCamera = async () => {
    setShowCamera(true);
    try {
      if (camStream.current) camStream.current.getTracks().forEach(t => t.stop());
      // ★ 1080p — works on all phones (back & front), 4K caused failures
      camStream.current = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width:  { ideal: 1920 },
          height: { ideal: 1080 },
        }
      });
      if (camPreview.current) camPreview.current.srcObject = camStream.current;
    } catch { setShowCamera(false); alert('Camera access denied.'); }
  };

  const closeCamera = () => {
    camStream.current?.getTracks().forEach(t => t.stop());
    camStream.current = null; setShowCamera(false);
  };

  const switchCamera = () => {
    const next = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(next);
    camStream.current?.getTracks().forEach(t => t.stop());
    setTimeout(async () => {
      try {
        // ★ 1080p for both cameras
        camStream.current = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: next }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        });
        if (camPreview.current) camPreview.current.srcObject = camStream.current;
      } catch {}
    }, 100);
  };

  const takePhoto = () => {
    if (!camStream.current || !camPreview.current) return;
    const canvas = camCanvas.current;
    
    // Aggressive resize engine (same as gallery) to avoid 1MB AES Firestore crash
    const MAX = 800;
    let w = camPreview.current.videoWidth;
    let h = camPreview.current.videoHeight;
    
    if (w > h && w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
    else if (h > MAX)     { w = Math.round(w * MAX / h); h = MAX; }
    
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    
    // Artificial Exposure / Brightness boost for low-light WebRTC capture
    ctx.filter = 'brightness(1.2) contrast(1.1)';
    ctx.drawImage(camPreview.current, 0, 0, w, h);
    
    closeCamera();
    sendImage(canvas.toDataURL('image/jpeg', 0.75));
  };

  /* ── CALLS ── */
  const initiateCall = async type => {
    try {
      callerRef.current = true;
      callTypeRef.current = type;
      setCallType(type);
      setCallStatus('ringing');
      await agoraJoin(type); // ★ join Agora channel + publish tracks
      setShowCall(true);
      socketRef.current?.emit('initiate-call', { caller: currentUser.email, type });
    } catch (e) {
      callerRef.current = false;
      setShowCall(false);
      await agoraLeave();
    }
  };

  const acceptCall = async () => {
    nativeStopRingtone();
    try {
      setShowIncoming(false);
      const type = incomingData.type;
      callTypeRef.current = type;
      setCallType(type);
      setCallStatus('connected');
      activeRef.current = true;
      await agoraJoin(type); // ★ join Agora channel + publish tracks
      setShowCall(true);
      socketRef.current?.emit('accept-call');
    } catch (e) {
      activeRef.current = false;
      setShowCall(false);
      await agoraLeave();
    }
  };

  const rejectCall = () => {
    nativeStopRingtone(); // stop ring when rejecting
    setShowIncoming(false);
    socketRef.current?.emit('reject-call');
  };
  const toggleMute = () => {
    const n = !audioMuted;
    setAudioMuted(n);
    audioMutedRef.current = n;
    localAudioTrack.current?.setEnabled(!n); // ★ Agora mute
  };
  const toggleVideo = () => {
    if (callTypeRef.current === 'audio') return;
    const n = !videoOff;
    setVideoOff(n);
    localVideoTrack.current?.setEnabled(!n); // ★ Agora video toggle
  };

  // ★ Camera flip: front ⇔ rear during active video call (Agora hot-swap)
  const toggleCallCamera = useCallback(async () => {
    if (callTypeRef.current !== 'video') return;
    const newFacing = callCamFacing === 'user' ? 'environment' : 'user';
    try {
      const newVideoTrack = await AgoraRTC.createCameraVideoTrack({
        encoderConfig: { width: 1280, height: 720, frameRate: 30, bitrateMax: 2000 },
        facingMode: newFacing,
      });
      if (agoraClient.current && localVideoTrack.current) {
        await agoraClient.current.unpublish([localVideoTrack.current]);
        localVideoTrack.current.close();
        localVideoTrack.current = newVideoTrack;
        await agoraClient.current.publish([newVideoTrack]);
      } else {
        localVideoTrack.current = newVideoTrack;
      }
      if (localVid.current) newVideoTrack.play(localVid.current);
      setCallCamFacing(newFacing);
    } catch (e) {
      alert('Camera switch failed: ' + e.message);
    }
  }, [callCamFacing]);

  const endCallClick = () => {
    if (!activeRef.current && callerRef.current) {
      // Call hasn't connected yet — cancel it
      socketRef.current?.emit('cancel-call');
      logCallEvent('not_answered', callTypeRef.current);
    } else if (activeRef.current) {
      socketRef.current?.emit('end-call');
      logCallEvent('ended', callTypeRef.current);
    }
    endCall();
  };
  const handleLogout = () => { socketRef.current?.disconnect(); writeMyPresence(false); localStorage.removeItem('userRole'); signOut(auth); };

  /* ── TICK ICON ── */
  const TickIcon = ({ msg }) => {
    if (!msg.timestamp) return <i className="fas fa-check msg-tick tick-sending" title="Sending..." />;
    const seen = msg.seenBy?.includes(partnerRole);
    return <i className={`fas fa-check-double msg-tick ${seen ? 'tick-seen' : 'tick-sent'}`} title={seen ? 'Seen' : 'Delivered'} />;
  };

  /* ── RENDER MESSAGE ── */
  const renderMessage = msg => {
    // Guard: currentUser might be null briefly on mount
    if (!currentUser) return null;
    const isMe = msg.sender === currentUser.email;

    if (msg.isSystemEvent) {
      const cType = msg.callType === 'video' ? 'Video' : 'Audio';
      let label, icon, color;

      if (msg.event === 'missed') {
        if (isMe) { label = `Not Answered ${cType} Call`; icon = 'fa-phone-slash'; color = '#ff9800'; }
        else       { label = `Missed ${cType} Call`;       icon = 'fa-phone-missed'; color = '#ff4b4b'; }
      } else if (msg.event === 'not_answered') {
        if (isMe) { label = `Not Answered ${cType} Call`; icon = 'fa-phone-slash'; color = '#ff9800'; }
        else       { label = `Missed ${cType} Call`;       icon = 'fa-phone-missed'; color = '#ff4b4b'; }
      } else if (msg.event === 'ended') {
        label = `${cType} Call Ended`; icon = 'fa-phone'; color = '#78909c';
      } else {
        label = `${cType} Call Started`;
        icon  = msg.callType === 'video' ? 'fa-video' : 'fa-phone-alt';
        color = '#4cd137';
      }
      return (
        <div key={msg.id} className="system-event-msg">
          <i className={`fas ${icon}`} style={{ color }} />
          <span>{label}</span>
          <span style={{ fontSize:10, opacity:0.6, marginLeft:4 }}>{formatTime(msg.timestamp)}</span>
        </div>
      );
    }

    // ★ Deleted for everyone
    if (msg.deletedForEveryone) {
      return (
        <div key={msg.id} className={`message ${isMe ? 'sent' : 'received'}`}>
          <div className="msg-body" style={{ opacity:0.55, fontStyle:'italic', fontSize:13 }}>
            <i className="fas fa-ban" style={{ marginRight:5, color:'#8696a0' }} />
            This message was deleted
          </div>
        </div>
      );
    }

    // Long press → context menu (mobile)
    let pressTimer = null;
    const onTouchStart = (e) => {
      const touch = e.touches[0];
      pressTimer = setTimeout(() => setCtxMenu({ msg, x: touch.clientX, y: touch.clientY }), 500);
    };
    const onTouchEnd = () => clearTimeout(pressTimer);

    return (
      <div key={msg.id}
        className={`message ${isMe ? 'sent' : 'received'}`}
        onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ msg, x: e.clientX, y: e.clientY }); }}
        onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} onTouchMove={onTouchEnd}>

        {/* ★ Reply quote */}
        {msg.replyTo && (
          <div style={{
            background:'rgba(255,255,255,0.1)', borderLeft:'3px solid #25d366',
            padding:'4px 8px', borderRadius:6, marginBottom:4, fontSize:12, maxWidth:'100%'
          }}>
            <span style={{ color:'#25d366', fontWeight:600, display:'block' }}>
              {msg.replyTo.sender === currentUser.email ? 'You' : 'Partner'}
            </span>
            <span style={{ opacity:0.8 }}>
              {(() => { try { return decryptData(msg.replyTo.text)?.substring(0,80); } catch { return '...'; } })()}
            </span>
          </div>
        )}

        <div className="msg-body">
          <span className="msg-footer">
            {msg.starred?.includes(role) && <i className="fas fa-star" style={{ color:'#f4d03f', marginRight:4, fontSize:10 }} />}
            <span className="msg-time">{formatTime(msg.timestamp)}</span>
            {isMe && <TickIcon msg={msg} />}
          </span>
          {msg.imageUrl
            ? <img src={msg.imageUrl} alt="" style={{ maxWidth:'100%', borderRadius:'6px', cursor:'pointer', display:'block' }}
                onClick={() => window.open(msg.imageUrl, '_blank')}
              />
            : <span className="msg-text">{msg.text}</span>}
        </div>
      </div>
    );

  };

  /* ══════════ JSX ══════════ */
  return (
    <div id="app-container" className="container" style={{ display:'flex' }}>

      {/* ── SIDEBAR REMOVED FOR SINGLE SECTION UI ── */}

      {/* ── MAIN CHAT ── */}
      <div className="main-chat">
        <div className="chat-header">
          <div className="contact-info">
            <div style={{ position:'relative', flexShrink:0 }}>
              <div className="contact-avatar-small" style={{ overflow:'hidden' }}>
                <i className="fas fa-user-circle" style={{fontSize: '36px', color: '#e9edef'}}></i>
              </div>
              {pOnline && <span className="online-dot-header" />}
            </div>
            <div>
              <h2 style={{ margin:0, lineHeight:1.2 }}>My Forever ❤️</h2>
              <div className={`chat-partner-status-text${pOnline ? ' is-online' : ''}`}>
                {pOnline
                  ? pTyping
                    ? <><span className="status-dot" style={{background:'#8696a0'}} />Typing...</>
                    : <><span className="status-dot" />Online</>
                  : pStatus}
              </div>
            </div>
          </div>
          <div className="call-actions" style={{ display:'flex', alignItems:'center', gap:4 }}>
            {/* ★ Search */}
            <button id="search-btn" title="Search Messages" onClick={() => { setSearchMode(s => !s); setSearchQuery(''); }}
              style={{ color: searchMode ? '#00a884' : '#8696a0' }}>
              <i className="fas fa-search" />
            </button>
            {/* ★ Disappearing timer */}
            <button id="disappear-btn" title="Disappearing Messages"
              onClick={() => setShowDisappearMenu(v => !v)}
              style={{ color: disappearTimer > 0 ? '#f4d03f' : '#8696a0', position:'relative' }}>
              <i className="fas fa-clock" />
              {disappearTimer > 0 && (
                <span style={{ position:'absolute', top:-4, right:-4, background:'#f4d03f', color:'#000', borderRadius:'50%', width:10, height:10, fontSize:7, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700 }}>•</span>
              )}
            </button>
            <button id="clear-chat-btn" title="Clear Chat" onClick={clearChat} style={{ color:'#8696a0' }}><i className="fas fa-trash" /></button>
            <button id="audio-call-btn" title="Audio Call" onClick={() => initiateCall('audio')} style={{ color:'#00a884' }}><i className="fas fa-phone-alt" /></button>
            <button id="video-call-btn" title="Video Call" onClick={() => initiateCall('video')} style={{ color:'#00a884' }}><i className="fas fa-video" /></button>
            <button id="logout-btn" title="Logout" onClick={handleLogout} style={{ color:'#e9edef', marginLeft:10 }}><i className="fas fa-sign-out-alt" /></button>
          </div>
        </div>

        {/* ★ Search Bar */}
        {searchMode && (
          <div style={{ padding:'8px 12px', background:'#1f2c34', borderBottom:'1px solid rgba(255,255,255,0.08)', display:'flex', alignItems:'center', gap:8 }}>
            <i className="fas fa-search" style={{ color:'#8696a0', fontSize:14 }} />
            <input
              autoFocus
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search messages..."
              style={{ flex:1, background:'transparent', border:'none', outline:'none', color:'#e9edef', fontSize:15 }}
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} style={{ background:'none', border:'none', color:'#8696a0', cursor:'pointer', padding:0 }}>
                <i className="fas fa-times" />
              </button>
            )}
            <span style={{ color:'#8696a0', fontSize:12 }}>
              {searchMode && searchQuery ? `${visibleMessages.length} result${visibleMessages.length !== 1 ? 's' : ''}` : ''}
            </span>
          </div>
        )}

        {/* ★ Disappearing Timer Menu */}
        {showDisappearMenu && (
          <div style={{ position:'absolute', top:60, right:12, zIndex:1000, background:'#233138', borderRadius:10, boxShadow:'0 8px 32px rgba(0,0,0,0.4)', overflow:'hidden', minWidth:180 }}
            onClick={() => setShowDisappearMenu(false)}>
            {[
              { label: 'Off', val: 0 },
              { label: '30 seconds', val: 30 },
              { label: '5 minutes', val: 300 },
              { label: '1 hour', val: 3600 },
              { label: '1 day', val: 86400 },
              { label: '1 week', val: 604800 },
            ].map(({ label, val }) => (
              <div key={val}
                onClick={() => setDisappearTimer(val)}
                style={{ padding:'12px 16px', cursor:'pointer', display:'flex', alignItems:'center', gap:10,
                  background: disappearTimer === val ? 'rgba(0,168,132,0.2)' : 'transparent',
                  color: disappearTimer === val ? '#00a884' : '#e9edef', fontSize:14 }}>
                <i className="fas fa-clock" style={{ width:16, color: disappearTimer === val ? '#00a884' : '#8696a0' }} />
                {label}
                {disappearTimer === val && <i className="fas fa-check" style={{ marginLeft:'auto', color:'#00a884' }} />}
              </div>
            ))}
          </div>
        )}

        <div className="chat-messages" id="chat-messages" onClick={() => { setCtxMenu(null); setShowReactions(null); }}>
          {visibleMessages.map(renderMessage)}
          <div ref={msgEnd} />
        </div>

        <div className="chat-input-area" style={{ flexDirection:'column', padding:0 }}>
          {/* ★ Reply preview strip */}
          {replyTo && (
            <div style={{ display:'flex', alignItems:'center', padding:'6px 12px', background:'rgba(0,168,132,0.12)', borderTop:'2px solid #00a884', gap:8 }}>
              <div style={{ flex:1 }}>
                <span style={{ color:'#00a884', fontSize:12, fontWeight:600, display:'block' }}>Replying to {replyTo.sender === currentUser?.email ? 'yourself' : 'Partner'}</span>
                <span style={{ color:'#8696a0', fontSize:12 }}>
                  {(() => { try { return decryptData(replyTo.text)?.substring(0, 60); } catch { return '...'; } })()}
                </span>
              </div>
              <button onClick={() => setReplyTo(null)} style={{ background:'none', border:'none', color:'#8696a0', cursor:'pointer', padding:4 }}><i className="fas fa-times" /></button>
            </div>
          )}

          {/* ★ Edit mode indicator */}
          {editingMsg && (
            <div style={{ display:'flex', alignItems:'center', padding:'6px 12px', background:'rgba(244,211,63,0.12)', borderTop:'2px solid #f4d33f', gap:8 }}>
              <i className="fas fa-pencil-alt" style={{ color:'#f4d33f', fontSize:12 }} />
              <span style={{ flex:1, color:'#f4d33f', fontSize:12, fontWeight:600 }}>Editing message</span>
              <button onClick={() => { setEditingMsg(null); setText(''); }} style={{ background:'none', border:'none', color:'#8696a0', cursor:'pointer', padding:4 }}><i className="fas fa-times" /></button>
            </div>
          )}

          {/* Input row */}
          <div style={{ display:'flex', alignItems:'center', padding:'8px 12px', gap:8, width:'100%' }}>
            {/* Gallery Input */}
            <input type="file" ref={galleryInput} accept="image/*" style={{ display:'none' }}
              onChange={e => { if (e.target.files[0]) compressAndSend(e.target.files[0]); e.target.value = ''; }} />
            <button id="camera-btn"  title="Camera"  onClick={openCamera}><i className="fas fa-camera" /></button>
            <button id="gallery-btn" title="Gallery" onClick={() => galleryInput.current?.click()}><i className="fas fa-image" /></button>
            <input type="text" id="message-input"
              placeholder={editingMsg ? 'Edit message...' : 'Type a message'}
              value={text}
              onChange={e => handleTypingInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendMessage()} />
            <button id="send-btn" onClick={sendMessage}><i className="fas fa-paper-plane" /></button>
          </div>
        </div>
      </div>

      {/* ── CALL MODAL ── */}
        {/* ★ MINIMIZED CALL BANNER — shown when user presses back during active call */}
        {callMinimized && activeRef.current && (
          <div
            onClick={() => { setShowCall(true); setCallMinimized(false); }}
            style={{
              position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
              background: 'linear-gradient(90deg, #075e54, #128c7e)',
              color: '#fff', padding: '10px 16px',
              display: 'flex', alignItems: 'center', gap: 10,
              cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            }}
          >
            <i className="fas fa-phone" style={{ animation: 'pulse 1.2s infinite' }} />
            <span style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>
              {callType === 'video' ? 'Video' : 'Audio'} call in progress — tap to return
            </span>
            <span style={{ fontSize: 13, opacity: 0.85 }}>{formatDuration(callDuration)}</span>
            <button
              onClick={e => { e.stopPropagation(); endCallClick(); }}
              style={{ background: '#e53935', border: 'none', borderRadius: '50%', width: 32, height: 32, color: '#fff', cursor: 'pointer' }}
            >
              <i className="fas fa-phone-slash" />
            </button>
          </div>
        )}

        {showCall && (
          <div id="call-modal" className="modal" style={{ display:'flex' }}>
            <div className="video-container">

              {/* ★ HEADER: minimize button (chevron down) + call type + status/timer */}
              <div style={{ position:'absolute', top:0, left:0, right:0, zIndex:15, display:'flex', alignItems:'center', padding:'12px 14px', gap:10, background:'linear-gradient(to bottom,rgba(0,0,0,0.6),transparent)' }}>
                <button
                  onClick={() => { setShowCall(false); setCallMinimized(true); }}
                  style={{ background:'transparent', border:'none', color:'#fff', fontSize:22, cursor:'pointer', padding:'4px 8px', lineHeight:1 }}
                  title="Minimize — call stays active"
                >
                  <i className="fas fa-chevron-down" />
                </button>
                <span style={{ color:'#fff', fontWeight:700, fontSize:15, flex:1 }}>
                  {callType === 'video' ? '📹 Video Call' : '📞 Audio Call'}
                </span>
                <span style={{ color:'rgba(255,255,255,0.75)', fontSize:13 }}>
                  {callStatus === 'ringing' ? 'Ringing...' : callStatus === 'connected' ? formatDuration(callDuration) : callStatus}
                </span>
              </div>

              {/* ★ HOLD OVERLAY — remote user answered a native phone call */}
              {remoteHeld && (
                <div style={{
                  position:'absolute', inset:0, zIndex:20,
                  background:'rgba(0,0,0,0.78)',
                  display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:14,
                }}>
                  <i className="fas fa-pause-circle fa-3x" style={{ color:'#FFB300' }} />
                  <p style={{ color:'#fff', fontWeight:700, fontSize:20, margin:0 }}>Call on Hold</p>
                  <p style={{ color:'rgba(255,255,255,0.7)', fontSize:14, margin:0, textAlign:'center', padding:'0 24px' }}>
                    Other person answered a phone call
                  </p>
                </div>
              )}

              {/* ★ MY HOLD BANNER — shown when I answered a native call */}
              {nativeCallActive && (
                <div style={{
                  position:'absolute', top:70, left:'50%', transform:'translateX(-50%)',
                  background:'rgba(255,152,0,0.92)', color:'#fff',
                  padding:'6px 18px', borderRadius:20, fontSize:13, fontWeight:700,
                  display:'flex', alignItems:'center', gap:8, zIndex:21, whiteSpace:'nowrap',
                }}>
                  <i className="fas fa-pause-circle" /> Answering phone call — app call muted
                </div>
              )}

              {/* ─── RINGING / NOT-ANSWERED / DECLINED overlay ─── */}
              {(callStatus === 'ringing' || callStatus === 'not_answered' || callStatus === 'declined') && (
                <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.82)', gap:14, zIndex:10 }}>
                  <div style={{ width:90, height:90, borderRadius:'50%', overflow:'hidden', border:'3px solid rgba(255,255,255,0.35)', boxShadow:'0 0 20px rgba(255,255,255,0.1)' }}>
                    <i className="fas fa-user-circle" style={{fontSize: '80px', color: '#e9edef'}}></i>
                  </div>
                  <p style={{ color:'white', fontSize:17, fontWeight:600, margin:0 }}>My Forever ❤️</p>

                  {callStatus === 'ringing' && (
                    <p style={{ color:'rgba(255,255,255,0.65)', margin:0, fontSize:13 }}>
                      <i className="fas fa-circle" style={{ color:'#4cd137', fontSize:7, marginRight:6, animation:'pulse-dot 1s infinite' }} />
                      {callType === 'video' ? 'Video' : 'Audio'} Ringing...
                    </p>
                  )}
                  {callStatus === 'not_answered' && (
                    <p style={{ color:'#ff9800', margin:0, fontSize:13 }}>
                      <i className="fas fa-phone-slash" style={{ marginRight:6 }} /> Not Answered
                    </p>
                  )}
                  {callStatus === 'declined' && (
                    <p style={{ color:'#ff4b4b', margin:0, fontSize:13 }}>
                      <i className="fas fa-phone-slash" style={{ marginRight:6 }} /> Call Declined
                    </p>
                  )}

                  {callStatus === 'ringing' && (
                    <button
                      id="end-call-ringing"
                      onClick={endCallClick}
                      style={{ marginTop:8, background:'#e8004d', border:'none', borderRadius:'50%', width:60, height:60, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 4px 15px rgba(232,0,77,0.5)', fontSize:22, color:'white', zIndex:20 }}
                    >
                      <i className="fas fa-phone-slash" />
                    </button>
                  )}
                </div>
              )}

              {/* ─── CONNECTED: audio-only UI ─── */}
              {callType === 'audio' && callStatus === 'connected' && (
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%' }}>
                  <i className="fas fa-microphone fa-4x" style={{ color:'white' }} />
                  <p style={{ color:'white', marginTop:10 }}>Audio Call in Progress</p>
                </div>
              )}
              <video id="remote-video" ref={remoteVid} autoPlay playsInline style={{ display: callType==='audio'?'none':'block' }} />
              <video id="local-video"  ref={localVid}  autoPlay playsInline muted  style={{ display: callType==='audio'?'none':'block', transform: callCamFacing === 'user' ? 'scaleX(-1)' : 'scaleX(1)' }} />

              {/* ★ PiP MODE: show only video feeds, hide all controls/text */}
              {inPiP && (
                <div style={{ position:'absolute', inset:0, zIndex:30, display:'flex', alignItems:'center', justifyContent:'center', background:'#000' }}>
                  <video ref={remoteVid} autoPlay playsInline style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                </div>
              )}

              {/* ★ CONNECTED CONTROLS — hidden during PiP */}
              {callStatus === 'connected' && !inPiP && (
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:10, position:'absolute', bottom:20, left:'50%', transform:'translateX(-50%)', zIndex:10, width:'100%' }}>
                  <div style={{ background:'rgba(0,0,0,0.4)', padding:'4px 12px', borderRadius:16, fontSize:13, color:'#fff', marginBottom:-5, fontWeight:500, border:'1px solid rgba(255,255,255,0.1)' }}>
                    {formatDuration(callDuration)}
                  </div>
                  <div className="call-controls" style={{ position:'static', transform:'none' }}>

                    {/* Mute mic */}
                    <button onClick={toggleMute} title={audioMuted||nativeCallActive?'Unmute':'Mute'}
                      style={{ background: (audioMuted||nativeCallActive) ? 'rgba(234,0,56,0.8)' : 'rgba(255,255,255,0.2)' }}>
                      <i className={`fas fa-microphone${(audioMuted||nativeCallActive)?'-slash':''}`} />
                    </button>

                    {/* ★ Speaker toggle — earpiece (default) ↔ loudspeaker */}
                    <button
                      onClick={() => {
                        const next = !speakerOn;
                        setSpeakerOn(next);
                        if (next) nativeStartSpeaker(); else nativeStartEarpiece();
                      }}
                      title={speakerOn ? 'Switch to Earpiece' : 'Switch to Loudspeaker'}
                      style={{ background: speakerOn ? 'rgba(0,200,100,0.75)' : 'rgba(255,255,255,0.2)' }}
                    >
                      <i className={`fas fa-volume-${speakerOn ? 'up' : 'off'}`} />
                    </button>

                    {/* Video mute */}
                    {callType==='video' && (
                      <button onClick={toggleVideo} title={videoOff?'Cam On':'Cam Off'}
                        style={{ background: videoOff ? 'rgba(234,0,56,0.8)' : 'rgba(255,255,255,0.2)' }}>
                        <i className={`fas fa-video${videoOff?'-slash':''}`} />
                      </button>
                    )}

                    {/* Camera flip */}
                    {callType === 'video' && (
                      <button onClick={toggleCallCamera} title={callCamFacing==='user'?'Rear Camera':'Front Camera'}
                        style={{ background:'rgba(255,255,255,0.2)' }}>
                        <i className="fas fa-sync-alt" />
                      </button>
                    )}

                    {/* End call */}
                    <button id="end-call" className="danger" onClick={endCallClick}>
                      <i className="fas fa-phone-slash" />
                    </button>
                  </div>
                </div>
              )}

            </div>
          </div>
        )}


      {/* ── INCOMING CALL ── */}
      {showIncoming && (
        <div id="incoming-call-alert" className="alert-box" style={{ display:'block' }}>
          <p><i className="fas fa-phone-volume" /> Incoming {incomingData?.type === 'video' ? 'Video' : 'Audio'} Call...</p>
          <div className="alert-actions">
            <button id="accept-call" className="success" onClick={acceptCall}><i className="fas fa-phone" /> Accept</button>
            <button id="reject-call" className="danger"  onClick={rejectCall}><i className="fas fa-phone-slash" /> Reject</button>
          </div>
        </div>
      )}

      {/* ── CAMERA MODAL ── */}
      {showCamera && (
        <div style={{ display:'flex', position:'fixed', top:0, left:0, width:'100%', height:'100%', background:'#000', zIndex:3000, flexDirection:'column' }}>
          <video ref={camPreview} autoPlay playsInline style={{ flex:1, width:'100%', height:'calc(100% - 120px)', objectFit:'cover', transform: facingMode === 'user' ? 'scaleX(-1)' : 'scaleX(1)' }} />
          <div style={{ position:'absolute', bottom:0, left:0, width:'100%', height:120, display:'flex', justifyContent:'space-around', alignItems:'center', background:'linear-gradient(transparent,rgba(0,0,0,0.9))', paddingBottom:'max(10px,env(safe-area-inset-bottom))' }}>
            <button onClick={closeCamera}  style={{ background:'rgba(255,255,255,0.2)', width:50, height:50, borderRadius:'50%', color:'white', border:'none', fontSize:20, display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'none' }}><i className="fas fa-times" /></button>
            <button onClick={takePhoto}    style={{ background:'white', width:70, height:70, borderRadius:'50%', border:'6px solid rgba(255,255,255,0.5)', cursor:'pointer', boxShadow:'none' }} />
            <button onClick={switchCamera} style={{ background:'rgba(255,255,255,0.2)', width:50, height:50, borderRadius:'50%', color:'white', border:'none', fontSize:20, display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'none' }}><i className="fas fa-sync-alt" /></button>
          </div>
          <canvas ref={camCanvas} style={{ display:'none' }} />
        </div>
      )}

      {/* ★ CONTEXT MENU — long press / right click on message */}
      {ctxMenu && (
        <div
          onClick={() => setCtxMenu(null)}
          style={{ position:'fixed', inset:0, zIndex:5000, background:'rgba(0,0,0,0.4)' }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position:'fixed',
              left: Math.min(ctxMenu.x, window.innerWidth - 200),
              top:  Math.min(ctxMenu.y, window.innerHeight - 340),
              background:'#233138', borderRadius:12,
              boxShadow:'0 8px 32px rgba(0,0,0,0.5)',
              overflow:'hidden', minWidth:190, zIndex:5001
            }}>

            {/* Emoji reaction quick-pick */}
            <div style={{ display:'flex', justifyContent:'space-around', padding:'10px 8px', borderBottom:'1px solid rgba(255,255,255,0.08)' }}>
              {['❤️','😂','😮','😢','🙏','👍'].map(emoji => (
                <span key={emoji}
                  onClick={() => { reactToMessage(ctxMenu.msg, emoji); setCtxMenu(null); }}
                  style={{ fontSize:22, cursor:'pointer', padding:4, borderRadius:8,
                    background: ctxMenu.msg.reactions?.[emoji]?.includes(role) ? 'rgba(37,211,102,0.2)' : 'transparent',
                    transition:'background 0.15s' }}>
                  {emoji}
                </span>
              ))}
            </div>

            {/* Actions */}
            {[
              { icon:'fa-reply',          label:'Reply',               action: () => { setReplyTo(ctxMenu.msg); setCtxMenu(null); } },
              ...(ctxMenu.msg.sender === currentUser?.email ? [
                { icon:'fa-pencil-alt',   label:'Edit',                action: () => { setEditingMsg(ctxMenu.msg); setText((() => { try { return decryptData(ctxMenu.msg.text); } catch { return ''; } })()); setCtxMenu(null); } },
              ] : []),
              { icon:'fa-star',           label: ctxMenu.msg.starred?.includes(role) ? 'Unstar' : 'Star', action: () => { toggleStar(ctxMenu.msg); setCtxMenu(null); } },
              { icon:'fa-copy',           label:'Copy',                action: () => { try { navigator.clipboard.writeText(decryptData(ctxMenu.msg.text)); } catch {} setCtxMenu(null); } },
              { icon:'fa-trash-alt',      label:'Delete for me',       action: () => { deleteMsg(ctxMenu.msg); setCtxMenu(null); }, color:'#ff6b6b' },
              ...(ctxMenu.msg.sender === currentUser?.email ? [
                { icon:'fa-ban',          label:'Delete for everyone', action: () => { deleteForEveryone(ctxMenu.msg); setCtxMenu(null); }, color:'#ff4b4b' },
              ] : []),
            ].map(({ icon, label, action, color }) => (
              <div key={label} onClick={action} style={{
                padding:'13px 16px', cursor:'pointer', display:'flex', alignItems:'center', gap:12,
                color: color || '#e9edef', fontSize:14,
                borderBottom:'1px solid rgba(255,255,255,0.05)'
              }}
                onMouseEnter={e => e.currentTarget.style.background='rgba(255,255,255,0.06)'}
                onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                <i className={`fas ${icon}`} style={{ width:16, color: color || '#8696a0' }} />
                {label}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

