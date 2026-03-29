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
        try {
          const snap = await getDoc(doc(db, 'allowedUsers', user.email));
          if (snap.exists() && snap.data().allowed === true) {
            setCurrentUser(user);
            setAuthorized(true);
          } else {
            await signOut(auth);
            setCurrentUser(null);
            setAuthorized(false);
          }
        } catch {
          setCurrentUser(null);
          setAuthorized(false);
        }
      } else {
        setCurrentUser(null);
        setAuthorized(false);
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
