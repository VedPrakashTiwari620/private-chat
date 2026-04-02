import React from 'react';
import { useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth } from '../firebase.js';

export default function UserSelectPage() {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut(auth);
    navigate('/login', { replace: true });
  };

  const gotoChat = () => {
    navigate('/chat');
  };

  return (
    <div id="user-select-container" className="container" style={{ display:'flex', justifyContent:'center', alignItems:'center' }}>
      <div className="user-select-box" style={{ minWidth: '350px' }}>
        <div className="user-select-logo"><i className="fas fa-shield-alt" style={{ fontSize:'48px', color:'#00a884', marginBottom:'10px' }} /></div>
        <h2 className="user-select-title">Secure Portal</h2>
        <p className="user-select-sub">End-to-End Encrypted Session</p>

        <div style={{ display:'flex', flexDirection:'column', gap:15, marginTop:30 }}>
            <button onClick={gotoChat} style={{ background:'#00a884', color:'#111b21', border:'none', padding:'16px 20px', borderRadius:'12px', fontSize:'16px', fontWeight:'700', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:10, boxShadow:'0 8px 20px rgba(0, 168, 132, 0.4)', transition:'all 0.3s' }}>
              <i className="fas fa-comments" /> Open Chat
            </button>
            <button onClick={handleLogout} style={{ background:'transparent', color:'#ff4b4b', border:'1px solid rgba(255,75,75,0.4)', padding:'16px 20px', borderRadius:'12px', fontSize:'16px', fontWeight:'700', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:10, transition:'all 0.3s' }}
              onMouseOver={e=>{e.currentTarget.style.background='rgba(255,75,75,0.1)'}}
              onMouseOut={e=>{e.currentTarget.style.background='transparent'}}
            >
              <i className="fas fa-power-off" /> Secure Log Out
            </button>
        </div>
      </div>
    </div>
  );
}
