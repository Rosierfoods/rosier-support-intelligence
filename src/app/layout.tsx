import type { Metadata, Viewport } from 'next';
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Rosier Support Intelligence', template: '%s · Rosier Support Intelligence' },
  description: 'AI customer support intelligence and quality management for Rosier Foods',
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { themeColor: '#784900', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
