import type { ReactNode } from 'react';
import './style.css';
export const metadata = {
  title: 'PR Hub · Control room',
  description: 'Discord AI PR Hub 운영 대시보드',
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
