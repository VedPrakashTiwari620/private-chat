import React from 'react';
import { useNavigate } from 'react-router-dom';

export default function UserSelectPage() {
  const navigate = useNavigate();
  const select = role => {
    localStorage.setItem('userRole', role);
    navigate('/chat');
  };
  return (
    <div id="user-select-container" className="container" style={{ display:'flex', justifyContent:'center', alignItems:'center' }}>
      <div className="user-select-box">
        <div className="user-select-logo"><i className="fas fa-comments" /></div>
        <h2 className="user-select-title">Who are you?</h2>
        <p className="user-select-sub">Choose your identity to enter the chat</p>
        <div className="user-cards">
          <div className="user-card" id="select-user1" onClick={() => select('user1')}>
            <div className="user-card-avatar">
              <img src="/avatar2.png" alt="Her" />
              <div className="user-card-glow glow-pink" />
            </div>
            <div className="user-card-name">💖 Her</div>
            <div className="user-card-hint">Enter as yourself</div>
          </div>
          <div className="user-card" id="select-user2" onClick={() => select('user2')}>
            <div className="user-card-avatar">
              <img src="/avatar1.png" alt="Him" />
              <div className="user-card-glow glow-blue" />
            </div>
            <div className="user-card-name">💙 Him</div>
            <div className="user-card-hint">Enter as yourself</div>
          </div>
        </div>
      </div>
    </div>
  );
}
