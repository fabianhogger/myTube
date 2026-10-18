import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { TopBar } from "./components/TopBar";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "MyTube",
  description: "A local YouTube feed, filtered by your own system prompt.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <TopBar />
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
