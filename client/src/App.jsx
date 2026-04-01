import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import LoginPage from './pages/LoginPage.jsx';
import UserSelectPage from './pages/UserSelectPage.jsx';
import ChatPage from './pages/ChatPage.jsx';

function AppRoutes() {
  const { currentUser, loading, authorized } = useAuth();
  const savedRole = localStorage.getItem('userRole');

  if (loading) return (
    <div style={{ display:'flex', justifyContent:'center', alignItems:'center', height:'100vh' }}>
      <i className="fas fa-spinner fa-spin" style={{ fontSize:'2.5rem', color:'rgba(255,255,255,0.7)' }}></i>
    </div>
  );
  return (
    <Routes>
      <Route path="/login"  element={!authorized ? <LoginPage />      : <Navigate to="/select" replace />} />
      <Route path="/select" element={ authorized  ? <UserSelectPage /> : <Navigate to="/login"  replace />} />
      <Route path="/help"   element={ authorized  ? <ChatPage />       : <Navigate to="/login"  replace />} />
      <Route path="/chat"   element={ authorized  ? <Navigate to="/help" replace /> : <Navigate to="/login" replace />} />
      <Route path="*"       element={<Navigate to={authorized ? (savedRole ? '/help' : '/select') : '/login'} replace />} />
    </Routes>
  );
}


export default function App() {
  React.useEffect(() => {
    const block = e => {
      if (e.keyCode === 123) e.preventDefault();
      if (e.ctrlKey && e.shiftKey && [73,74].includes(e.keyCode)) e.preventDefault();
      if (e.ctrlKey && e.keyCode === 85) e.preventDefault();
    };
    document.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('keydown', block);
    return () => { document.removeEventListener('keydown', block); };
  }, []);

  return <AuthProvider><AppRoutes /></AuthProvider>;
}
