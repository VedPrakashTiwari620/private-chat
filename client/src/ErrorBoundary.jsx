import React from 'react';

/**
 * ErrorBoundary — catches any React rendering crash and shows
 * a debug message instead of a blank white screen.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Caught error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', background: '#0b141a',
          color: '#e9edef', padding: '24px', textAlign: 'center', fontFamily: 'Inter,sans-serif'
        }}>
          <i className="fas fa-exclamation-triangle" style={{ fontSize: '48px', color: '#ff4b4b', marginBottom: '16px' }} />
          <h2 style={{ margin: '0 0 8px', fontSize: '20px' }}>Something went wrong</h2>
          <p style={{ color: '#8696a0', fontSize: '13px', maxWidth: '300px', lineHeight: 1.6 }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{
              marginTop: '20px', background: '#00a884', color: '#111b21',
              border: 'none', padding: '12px 28px', borderRadius: '24px',
              fontSize: '14px', fontWeight: '700', cursor: 'pointer'
            }}
          >
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
