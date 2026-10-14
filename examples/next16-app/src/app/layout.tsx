import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hoplens example",
  description: "Example app for the Hoplens request visualizer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
