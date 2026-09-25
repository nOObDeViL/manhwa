import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import './globals.css';
import AppShell from '@/components/AppShell';

export const metadata: Metadata = {
  title: 'Manhwa Recap Studio Cloud',
  description: 'Serverless manhwa recap video studio — Google Drive storage, AI scripts, panel slicing, TTS and in-browser rendering.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  appleWebApp: { capable: true, title: 'Recap Studio', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  themeColor: '#09090b',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased font-sans">
        <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
