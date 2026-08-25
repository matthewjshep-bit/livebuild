import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MatterMatt",
  description: "Property tours built from listing photos and a hand-drawn floor plan",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
