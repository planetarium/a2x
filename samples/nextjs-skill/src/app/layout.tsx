import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "A2X Skills Demo",
  description: "Showcases the Claude Agent Skills runtime integrated into @a2x/sdk.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
