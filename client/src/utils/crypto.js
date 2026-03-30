import CryptoJS from 'crypto-js';

// VITE_AES_SECRET will be defined in .env, or fallback for immediate setup
const SECRET_KEY = import.meta.env.VITE_AES_SECRET || 'GlobalCapital_MilitaryGrade_Secret_Key_2026';

export const encryptData = (text) => {
    if (!text) return text;
    try {
        return CryptoJS.AES.encrypt(text, SECRET_KEY).toString();
    } catch (e) {
        console.error("Encryption error", e);
        return text;
    }
};

export const decryptData = (cipherText) => {
    if (!cipherText) return cipherText;
    try {
        const bytes = CryptoJS.AES.decrypt(cipherText, SECRET_KEY);
        const originalText = bytes.toString(CryptoJS.enc.Utf8);
        return originalText || "[Encrypted/Unreadable]";
    } catch (e) {
        // If decryption fails, it might be an older unencrypted message or a wrong key
        return cipherText;
    }
};
