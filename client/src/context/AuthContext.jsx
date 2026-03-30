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
        const allowedUIDs = [
          import.meta.env.VITE_USER1_UID, 
          import.meta.env.VITE_USER2_UID
        ].filter(Boolean); // removes undefined if not set
        
        // During dev setup, if no UIDs in .env, we fallback to old Firestore check or permit them
        // But the ultimate requirement is EXACT uid matching. So if array exists and includes uid:
        if (allowedUIDs.length > 0 && !allowedUIDs.includes(user.uid)) {
            // Unrecognized user. Forcible Logout.
            console.warn("ACCESS DENIED: UID not in authorized whitelist.");
            await signOut(auth);
            setCurrentUser(null);
            setAuthorized(false);
            setLoading(false);
            return;
        }
        
        try {
          // Additional safety check based on old design just in case
          const snap = await getDoc(doc(db, 'allowedUsers', user.email));
          if (snap.exists() && snap.data().allowed === true) {
            setCurrentUser(user);
            setAuthorized(true);
          } else {
            // Still fallback to old doc check if .env is not setup properly yet
            // If it is setup and allowedUID is matched, you might even skip this DB check.
            if (allowedUIDs.includes(user.uid)) {
               setCurrentUser(user);
               setAuthorized(true);
            } else {
               await signOut(auth);
               setCurrentUser(null);
               setAuthorized(false);
            }
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
