import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CampusAI - Copilot Style",
  description: "Your AI Campus Companion",
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
