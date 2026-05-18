import './globals.css';
import './mobile-styles.css';

export const metadata = {
  title: "Kiddost Support",
  description: "Agent messaging dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#25D366" />
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
      </head>

      <body>{children}</body>
    </html>
  );
}