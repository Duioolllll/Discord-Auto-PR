import { formatTime } from '../../../lib/time';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, sessionToken, type Job } from '../../../lib/api';
import { jobAction } from '../../actions';
import { Refresh } from '../../refresh';
export const dynamic = 'force-dynamic';
export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  if (!(await sessionToken())) redirect('/');
  const { id } = await params;
  const { error } = await searchParams;
  let job: Job;
  let events: { kind: string; message: string; sequence: number; createdAt: string }[];
  let audit: { action: string; actorId: string; createdAt: string }[];
  try {
    [job, { events }, audit] = await Promise.all([
      api<Job>(`/jobs/${id}`),
      api<{ events: typeof events }>(`/jobs/${id}/events`),
      api<typeof audit>(`/audit?jobId=${id}`),
    ]);
  } catch {
    return (
      <main className="content">
        <Link href="/">← Overview</Link>
        <h1>작업을 읽을 수 없습니다</h1>
        <p>작업 ID와 저장소 접근 권한을 확인해 주세요.</p>
      </main>
    );
  }
  return (
    <main className="content detail">
      <Link href="/">← Overview</Link>
      <header>
        <div>
          <span className="eyebrow">JOB / {id.slice(0, 8)}</span>
          <h1>{job.repository.fullName}</h1>
          <p>
            {job.kind} · {job.engine} · {job.actorId}
          </p>
        </div>
        <Refresh jobId={id} />
      </header>
      <span className={`status ${job.status.toLowerCase()}`}>{job.status}</span>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <section>
        <h2>Request</h2>
        <pre>{job.instruction}</pre>
        {job.errorCode && <p className="error">{job.errorCode}</p>}
        {job.pullRequest && (
          <p>
            <a href={job.pullRequest.url} rel="noreferrer">
              PR #{job.pullRequest.number} ↗
            </a>{' '}
            · <code>{job.pullRequest.headSha}</code>
          </p>
        )}
        <div className="actions">
          {['cancel', 'approve', 'merge'].map((action) => (
            <form action={jobAction} key={action}>
              <input type="hidden" name="jobId" value={id} />
              <button className="quiet" name="action" value={action}>
                {action === 'cancel'
                  ? '취소 요청'
                  : action === 'approve'
                    ? '현재 SHA 승인'
                    : '병합 요청'}
              </button>
            </form>
          ))}
        </div>
        <small>
          승인과 병합은 연결된 GitHub 사용자·리뷰·현재 SHA·필수 체크를 서버에서 다시 검사합니다.
        </small>
      </section>
      <section>
        <div className="section-title">
          <h2>Event timeline</h2>
          <span>DB events</span>
        </div>
        {events.map((event) => (
          <div className="event" key={event.sequence}>
            <span className="eyebrow">
              {event.kind} · {formatTime(event.createdAt)} KST
            </span>
            <pre>{event.message}</pre>
          </div>
        ))}
      </section>
      <section>
        <h2>Audit trail</h2>
        {audit.map((entry, index) => (
          <div className="worker" key={index}>
            <b>{entry.action}</b>
            <span>{entry.actorId}</span>
            <small>{formatTime(entry.createdAt)} KST</small>
          </div>
        ))}
      </section>
    </main>
  );
}
