import type { Metadata } from "next";
import {
  Cormorant_Garamond,
  Inter,
  JetBrains_Mono,
  Sarabun,
  Trirong,
} from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  display: "swap",
  preload: false,
});

const sarabun = Sarabun({
  variable: "--font-sarabun",
  subsets: ["latin", "thai"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  preload: false,
});

const trirong = Trirong({
  variable: "--font-trirong",
  subsets: ["latin", "thai"],
  weight: ["500", "600"],
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "BeGifted Ops",
  description: "Internal operations platform for BeGifted tools",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${cormorant.variable} ${sarabun.variable} ${trirong.variable} h-full antialiased`}
    >
      <body className="h-full flex flex-col overflow-hidden">{children}</body>
    </html>
  );
}
