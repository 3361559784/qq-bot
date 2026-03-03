import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { IBM_Plex_Mono, Space_Grotesk } from 'next/font/google';
import './globals.css';

const sans = Space_Grotesk({ subsets: ['latin'], variable: '--font-sans' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'SchoolBot Console',
  description: 'SchoolBot web console for chat and computer-use operations.'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className={`${sans.variable} ${mono.variable}`}>
        <div className="app-shell">
          <header className="topbar">
            <div className="brand">SchoolBot Console</div>
            <nav className="nav-links">
              <Link href="/">Chat</Link>
              <Link href="/jobs">Computer-Use Jobs</Link>
            </nav>
          </header>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
