import React, { createContext, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../firebase.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (user) {
        // Strict UID Check!
        const u1 = import.meta.env.VITE_USER1_UID?.trim();
        const u2 = import.meta.env.VITE_USER2_UID?.trim();
        const allowedUIDs = [u1, u2].filter(Boolean);
        
        // If UIDs are strictly set in .env, check against them
        if (allowedUIDs.length > 0) {
            if (allowedUIDs.includes(user.uid)) {
                setCurrentUser(user);
                setAuthorized(true);
                localStorage.setItem('userRole', user.uid === u1 ? 'user1' : 'user2');
            } else {
                // Hacker or unlisted user trying to login
                console.warn("ACCESS DENIED: UID not in authorized whitelist.");
                await signOut(auth);
                setCurrentUser(null);
                setAuthorized(false);
                localStorage.removeItem('userRole');
            }
        } else {
             // Fallback for local testing without .env setup
             setCurrentUser(user);
             setAuthorized(true);
             localStorage.setItem('userRole', 'user1');
        }
      } else {
        setCurrentUser(null);
        setAuthorized(false);
        localStorage.removeItem('userRole');
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  return (
    <AuthContext.Provider value={{ currentUser, loading, authorized }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
