import React, { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../firebase.js';

const inp = {
  width:'100%', padding:'14px 15px', border:'1px solid #dcdde1',
  borderRadius:'4px', fontSize:'14px', color:'#2f3640',
  background:'#fdfdfd', outline:'none', boxSizing:'border-box'
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
    <div id="login-container" className="container" style={{ background:'#f4f7f6', display:'flex', justifyContent:'center', alignItems:'center' }}>
      <style>{`
        #login-container input::placeholder { color:#7f8c8d !important; }
        #login-container input:focus { border-color:#004080 !important; box-shadow:0 0 5px rgba(0,64,128,0.2) !important; }
        #login-container button:hover { background:#003070 !important; }
      `}</style>
      <div style={{ background:'#fff', borderRadius:'6px', borderTop:'6px solid #004080', boxShadow:'0 15px 35px rgba(0,0,0,0.1)', width:'380px', padding:'45px 35px', textAlign:'center', fontFamily:"'Segoe UI',Arial,sans-serif" }}>
        <div style={{ fontSize:'45px', color:'#004080', marginBottom:'20px' }}><i className="fas fa-university" /></div>
        <h2 style={{ color:'#1a252f', fontWeight:700, fontSize:'24px', marginBottom:'5px' }}>Global Capital Bank</h2>
        <p style={{ color:'#7f8c8d', fontSize:'13px', marginBottom:'35px' }}>Secure Corporate NetBanking</p>
        <form onSubmit={handle}>
          <div style={{ marginBottom:'20px' }}>
            <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="Customer NetID (Email)" style={inp} />
          </div>
          <div style={{ marginBottom:'25px' }}>
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Secure PIN / Password" style={inp} />
          </div>
          <button type="submit" style={{ width:'100%', background:'#004080', color:'white', border:'none', padding:'15px', borderRadius:'4px', fontSize:'15px', fontWeight:600, cursor:'pointer', textTransform:'uppercase', letterSpacing:'0.5px', boxShadow:'0 4px 6px rgba(0,64,128,0.2)', transition:'background 0.3s' }}>
            Secure Login
          </button>
        </form>
        {error && <p style={{ color:'#e74c3c', marginTop:'15px', fontSize:'13px' }}>{error}</p>}
        <div style={{ marginTop:'35px', borderTop:'1px solid #ecf0f1', paddingTop:'20px', fontSize:'11px', color:'#95a5a6', lineHeight:1.6 }}>
          <i className="fas fa-lock" style={{ color:'#27ae60' }} /> <strong style={{ color:'#7f8c8d' }}>256-Bit SSL Encrypted Connection</strong><br />
          Never share your confidential PIN with anyone.<br />
          © 2026 Global Capital Financial Inc.
        </div>
      </div>
    </div>
  );
}
