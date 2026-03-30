import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import { signOut } from 'firebase/auth';
import {
  collection, addDoc, onSnapshot, query, orderBy,
  doc, updateDoc, arrayUnion, serverTimestamp,
  getDocs, writeBatch, setDoc, getDoc, Timestamp
} from 'firebase/firestore';
import { auth, db } from '../firebase.js';
import { useAuth } from '../context/AuthContext.jsx';
import { formatTime, formatLastSeen } from '../utils/helpers.js';

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

export default function ChatPage() {
  const { currentUser } = useAuth();
  const navigate        = useNavigate();
  const role            = localStorage.getItem('userRole');
  const partnerRole     = role === 'user1' ? 'user2' : 'user1';
  const myAvatar        = role === 'user1' ? '/avatar2.png' : '/avatar1.png';
  const partnerAvatar   = role === 'user1' ? '/avatar1.png' : '/avatar2.png';

  /* ── STATE ── */
  const [messages,     setMessages]     = useState([]);
  const [text,         setText]         = useState('');
  const [pOnline,      setPOnline]      = useState(false);
  const [pStatus,      setPStatus]      = useState('Offline');
  const [showCall,     setShowCall]     = useState(false);
  const [showIncoming, setShowIncoming] = useState(false);
  const [incomingData, setIncomingData] = useState(null);
  const [callType,     setCallType]     = useState(null);
  const [audioMuted,   setAudioMuted]   = useState(false);
  const [videoOff,       setVideoOff]       = useState(false);
  const [showCamera,     setShowCamera]     = useState(false);
  const [facingMode,     setFacingMode]     = useState('environment');
  const [callStatus,     setCallStatus]     = useState('ringing');
  const [callCamFacing,  setCallCamFacing]  = useState('user'); // 'user'=front, 'environment'=rear

  /* ── REFS ── */
  const socketRef    = useRef(null);
  const pcRef        = useRef(null);
  const localStream  = useRef(null);
  const camStream    = useRef(null);
  const callTypeRef  = useRef(null);
  const callerRef    = useRef(false);
  const activeRef    = useRef(false);
  const localVid     = useRef(null);
  const remoteVid    = useRef(null);
  const camPreview   = useRef(null);
  const camCanvas    = useRef(null);
  const galleryInput = useRef(null);
  const msgEnd       = useRef(null);
  const iceCandQueue = useRef([]);    // ← queued ICE candidates

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

  /* ── CALL HELPERS ── */
  const endCall = useCallback(() => {
    activeRef.current = false;
    setShowCall(false);
    setShowIncoming(false);
    setCallStatus('ringing');
    setCallCamFacing('user'); // reset to front cam for next call
    if (pcRef.current)   { pcRef.current.close(); pcRef.current = null; }
    if (localStream.current) { localStream.current.getTracks().forEach(t => t.stop()); localStream.current = null; }
    if (localVid.current)  localVid.current.srcObject  = null;
    if (remoteVid.current) remoteVid.current.srcObject = null;
    setAudioMuted(false); setVideoOff(false);
  }, []);

  const getMedia = async type => {
    try {
      localStream.current = await navigator.mediaDevices.getUserMedia({
        // HD audio with noise/echo suppression
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
          sampleRate:       48000,
        },
        // ★ No fixed 1280x720 — avoids zoom/crop on mobile portrait
        // ★ 720p landscape — reliable on all phones, no portrait issue
        video: type === 'video' ? {
          facingMode: 'user',
          width:     { ideal: 1280 },
          height:    { ideal: 720  },
          frameRate: { ideal: 30   },
        } : false
      });
    } catch (e) {
      alert('Could not access camera/mic: ' + e.message);
      throw e;
    }
  };

  const logCallEvent = async (event, cType) => {
    try {
      await addDoc(collection(db, 'messages'), {
        isSystemEvent: true, event, callType: cType,
        sender: currentUser.email, deletedFor: [], seenBy: [], timestamp: serverTimestamp()
      });
    } catch {}
  };

  /* ── WEBRTC ── */
  const buildPC = useCallback(() => {
    const pc = new RTCPeerConnection(ICE);
    if (localStream.current)
      localStream.current.getTracks().forEach(t => pc.addTrack(t, localStream.current));
    pc.ontrack = async e => {
      if (remoteVid.current) {
        remoteVid.current.srcObject = e.streams[0];
        // ★ FORCE EARPIECE (front speaker) on Android seamlessly upon connection
        try {
          if ('setSinkId' in remoteVid.current) {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const outputs = devices.filter(d => d.kind === 'audiooutput');
            // Look for earpiece in device labels
            const earpiece = outputs.find(d =>
              d.label.toLowerCase().includes('earpiece') ||
              d.label.toLowerCase().includes('phone')
            );
            if (earpiece) {
              await remoteVid.current.setSinkId(earpiece.deviceId);
            } else if (outputs.length > 0) {
              // Fallback to exactly 'default' sink (which is usually earpiece for audio calls)
              await remoteVid.current.setSinkId('default');
            }
          }
        } catch (err) { console.warn('Force Earpiece failed:', err); }
      }
    };
    pc.onicecandidate = e  => { if (e.candidate) socketRef.current?.emit('ice-candidate', e.candidate); };
    // ★ Boost bitrate to Full HD+ once ICE connection is established
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        pc.getSenders().forEach(async sender => {
          try {
            const params = sender.getParameters();
            if (!params.encodings?.length) params.encodings = [{}];
            if (sender.track?.kind === 'video') {
              params.encodings[0].maxBitrate   = 8_000_000;  // ★ 8 Mbps video
              params.encodings[0].maxFramerate = 60;
            } else if (sender.track?.kind === 'audio') {
              params.encodings[0].maxBitrate   = 256_000;    // ★ 256 kbps audio
            }
            await sender.setParameters(params);
          } catch (e) { /* setParameters may be unsupported on some browsers */ }
        });
      }
    };
    pcRef.current = pc;
    return pc;
  }, []);

  // ★ Fix 1: Set local video AFTER call modal renders
  useEffect(() => {
    if (!showCall) return;
    const t = setTimeout(() => {
      if (localVid.current && localStream.current)
        localVid.current.srcObject = localStream.current;
    }, 80);
    return () => clearTimeout(t);
  }, [showCall]);

  // ★ Fix 2: Flush queued ICE candidates after setRemoteDescription
  const flushIceQueue = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    const queued = iceCandQueue.current.splice(0);
    for (const c of queued) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
  }, []);

  const handleCallAccepted = useCallback(async () => {
    activeRef.current = true;
    setCallStatus('connected');
    if (callerRef.current) logCallEvent('started', callTypeRef.current);
    const pc    = buildPC();
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: callTypeRef.current === 'video' });
    await pc.setLocalDescription(offer);
    socketRef.current?.emit('offer', offer);
  }, [buildPC]);

  const handleOffer = useCallback(async offer => {
    const pc = buildPC();
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await flushIceQueue(); // ★ apply any candidates that arrived early
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socketRef.current?.emit('answer', answer);
  }, [buildPC, flushIceQueue]);

  // ★ Fix 3: Flush queue after answer sets remoteDescription
  const handleAnswer = useCallback(async ans => {
    await pcRef.current?.setRemoteDescription(new RTCSessionDescription(ans));
    await flushIceQueue();
  }, [flushIceQueue]);

  // ★ Fix 4: Queue ICE candidates if remoteDescription not set yet
  const handleIceCandidate = useCallback(async cand => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) {
      iceCandQueue.current.push(cand); // queue for later
      return;
    }
    try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) { console.warn('ICE error:', e); }
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

  // ★ Caller cancelled before answer
  const handleCallCancelled = useCallback(() => {
    setShowIncoming(false);
    endCall();
  }, [endCall]);

  /* ── MAIN SETUP ── */
  useEffect(() => {
    if (!role) { navigate('/select', { replace: true }); return; }

    // Mark me online in Firestore
    writeMyPresence(true);

    // Socket
    const socket = io();
    socketRef.current = socket;
    socket.emit('user-online', currentUser.email);

    // ★ Scenario 1 support: re-send user-online on socket reconnect
    //   so pending calls are re-delivered after brief network drop
    socket.on('reconnect', () => {
      socket.emit('user-online', currentUser.email);
    });

    // ★ Partner status via socket (source of truth for online/offline)
    socket.on('partner-status', async (status) => {
      if (status === 'online') {
        setPOnline(true);
        setPStatus('Online');
      } else {
        // Partner went offline — show Offline immediately
        setPOnline(false);
        setPStatus('Offline');
        // ★ Wait 2s for the partner's Firestore write to propagate, then read lastSeen
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

    socket.on('incoming-call',      data => { callerRef.current = false; callTypeRef.current = data.type; setIncomingData(data); setShowIncoming(true); });
    socket.on('call-accepted',       handleCallAccepted);
    socket.on('call-rejected',       handleCallRejected);
    socket.on('call-not-answered',   handleCallNotAnswered);
    socket.on('call-was-missed',     handleCallWasMissed);
    socket.on('call-cancelled',      handleCallCancelled);
    socket.on('offer',               handleOffer);
    socket.on('answer',              handleAnswer);
    socket.on('ice-candidate',       handleIceCandidate);
    socket.on('call-ended',          () => { if (activeRef.current) logCallEvent('ended', callTypeRef.current); endCall(); });

    // Messages
    const q       = query(collection(db, 'messages'), orderBy('timestamp'));
    const unsubMsg = onSnapshot(q, snap => {
      const msgs = [];
      snap.forEach(d => {
        const data = d.data();
        if (!data.deletedFor?.includes(currentUser.email)) msgs.push({ id: d.id, ...data });
      });
      setMessages(msgs);
    });

    // Go offline when tab hidden / closed
    const handleVis = () => writeMyPresence(!document.hidden);
    document.addEventListener('visibilitychange', handleVis);
    window.addEventListener('beforeunload', () => writeMyPresence(false));

    return () => {
      socket.disconnect();
      unsubMsg();
      endCall();
      writeMyPresence(false);
      document.removeEventListener('visibilitychange', handleVis);
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
    try {
      await addDoc(collection(db, 'messages'), {
        text: t, sender: currentUser.email,
        deletedFor: [], seenBy: [], timestamp: serverTimestamp()
      });
      setText('');
    } catch (e) { console.error(e); }
  };

  const deleteMsg = async id => {
    if (!window.confirm('Delete this message for YOU?')) return;
    await updateDoc(doc(db, 'messages', id), { deletedFor: arrayUnion(currentUser.email) });
  };

  const clearChat = async () => {
    if (!window.confirm('Clear entire chat history for yourself?')) return;
    const snap  = await getDocs(collection(db, 'messages'));
    const batch = writeBatch(db);
    snap.docs.forEach(d => {
      if (!d.data().deletedFor?.includes(currentUser.email))
        batch.update(d.ref, { deletedFor: arrayUnion(currentUser.email) });
    });
    await batch.commit();
  };

  /* ── IMAGE ── */
  const compressAndSend = file => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = async () => {
        const c = document.createElement('canvas');
        // HD: 2048px max, 0.92 quality — great quality, manageable size
        const MAX = 2048;
        let [w, h] = [img.width, img.height];
        if (w > h && w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
        else if (h > MAX)     { w = Math.round(w * MAX / h); h = MAX; }
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        await sendImage(c.toDataURL('image/jpeg', 0.92));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  const sendImage = async dataUrl => {
    try {
      await addDoc(collection(db, 'messages'), {
        imageUrl: dataUrl, sender: currentUser.email,
        deletedFor: [], seenBy: [], timestamp: serverTimestamp()
      });
    } catch { alert('Upload failed.'); }
  };

  /* ── CAMERA ── */
  const openCamera = async () => {
    setShowCamera(true);
    try {
      if (camStream.current) camStream.current.getTracks().forEach(t => t.stop());
      // ★ 1080p — works on all phones (back & front), 4K caused failures
      camStream.current = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode,
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
          video: { facingMode: next, width: { ideal: 1920 }, height: { ideal: 1080 } }
        });
        if (camPreview.current) camPreview.current.srcObject = camStream.current;
      } catch {}
    }, 100);
  };

  const takePhoto = () => {
    if (!camStream.current || !camPreview.current) return;
    const canvas = camCanvas.current;
    // Use native video resolution from stream (up to 1080p)
    canvas.width  = camPreview.current.videoWidth;
    canvas.height = camPreview.current.videoHeight;
    canvas.getContext('2d').drawImage(camPreview.current, 0, 0);
    closeCamera();
    // 0.95 quality = excellent JPEG
    sendImage(canvas.toDataURL('image/jpeg', 0.95));
  };

  /* ── CALLS ── */
  const initiateCall = async type => {
    try {
      callerRef.current = true;
      callTypeRef.current = type;
      setCallType(type);
      setCallStatus('ringing');
      await getMedia(type);
      setShowCall(true);
      socketRef.current?.emit('initiate-call', { caller: currentUser.email, type });
    } catch (e) {
      callerRef.current = false;
      setShowCall(false);
    }
  };

  const acceptCall = async () => {
    try {
      setShowIncoming(false);
      const type = incomingData.type;
      callTypeRef.current = type;
      setCallType(type);
      setCallStatus('connected');
      activeRef.current = true;
      await getMedia(type);
      setShowCall(true);
      socketRef.current?.emit('accept-call');
    } catch (e) {
      activeRef.current = false;
      setShowCall(false);
    }
  };

  const rejectCall   = () => { setShowIncoming(false); socketRef.current?.emit('reject-call'); };
  const toggleMute   = () => { const n = !audioMuted; setAudioMuted(n); localStream.current?.getAudioTracks().forEach(t => t.enabled = !n); };
  const toggleVideo  = () => { if (callTypeRef.current === 'audio') return; const n = !videoOff; setVideoOff(n); localStream.current?.getVideoTracks().forEach(t => t.enabled = !n); };

  // ★ Camera flip: front ⇔ rear during active video call
  const toggleCallCamera = useCallback(async () => {
    if (callTypeRef.current !== 'video') return;
    const newFacing = callCamFacing === 'user' ? 'environment' : 'user';
    try {
      // Get new video-only stream with opposite camera
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: newFacing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) return;

      // Hot-swap track in PeerConnection (no call restart needed)
      if (pcRef.current) {
        const sender = pcRef.current.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(newTrack);
      }

      // Replace in localStream and update preview
      if (localStream.current) {
        localStream.current.getVideoTracks().forEach(t => { t.stop(); localStream.current.removeTrack(t); });
        localStream.current.addTrack(newTrack);
        if (localVid.current) localVid.current.srcObject = localStream.current;
      }
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
            onClick={() => deleteMsg(msg.id)}
            style={{ position:'absolute', top:'-8px', right:'-8px', background:'rgba(255,65,108,0.9)', color:'white', padding:'6px', borderRadius:'50%', fontSize:'10px', cursor:'pointer', display:'none', zIndex:10 }} />
        )}
        <div className="msg-body">
          <span className="msg-footer">
            <span className="msg-time">{formatTime(msg.timestamp)}</span>
            {isMe && <TickIcon msg={msg} />}
          </span>
          {msg.imageUrl
            ? <img src={msg.imageUrl} alt="" style={{ maxWidth:'100%', borderRadius:'6px', cursor:'pointer', display:'block' }} onClick={() => window.open(msg.imageUrl, '_blank')} />
            : <span className="msg-text">{msg.text}</span>}
        </div>
      </div>
    );

  };

  /* ══════════ JSX ══════════ */
  return (
    <div id="app-container" className="container" style={{ display:'flex' }}>

      {/* ── SIDEBAR ── */}
      <div className="sidebar">
        <div className="header">
          <div className="user-info" style={{ display:'flex', alignItems:'center', gap:'10px' }}>
            <div style={{ width:40, height:40, borderRadius:'50%', overflow:'hidden', border:'2px solid rgba(255,255,255,0.3)', flexShrink:0 }}>
              <img src={myAvatar} style={{ width:'100%', height:'100%', objectFit:'cover' }} alt="me" />
            </div>
            <div>
              <div id="current-user-email">My Love ❤️</div>
              <div style={{ fontSize:11, color:'rgba(255,255,255,0.5)' }}>Online</div>
            </div>
          </div>
          <div className="actions">
            <button id="logout-btn" title="Logout" onClick={handleLogout}><i className="fas fa-sign-out-alt" /></button>
          </div>
        </div>
        <div className="contact-list">
          <div className="contact active">
            <div style={{ position:'relative', flexShrink:0 }}>
              <div className="contact-avatar">
                <img src={partnerAvatar} style={{ width:'100%', height:'100%', borderRadius:'50%', objectFit:'cover' }} alt="partner" />
              </div>
              {pOnline && <span className="online-dot-sidebar" />}
            </div>
            <div className="contact-details">
              <div className="contact-name">My Forever ❤️</div>
              <div className="contact-status" id="partner-status" style={{ color: pOnline ? '#00e676' : '#667781', display:'flex', alignItems:'center', gap:5 }}>
                {pOnline && <span style={{ width:7, height:7, borderRadius:'50%', background:'#00e676', display:'inline-block', boxShadow:'0 0 6px #00e676' }} />}
                {pStatus}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── MAIN CHAT ── */}
      <div className="main-chat">
        <div className="chat-header">
          <div className="contact-info">
            <div style={{ position:'relative', flexShrink:0 }}>
              <div className="contact-avatar-small" style={{ overflow:'hidden' }}>
                <img src={partnerAvatar} style={{ width:'100%', height:'100%', borderRadius:'50%', objectFit:'cover' }} alt="partner" />
              </div>
              {pOnline && <span className="online-dot-header" />}
            </div>
            <div>
              <h2 style={{ margin:0, lineHeight:1.2 }}>My Forever ❤️</h2>
              <div className={`chat-partner-status-text${pOnline ? ' is-online' : ''}`}>
                {pOnline ? <><span className="status-dot" />Online</> : pStatus}
              </div>
            </div>
          </div>
          <div className="call-actions">
            <button id="clear-chat-btn" title="Clear Chat" onClick={clearChat}><i className="fas fa-trash" /></button>
            <button id="audio-call-btn" title="Audio Call" onClick={() => initiateCall('audio')}><i className="fas fa-phone-alt" /></button>
            <button id="video-call-btn" title="Video Call" onClick={() => initiateCall('video')}><i className="fas fa-video" /></button>
          </div>
        </div>

        <div className="chat-messages" id="chat-messages">
          {messages.map(renderMessage)}
          <div ref={msgEnd} />
        </div>

        <div className="chat-input-area">
          <input type="file" ref={galleryInput} accept="image/*" style={{ display:'none' }}
            onChange={e => { if (e.target.files[0]) compressAndSend(e.target.files[0]); e.target.value = ''; }} />
          <button id="camera-btn"  title="Camera"  onClick={openCamera}><i className="fas fa-camera" /></button>
          <button id="gallery-btn" title="Gallery"  onClick={() => galleryInput.current?.click()}><i className="fas fa-image" /></button>
          <input type="text" id="message-input" placeholder="Type a message"
            value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendMessage()} />
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
                  <img src={partnerAvatar} style={{ width:'100%', height:'100%', objectFit:'cover' }} alt="" />
                </div>
                <p style={{ color:'white', fontSize:17, fontWeight:600, margin:0 }}>My Forever ❤️</p>

                {callStatus === 'ringing' && (
                  <p style={{ color:'rgba(255,255,255,0.65)', margin:0, fontSize:13 }}>
                    <i className="fas fa-circle" style={{ color:'#4cd137', fontSize:7, marginRight:6, animation:'pulse-dot 1s infinite' }} />
                    {callType === 'video' ? 'Video' : 'Audio'} Calling...
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
            <video id="local-video"  ref={localVid}  autoPlay playsInline muted  style={{ display: callType==='audio'?'none':'block' }} />

            {/* ─── CONNECTED: controls (only shown when call is active) ─── */}
            {callStatus === 'connected' && (
              <div className="call-controls">
                <button onClick={toggleMute}    title={audioMuted?'Unmute':'Mute'}   style={{ background: audioMuted  ? 'rgba(234,0,56,0.8)' : 'rgba(255,255,255,0.2)' }}><i className={`fas fa-microphone${audioMuted?'-slash':''}`} /></button>
                {callType==='video' && <button onClick={toggleVideo}  title={videoOff?'Cam On':'Cam Off'} style={{ background: videoOff    ? 'rgba(234,0,56,0.8)' : 'rgba(255,255,255,0.2)' }}><i className={`fas fa-video${videoOff?'-slash':''}`} /></button>}
                {/* ★ Camera flip: front ⇔ rear */}
                {callType === 'video' && (
                  <button onClick={toggleCallCamera} title={callCamFacing==='user'?'Rear Camera':'Front Camera'} style={{ background:'rgba(255,255,255,0.2)' }}>
                    <i className="fas fa-sync-alt" />
                  </button>
                )}
                <button id="end-call" className="danger" onClick={endCallClick}><i className="fas fa-phone-slash" /></button>
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
          <video ref={camPreview} autoPlay playsInline style={{ flex:1, width:'100%', height:'calc(100% - 120px)', objectFit:'cover' }} />
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
