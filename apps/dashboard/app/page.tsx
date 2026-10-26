import { formatTime } from '../lib/time';
import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { api, sessionToken, type Job, type Repository, type Worker } from '../lib/api';
import { login, logout, createJob } from './actions';
import { Refresh } from './refresh';
import { SetupGuide } from './setup-guide';
export const dynamic = 'force-dynamic';
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  if (!(await sessionToken()))
    return (
      <main className="welcome">
        <div className="login">
          <div className="brand">
            ◈ <b>PR HUB</b>
          </div>
          <h1>Control room</h1>
          <p>Codex CLI 작업, 워커와 PR 승인을 한 곳에서 확인합니다.</p>
          <form action={login}>
            <label htmlFor="token">Control API access token</label>
            <input
              id="token"
              name="token"
              type="password"
              autoComplete="off"
              required
              minLength={32}
            />
            <button>대시보드 열기 →</button>
          </form>
          {error && (
            <p role="alert" className="error">
              인증 또는 API 연결을 확인해 주세요.
            </p>
          )}
          <small>토큰은 암호화된 HttpOnly 세션으로 보관됩니다.</small>
          <a className="setup-shortcut" href="#setup">
            처음 연결하시나요? 키 발급·설정 안내 ↓
          </a>
        </div>
        <SetupGuide />
      </main>
    );
  const results = await Promise.allSettled([
    api<Job[]>('/jobs'),
    api<Repository[]>('/repositories'),
    api<Worker[]>('/workers'),
  ]);
  const jobs = results[0].status === 'fulfilled' ? results[0].value : [];
  const repos = results[1].status === 'fulfilled' ? results[1].value : [];
  const workers = results[2].status === 'fulfilled' ? results[2].value : [];
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          ◈ <b>PR HUB</b>
        </div>
        <form className="mobile-logout" action={logout}>
          <button className="quiet">로그아웃</button>
        </form>
        <span className="eyebrow">WORKSPACE</span>
        <nav>
          <a className="active" href="#jobs">
            ◫ &nbsp; Overview
          </a>
          <a href="#request">＋ &nbsp; New request</a>
          <a href="#workers">▦ &nbsp; Workers</a>
          <a href="#repositories">⌘ &nbsp; Repositories</a>
          <a href="#setup">⚙ &nbsp; 키 발급·설정</a>
        </nav>
        <div className="aside-bottom">
          <span className="pill">LOCAL CONTROL PLANE</span>
          <form action={logout}>
            <button className="quiet">로그아웃 ↗</button>
          </form>
        </div>
      </aside>
      <main className="content">
        <header>
          <div>
            <span className="eyebrow">WORKSPACE / OVERVIEW</span>
            <h1>
              Control room<span className="dot">.</span>
            </h1>
            <p>로그인한 Codex CLI가 요청을 실행하고 검증된 변경으로 PR을 만듭니다.</p>
          </div>
          <Refresh />
        </header>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {results[0].status === 'rejected' && (
          <p role="alert" className="error">
            Control API를 읽을 수 없습니다. API 연결과 세션 권한을 확인해 주세요.
          </p>
        )}
        <div className="metrics">
          {[
            ['Queued', jobs.filter((j) => j.status === 'QUEUED').length],
            [
              'In progress',
              jobs.filter((j) =>
                ['LEASED', 'RUNNING', 'PUBLISHING', 'REVIEWING', 'CI_WAIT'].includes(j.status),
              ).length,
            ],
            ['Needs approval', jobs.filter((j) => j.status === 'APPROVAL_WAIT').length],
            ['Merged', jobs.filter((j) => j.status === 'MERGED').length],
          ].map(([name, value]) => (
            <div className="metric" key={name}>
              <span>{name}</span>
              <strong>{value}</strong>
              <small>최근 {jobs.length}개 작업 기준</small>
            </div>
          ))}
        </div>
        <section id="jobs">
          <div className="section-title">
            <h2>Recent activity</h2>
            <span>{jobs.length} jobs</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>WORK ITEM</th>
                  <th>REPOSITORY</th>
                  <th>ENGINE</th>
                  <th>STATUS</th>
                  <th>CREATED</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <Link className="job-name" href={`/jobs/${job.id}`}>
                        {job.instruction.slice(0, 80)}
                      </Link>
                      <small>{job.id.slice(0, 8)}</small>
                    </td>
                    <td>{job.repository.fullName}</td>
                    <td>
                      <span className="engine">{job.engine}</span>
                    </td>
                    <td>
                      <span className={`status ${job.status.toLowerCase()}`}>
                        {job.status.replaceAll('_', ' ')}
                      </span>
                    </td>
                    <td>{formatTime(job.createdAt)} KST</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!jobs.length && (
              <div className="empty">
                <b>아직 작업이 없습니다</b>
                <p>저장소를 등록하고 CLI 워커를 연결한 다음 첫 개발 요청을 만들어 보세요.</p>
              </div>
            )}
          </div>
        </section>
        <div className="two-columns">
          <section id="request">
            <div className="section-title">
              <h2>Create a request</h2>
              <span>Codex CLI</span>
            </div>
            <form className="request-form" action={createJob}>
              <input type="hidden" name="requestId" value={`dashboard:${randomUUID()}`} />
              <label htmlFor="repository">저장소</label>
              <select id="repository" name="repository" required>
                <option value="">설치된 저장소 선택</option>
                {repos
                  .filter((r) => r.enabled)
                  .map((repo) => (
                    <option key={repo.id}>{repo.fullName}</option>
                  ))}
              </select>
              <label htmlFor="instruction">개발 요청</label>
              <textarea
                id="instruction"
                name="instruction"
                rows={4}
                required
                maxLength={20000}
                placeholder="무엇을 구현하거나 수정할까요?"
              />
              <label htmlFor="timeout">CLI 실행 제한 (초)</label>
              <input
                id="timeout"
                name="timeoutSeconds"
                type="number"
                min={10}
                max={3600}
                defaultValue={600}
                required
              />
              <button disabled={!repos.length}>작업 생성 →</button>
            </form>
          </section>
          <section id="workers">
            <div className="section-title">
              <h2>Worker fleet</h2>
              <span>{workers.length} registered</span>
            </div>
            {workers.map((worker) => (
              <div className="worker" key={worker.id}>
                <div>
                  <b>{worker.name}</b>
                  <small>{worker.engines.join(' · ') || 'Connectivity probe'}</small>
                </div>
                <span className="status">
                  {worker.draining
                    ? 'DRAINING'
                    : Date.now() - new Date(worker.heartbeatAt).getTime() < 60000
                      ? 'ONLINE'
                      : 'OFFLINE'}
                </span>
              </div>
            ))}
            {!workers.length && (
              <div className="empty">등록된 워커가 없거나 조회 권한이 없습니다.</div>
            )}
          </section>
        </div>
        <section id="repositories">
          <div className="section-title">
            <h2>Repositories</h2>
            <span>{repos.length} repositories</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>REPOSITORY</th>
                  <th>BASE BRANCH</th>
                  <th>STATUS</th>
                  <th>VERIFICATION</th>
                </tr>
              </thead>
              <tbody>
                {repos.map((repo) => (
                  <tr key={repo.id}>
                    <td>{repo.fullName}</td>
                    <td>{repo.baseBranch}</td>
                    <td>{repo.enabled ? 'ENABLED' : 'DISABLED'}</td>
                    <td>{repo.verifiedAt ? 'GitHub verified' : 'Pending verification'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <SetupGuide />
        <footer>
          Discord AI PR Hub · Asia/Seoul · KST · GitHub 정책과 사람의 승인을 존중합니다.
        </footer>
      </main>
    </div>
  );
}
