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
  const [callType,     setCallType]     = useState(null);
  const [audioMuted,      setAudioMuted]      = useState(false);
  const [videoOff,        setVideoOff]        = useState(false);
  const [speakerOn,       setSpeakerOn]       = useState(true);  // ★ loudspeaker ON by default
  const [showCamera,      setShowCamera]      = useState(false);
  const [facingMode,      setFacingMode]      = useState('environment');
  const [callStatus,      setCallStatus]      = useState('ringing');
  const [callCamFacing,   setCallCamFacing]   = useState('user');
  const [callDuration,    setCallDuration]    = useState(0);
  const [pTyping,         setPTyping]         = useState(false);   // partner is typing
  const [nativeCallActive, setNativeCallActive] = useState(false); // native phone call in progress

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

  // ★ Route audio to SPEAKERPHONE (front/loudspeaker) — default for calls
  const nativeStartSpeaker = useCallback(async () => {
    try { await nativePlugin()?.startSpeaker(); } catch (e) { console.warn('startSpeaker:', e); }
  }, []);

  // Route audio to earpiece (small top speaker) — used when user toggles speaker off
  const nativeStartEarpiece = useCallback(async () => {
    try { await nativePlugin()?.startEarpiece(); } catch (e) { console.warn('startEarpiece:', e); }
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
    activeRef.current = false;
    setShowCall(false);
    setShowIncoming(false);
    setCallStatus('ringing');
    setCallCamFacing('user');
    setNativeCallActive(false);
    audioMutedRef.current = false;
    setSpeakerOn(true);
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
            // Re-confirm speaker routing when remote audio arrives
            nativeStartSpeaker();
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

      // UID: user1=1, user2=2 (unique integers per channel)
      const uid = role === 'user1' ? 1 : 2;
      await agoraClient.current.join(AGORA_APP_ID, AGORA_CHANNEL, null, uid);

      const tracks = [localAudioTrack.current, localVideoTrack.current].filter(Boolean);
      await agoraClient.current.publish(tracks);

      // ★ Default audio to loudspeaker
      await nativeStartSpeaker();

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
  }, [role, nativeStartSpeaker]);

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
    let nativeCallSub = null;
    const plugin = nativePlugin();
    if (plugin?.addListener) {
      // Capacitor native addListener() can return EITHER:
      //   a) Promise<PluginListenerHandle>  (web/PWA)
      //   b) PluginListenerHandle directly  (Android native bridge)
      // Promise.resolve() safely wraps both cases.
      Promise.resolve(
        plugin.addListener('nativeCallState', (data) => {
          if (data.state === 'active') {
            setNativeCallActive(true);
            localAudioTrack.current?.setEnabled(false); // ★ Agora mute on native call
          } else if (data.state === 'idle') {
            setNativeCallActive(false);
            if (!audioMutedRef.current) {
              localAudioTrack.current?.setEnabled(true); // ★ Agora restore
            }
          }
        })
      ).then(handle => { nativeCallSub = handle; }).catch(() => {});
    }

    // Presence
    const handleVis = () => writeMyPresence(!document.hidden);
    document.addEventListener('visibilitychange', handleVis);
    window.addEventListener('beforeunload', () => writeMyPresence(false));

    // Android hardware back button — navigate to select instead of closing the app
    const handleBackBtn = () => { navigate('/select', { replace: true }); };
    document.addEventListener('backbutton', handleBackBtn, false);

    return () => {
      socket.disconnect();
      unsubMsg();
      unsubTyping();
      nativeCallSub?.remove?.();
      endCall();
      writeTyping(false);
      clearTimeout(typingTimerRef.current);
      writeMyPresence(false);
      document.removeEventListener('visibilitychange', handleVis);
      document.removeEventListener('backbutton', handleBackBtn, false);
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

  /* ── MESSAGING ── */
  const sendMessage = async () => {
    const t = text.trim(); if (!t) return;
    // Clear typing indicator immediately on send
    clearTimeout(typingTimerRef.current);
    writeTyping(false);
    try {
      await addDoc(collection(db, 'messages'), {
        text: encryptData(t), sender: currentUser.email,
        participants: getParticipants(),
        deletedFor: [], seenBy: [], timestamp: serverTimestamp()
      });
      setText('');
    } catch (e) { console.error(e); }
  };

  const deleteMsg = async msg => {
    if (!window.confirm('Delete this message for YOU?')) return;
    try {
      // Auto-Garbage Collection: If the other user already deleted it, and now we delete it, WIPE it permanently from Firebase!
      if (msg.deletedFor && msg.deletedFor.length === 1 && !msg.deletedFor.includes(currentUser.email)) {
        await deleteDoc(doc(db, 'messages', msg.id));
      } else {
        await updateDoc(doc(db, 'messages', msg.id), { deletedFor: arrayUnion(currentUser.email) });
      }
    } catch (e) {
      console.error("Delete failed: ", e);
      alert('Could not delete old message due to strict Security rules.');
    }
  };

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
        // caller sees "Not Answered", receiver sees "Missed Call"
        if (isMe) {
          label = `Not Answered ${cType} Call`;
          icon  = 'fa-phone-slash';
          color = '#ff9800'; // orange
        } else {
          label = `Missed ${cType} Call`;
          icon  = 'fa-phone-missed';
          color = '#ff4b4b'; // red
        }
      } else if (msg.event === 'not_answered') {
        // auto-timeout (30s): same logic
        if (isMe) {
          label = `Not Answered ${cType} Call`;
          icon  = 'fa-phone-slash';
          color = '#ff9800';
        } else {
          label = `Missed ${cType} Call`;
          icon  = 'fa-phone-missed';
          color = '#ff4b4b';
        }
      } else if (msg.event === 'ended') {
        label = `${cType} Call Ended`;
        icon  = 'fa-phone';
        color = '#78909c';
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

    return (
      <div key={msg.id}
        className={`message ${isMe ? 'sent' : 'received'}`}
        onMouseEnter={e => isMe && (e.currentTarget.querySelector('.del-btn').style.display = 'block')}
        onMouseLeave={e => isMe && (e.currentTarget.querySelector('.del-btn').style.display = 'none')}
        onClick={e => { if (isMe && e.target.className !== 'del-btn') { const b = e.currentTarget.querySelector('.del-btn'); if(b) b.style.display = b.style.display === 'none' ? 'block' : 'none'; } }}>
        {isMe && (
          <i className="fas fa-trash-alt del-btn"
            onClick={() => deleteMsg(msg)}
            style={{ position:'absolute', top:'-8px', right:'-8px', background:'rgba(255,65,108,0.9)', color:'white', padding:'6px', borderRadius:'50%', fontSize:'10px', cursor:'pointer', display:'none', zIndex:10 }} />
        )}
        <div className="msg-body">
          <span className="msg-footer">
            <span className="msg-time">{formatTime(msg.timestamp)}</span>
            {isMe && <TickIcon msg={msg} />}
          </span>
          {msg.imageUrl
            ? <img 
                src={msg.imageUrl} 
                alt="" 
                style={{ maxWidth:'100%', borderRadius:'6px', cursor:'pointer', display:'block' }} 
                onClick={() => window.open(msg.imageUrl, '_blank')}
                onError={e => { e.target.style.display = 'none'; }}
                onContextMenu={async (e) => { 
                     e.preventDefault(); 
                     e.stopPropagation();
                     if (!window.confirm('Save this image to your gallery?')) return;
                     const fname = `GCapBank_${Date.now()}.jpg`;
                     // Try native Android gallery save first
                     const saved = await nativeSaveImage(msg.imageUrl, fname);
                     if (saved) {
                       alert('✅ Photo saved to Gallery!');
                     } else {
                       // Browser fallback (desktop/web)
                       const a = document.createElement('a');
                       a.href = msg.imageUrl;
                       a.download = fname;
                       a.click();
                     }
                }} 
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
          <div className="call-actions" style={{ display:'flex', alignItems:'center' }}>
            <button id="clear-chat-btn" title="Clear Chat" onClick={clearChat} style={{ color:'#8696a0' }}><i className="fas fa-trash" /></button>
            <button id="audio-call-btn" title="Audio Call" onClick={() => initiateCall('audio')} style={{ color:'#00a884' }}><i className="fas fa-phone-alt" /></button>
            <button id="video-call-btn" title="Video Call" onClick={() => initiateCall('video')} style={{ color:'#00a884' }}><i className="fas fa-video" /></button>
            <button id="logout-btn" title="Logout" onClick={handleLogout} style={{ color:'#e9edef', marginLeft:10 }}><i className="fas fa-sign-out-alt" /></button>
          </div>
        </div>

        <div className="chat-messages" id="chat-messages">
          {messages.map(renderMessage)}
          <div ref={msgEnd} />
        </div>

        <div className="chat-input-area">
          {/* Gallery Input */}
          <input type="file" ref={galleryInput} accept="image/*" style={{ display:'none' }}
            onChange={e => { if (e.target.files[0]) compressAndSend(e.target.files[0]); e.target.value = ''; }} />
          
          <button id="camera-btn"  title="Camera"  onClick={openCamera}><i className="fas fa-camera" /></button>
          <button id="gallery-btn" title="Gallery"  onClick={() => galleryInput.current?.click()}><i className="fas fa-image" /></button>
          <input type="text" id="message-input" placeholder="Type a message"
            value={text}
            onChange={e => handleTypingInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendMessage()} />
          <button id="send-btn" onClick={sendMessage}><i className="fas fa-paper-plane" /></button>
        </div>
      </div>

      {/* ── CALL MODAL ── */}
      {showCall && (
        <div id="call-modal" className="modal" style={{ display:'flex' }}>
          <div className="video-container">

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

                {/* ★ FIX: End button INSIDE overlay — always accessible during ringing */}
                {callStatus === 'ringing' && (
                  <button
                    id="end-call-ringing"
                    onClick={endCallClick}
                    style={{ marginTop:8, background:'#e8004d', border:'none', borderRadius:'50%', width:60, height:60, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 4px 15px rgba(232,0,77,0.5)', fontSize:22, color:'white', zIndex:20 }}>
                    <i className="fas fa-phone-slash" />
                  </button>
                )}
              </div>
            )}

            {/* ─── CONNECTED: video feeds ─── */}
            {callType === 'audio' && callStatus === 'connected' && (
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%' }}>
                <i className="fas fa-microphone fa-4x" style={{ color:'white' }} />
                <p style={{ color:'white', marginTop:10 }}>Audio Call in Progress</p>
              </div>
            )}
            <video id="remote-video" ref={remoteVid} autoPlay playsInline style={{ display: callType==='audio'?'none':'block' }} />
            <video id="local-video"  ref={localVid}  autoPlay playsInline muted  style={{ display: callType==='audio'?'none':'block', transform: callCamFacing === 'user' ? 'scaleX(-1)' : 'scaleX(1)' }} />

            {/* ─── CONNECTED: controls ─── */}
            {callStatus === 'connected' && (
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:10, position:'absolute', bottom:20, left:'50%', transform:'translateX(-50%)', zIndex:10, width:'100%' }}>

                {/* ★ Native call "On Hold" banner */}
                {nativeCallActive && (
                  <div style={{ background:'rgba(255,152,0,0.9)', color:'white', padding:'6px 16px', borderRadius:20, fontSize:12, fontWeight:700, display:'flex', alignItems:'center', gap:6 }}>
                    <i className="fas fa-pause-circle" />
                    Call on Hold — Answering native call
                  </div>
                )}

                <div style={{ background:'rgba(0,0,0,0.4)', padding:'4px 12px', borderRadius:16, fontSize:13, color:'#fff', marginBottom:-5, fontWeight:500, border:'1px solid rgba(255,255,255,0.1)' }}>
                  {formatDuration(callDuration)}
                </div>
                <div className="call-controls" style={{ position:'static', transform:'none' }}>
                  <button onClick={toggleMute}   title={audioMuted||nativeCallActive?'Unmute':'Mute'} style={{ background: (audioMuted||nativeCallActive) ? 'rgba(234,0,56,0.8)' : 'rgba(255,255,255,0.2)' }}>
                    <i className={`fas fa-microphone${(audioMuted||nativeCallActive)?'-slash':''}`} />
                  </button>
                  {/* ★ Speaker toggle — tap to switch between loudspeaker and earpiece */}
                  <button onClick={async () => {
                    const next = !speakerOn;
                    setSpeakerOn(next);
                    if (next) await nativeStartSpeaker(); else await nativeStartEarpiece();
                  }} title={speakerOn ? 'Switch to Earpiece' : 'Switch to Speaker'}
                    style={{ background: speakerOn ? 'rgba(0,200,100,0.7)' : 'rgba(255,255,255,0.2)' }}>
                    <i className={`fas fa-volume-${speakerOn ? 'up' : 'off'}`} />
                  </button>
                  {callType==='video' && <button onClick={toggleVideo} title={videoOff?'Cam On':'Cam Off'} style={{ background: videoOff ? 'rgba(234,0,56,0.8)' : 'rgba(255,255,255,0.2)' }}><i className={`fas fa-video${videoOff?'-slash':''}`} /></button>}
                  {callType === 'video' && (
                    <button onClick={toggleCallCamera} title={callCamFacing==='user'?'Rear Camera':'Front Camera'} style={{ background:'rgba(255,255,255,0.2)' }}>
                      <i className="fas fa-sync-alt" />
                    </button>
                  )}
                  <button id="end-call" className="danger" onClick={endCallClick}><i className="fas fa-phone-slash" /></button>
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
    </div>
  );
}
