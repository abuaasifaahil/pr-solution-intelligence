'use client';

/**
 * Phase 3 — Clipboard helper (M8.9).
 *
 * Wraps `navigator.clipboard.writeText` with a fallback to the legacy
 * `document.execCommand('copy')` path so we don't break on insecure
 * contexts (file://, IP-based dev URLs) or sandboxed environments where
 * the async clipboard API is unavailable.
 *
 * Returns `true` when the copy succeeds, `false` otherwise. Callers can
 * use the boolean to drive a "Copied" affordance.
 *
 * @file lib/clipboard.ts
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  if (typeof document !== 'undefined') {
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
  return false;
}
