import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "CampusAI - Copilot Style",
  description: "Your AI Campus Companion",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Campus AI",
  },
  formatDetection: {
    telephone: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="font-sans antialiased bg-white dark:bg-gray-950">
        {children}
      </body>
    </html>
  );
}
