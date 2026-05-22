import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import App from './App.jsx';
import './index.css';

// Use HashRouter on native Capacitor (local assets) to avoid path-based routing issues.
// Use BrowserRouter on web (server handles /route paths correctly).
const isNative = window?.Capacitor?.isNativePlatform?.() ?? false;
const Router = isNative ? HashRouter : BrowserRouter;

ReactDOM.createRoot(document.getElementById('root')).render(
  <Router>
    <App />
  </Router>
);
