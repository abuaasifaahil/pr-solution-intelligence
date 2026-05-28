import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'PR Solution Intelligence',
  description: 'AlphaMetricX — agentic AI platform for PR and media intelligence',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "'DM Sans', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
          background: '#F5F5F5',
          color: '#1A1A1A',
        }}
      >
        {children}
      </body>
    </html>
  );
}
