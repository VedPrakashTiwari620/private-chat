import React, { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../firebase.js';

const inp = {
  width:'100%', padding:'14px 15px', border:'1px solid rgba(255,255,255,0.1)',
  borderRadius:'6px', fontSize:'14px', color:'#e9edef',
  background:'#182229', outline:'none', boxSizing:'border-box', transition:'all 0.3s'
};

export default function LoginPage() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');

  const handle = async e => {
    e.preventDefault();
    setError('');
    if (!email || !password) { setError('Please enter your valid Customer NetID and PIN.'); return; }
    try { await signInWithEmailAndPassword(auth, email, password); }
    catch { setError('Error: Invalid credentials. Authentication locked.'); }
  };

  return (
    <div id="login-container" className="container" style={{ background:'#0b141a', display:'flex', justifyContent:'center', alignItems:'center', height:'100vh', width:'100vw' }}>
      <style>{`
        #login-container input::placeholder { color:#8696a0 !important; }
        #login-container input:focus { border-color:#0a84ff !important; box-shadow:0 0 8px rgba(10,132,255,0.3) !important; background:#202c33 !important; }
        #login-container button:hover { background:#0066cc !important; transform:translateY(-1px); }
      `}</style>
      <div style={{ background:'#111b21', borderRadius:'12px', borderTop:'6px solid #0a84ff', boxShadow:'0 20px 50px rgba(0,0,0,0.8)', width:'380px', padding:'45px 35px', textAlign:'center', fontFamily:"'Inter', 'Segoe UI', Arial, sans-serif" }}>
        
        <div style={{ fontSize:'48px', color:'#0a84ff', marginBottom:'20px', textShadow:'0 0 20px rgba(10,132,255,0.4)' }}>
          <i className="fas fa-university" />
        </div>
        <h2 style={{ color:'#e9edef', fontWeight:700, fontSize:'24px', marginBottom:'6px', letterSpacing:'-0.5px' }}>Global Capital Bank</h2>
        <p style={{ color:'#8696a0', fontSize:'14px', marginBottom:'35px' }}>Secure Corporate NetBanking</p>

        <form onSubmit={handle}>
          <div style={{ marginBottom:'20px' }}>
            <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="Customer NetID (Email)" style={inp} />
          </div>
          <div style={{ marginBottom:'25px' }}>
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Secure PIN / Password" style={inp} />
          </div>
          <button type="submit" style={{ width:'100%', background:'#0a84ff', color:'white', border:'none', padding:'15px', borderRadius:'6px', fontSize:'15px', fontWeight:700, cursor:'pointer', textTransform:'uppercase', letterSpacing:'0.5px', boxShadow:'0 6px 15px rgba(10,132,255,0.3)', transition:'all 0.3s' }}>
            Secure Login
          </button>
        </form>
        
        {error && <p style={{ color:'#ff4b4b', marginTop:'15px', fontSize:'13px', fontWeight:600 }}>{error}</p>}
        
        <div style={{ marginTop:'35px', borderTop:'1px solid rgba(255,255,255,0.05)', paddingTop:'20px', fontSize:'11px', color:'#667781', lineHeight:1.6 }}>
          <i className="fas fa-shield-alt" style={{ color:'#00a884', marginRight:'4px' }} /> <strong style={{ color:'#aebac1' }}>256-Bit SSL Encrypted Connection</strong><br />
          Never share your confidential PIN with anyone.<br />
          © 2026 Global Capital Financial Inc.
        </div>
      </div>
    </div>
  );
}
