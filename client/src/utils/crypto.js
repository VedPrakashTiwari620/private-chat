import CryptoJS from 'crypto-js';

// IMPORTANT: Use env var BUT with a consistent hardcoded fallback.
// The fallback is used when VITE_AES_SECRET is not set (e.g., Render deployment).
// APK and web MUST use the same key — env var must match if set.
const SECRET_KEY = (import.meta.env.VITE_AES_SECRET || '').trim()
  || 'GlobalCapital_MilitaryGrade_Secret_Key_2026';

// AES prefix that CryptoJS always adds — lets us detect if text is actually encrypted
const AES_PREFIX = 'U2FsdGVk'; // Base64("Salted__")

export const encryptData = (text) => {
  if (!text) return text;
  try {
    return CryptoJS.AES.encrypt(text, SECRET_KEY).toString();
  } catch (e) {
    console.error('Encryption error', e);
    return text;
  }
};

export const decryptData = (cipherText) => {
  if (!cipherText) return cipherText;

  // If text doesn't look like AES ciphertext, it's already plain (old message)
  if (!cipherText.startsWith(AES_PREFIX)) return cipherText;

  try {
    const bytes = CryptoJS.AES.decrypt(cipherText, SECRET_KEY);
    const original = bytes.toString(CryptoJS.enc.Utf8);
    if (original) return original;
  } catch {}

  // Fallback: try with the hardcoded key in case env var was different
  try {
    const bytes2 = CryptoJS.AES.decrypt(cipherText, 'GlobalCapital_MilitaryGrade_Secret_Key_2026');
    const original2 = bytes2.toString(CryptoJS.enc.Utf8);
    if (original2) return original2;
  } catch {}

  return '[Encrypted/Unreadable]';
};
