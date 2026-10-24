'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
export function Refresh({ jobId }: { jobId?: string }) {
  const router = useRouter();
  const [active, setActive] = useState(false);
  useEffect(() => {
    setActive(true);
    let lastRefresh = 0;
    const refresh = () => {
      if (!document.hidden && Date.now() - lastRefresh > 1000) {
        lastRefresh = Date.now();
        router.refresh();
      }
    };
    const timer = setInterval(() => {
      refresh();
    }, 5000);
    const stream = jobId ? new EventSource(`/api/jobs/${jobId}/stream`) : undefined;
    stream?.addEventListener('job', refresh);
    return () => {
      clearInterval(timer);
      stream?.close();
    };
  }, [router, jobId]);
  return (
    <span className="live" data-active={active}>
      <i /> LIVE · 5s
    </span>
  );
}
