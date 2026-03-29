export function formatTime(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
}

export function formatLastSeen(ts) {
  if (!ts || typeof ts.toDate !== 'function' && typeof ts !== 'number' && !(ts instanceof Date)) return 'Offline';
  try {
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const diffMin = Math.floor((Date.now() - d) / 60000);
    const diffHr  = Math.floor(diffMin / 60);
    if (isNaN(diffMin))   return 'Offline';
    if (diffMin < 1)      return 'Last seen just now';
    if (diffMin < 60)     return `Last seen ${diffMin}m ago`;
    if (diffHr  < 24)     return `Last seen at ${formatTime(ts)}`;
    return `Last seen ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${formatTime(ts)}`;
  } catch { return 'Offline'; }
}

