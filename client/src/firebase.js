import { initializeApp } from 'firebase/app';
import { getAuth, browserLocalPersistence, setPersistence } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: "AIzaSyAIw8Dkgkig2KDRMm4pZRGUUbDFM25HMsg",
  authDomain: "private-chat-c30e6.firebaseapp.com",
  projectId: "private-chat-c30e6",
  storageBucket: "private-chat-c30e6.firebasestorage.app",
  messagingSenderId: "76237188707",
  appId: "1:76237188707:web:924b0bd11ba81fecebd256"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

setPersistence(auth, browserLocalPersistence).catch(console.error);