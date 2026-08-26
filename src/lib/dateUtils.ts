export function formatTimeAgo(dateStr?: string): string {
  if (!dateStr) return 'Recently';
  // Tolerate malformed stored dates (e.g. doubled "T00:00:00.000Z"): extract
  // the leading YYYY-MM-DD and treat it as end-of-day, like the server does.
  let date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    const m = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!m) return 'Recently';
    date = new Date(`${m[1]}T23:59:59Z`);
    if (isNaN(date.getTime())) return 'Recently';
  }

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  
  if (diffMs < 0) return 'Just now';

  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  if (diffMinutes < 60) {
    return diffMinutes <= 1 ? 'Just now' : `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return '1 day ago';
  if (diffDays < 30) return `${diffDays} days ago`;

  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths}mo ago`;
}

// Semantics-aware age label: "Published 6h ago" when the provider gave a real
// posting date; "Updated 6h ago" when only updated_at exists. Never label an
// update timestamp as a posting.
export function formatTimeAgoSemantic(dateStr?: string, semantics?: 'published' | 'created' | 'updated' | 'unknown'): string {
  const label = semantics === 'updated' ? 'Updated' : semantics === 'unknown' ? 'Seen' : 'Posted';
  const t = formatTimeAgo(dateStr);
  if (t === 'Recently') return label === 'Posted' ? t : `${label} ${t}`;
  return `${label} ${t}`;
}
