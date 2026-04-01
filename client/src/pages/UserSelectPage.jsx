import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth } from '../firebase.js';

const tiles = [
  { id: 'withdraw', icon: 'fas fa-arrow-up', label: 'Withdraw', color: '#ff4b2b' },
  { id: 'credit',   icon: 'fas fa-arrow-down', label: 'Credit', color: '#11998e' },
  { id: 'balance',  icon: 'fas fa-wallet', label: 'Balance', color: '#f5a623' },
  { id: 'help',     icon: 'fas fa-headset', label: 'Help', color: '#0a84ff' },
];

export default function UserSelectPage() {
  const navigate = useNavigate();
  const [activeModal, setActiveModal] = useState(null);
  const [showRolePicker, setShowRolePicker] = useState(false);

  const handleTile = (id) => {
    if (id === 'help') {
      setShowRolePicker(true); 
    } else {
      setActiveModal(id);
    }
  };

  const selectRole = (role) => {
    localStorage.setItem('userRole', role);
    setShowRolePicker(false);
    navigate('/help');
  };

  const handleLogout = async () => {
    await signOut(auth);
    localStorage.removeItem('userRole');
    navigate('/login');
  };

  return (
    <div id="bank-dashboard" style={{
      minHeight: '100vh', width: '100vw', background: '#0b141a',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Inter', sans-serif", color: '#fff', padding: '20px'
    }}>
      
      {/* Top Logout (discreet) */}
      <button 
        onClick={handleLogout}
        style={{
          position: 'absolute', top: '20px', right: '20px',
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
          color: '#8696a0', padding: '8px 15px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px'
        }}
      >
        Logout
      </button>

      <h1 style={{ marginBottom: '40px', fontSize: '24px', fontWeight: '700', color: '#e9edef' }}>
        Dashboard Access
      </h1>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)',
        gap: '20px', width: '100%', maxWidth: '400px'
      }}>
        {tiles.map(tile => (
          <div
            key={tile.id}
            onClick={() => handleTile(tile.id)}
            style={{
              background: '#111b21', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '16px', padding: '30px 20px', textAlign: 'center',
              cursor: 'pointer', transition: 'transform 0.2s',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '15px'
            }}
            onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-5px)'}
            onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}
          >
            <div style={{
              width: '60px', height: '60px', borderRadius: '50%',
              background: `${tile.color}15`, color: tile.color,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px'
            }}>
              <i className={tile.icon} />
            </div>
            <div style={{ fontSize: '16px', fontWeight: '600' }}>{tile.label}</div>
          </div>
        ))}
      </div>

      {/* Discreet Role Picker */}
      {showRolePicker && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)',
          zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center'
        }} onClick={() => setShowRolePicker(false)}>
          <div style={{
            background: '#111b21', padding: '30px', borderRadius: '20px',
            width: '320px', textAlign: 'center', border: '1px solid rgba(255,255,255,0.1)'
          }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: '18px', marginBottom: '20px' }}>Select Account Holder</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button onClick={() => selectRole('user1')} style={{
                background: '#0a84ff', color: '#fff', border: 'none', padding: '12px',
                borderRadius: '10px', fontWeight: '600', cursor: 'pointer'
              }}>Primary Account</button>
              <button onClick={() => selectRole('user2')} style={{
                background: '#00c97a', color: '#fff', border: 'none', padding: '12px',
                borderRadius: '10px', fontWeight: '600', cursor: 'pointer'
              }}>Joint Account</button>
            </div>
          </div>
        </div>
      )}

      {/* Non-Help Tiles Service Modal */}
      {activeModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)',
          zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center'
        }} onClick={() => setActiveModal(null)}>
          <div style={{
            background: '#111b21', padding: '30px', borderRadius: '20px',
            width: '320px', textAlign: 'center', border: '1px solid rgba(255,255,255,0.1)'
          }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: '18px', marginBottom: '15px' }}>Service Unavailable</h2>
            <p style={{ color: '#8696a0', fontSize: '14px', marginBottom: '20px' }}>
              Due to maintenance, {activeModal} service is currently unavailable. Please try again later.
            </p>
            <button onClick={() => setActiveModal(null)} style={{
              background: '#2a3942', color: '#fff', border: 'none', padding: '10px 20px',
              borderRadius: '8px', cursor: 'pointer'
            }}>Close</button>
          </div>
        </div>
      )}

    </div>
  );
}
