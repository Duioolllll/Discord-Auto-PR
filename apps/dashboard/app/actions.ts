'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, seal } from '../lib/api';

export async function login(form: FormData) {
  const token = String(form.get('token') ?? '');
  try {
    await api('/me', 'GET', undefined, token);
    (await cookies()).set('hub_session', seal(token), {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 3600,
    });
  } catch {
    redirect('/?error=AUTH_FAILED');
  }
  redirect('/');
}
export async function logout() {
  (await cookies()).delete('hub_session');
  redirect('/');
}
export async function configureBudget(form: FormData) {
  const repositoryId = String(form.get('repositoryId'));
  if (!/^[a-f0-9-]{36}$/.test(repositoryId)) throw new Error('INVALID_REPOSITORY');
  try {
    await api(`/repositories/${repositoryId}/budget`, 'POST', {
      limitCents: Number(form.get('limitCents')),
    });
  } catch (error) {
    redirect(
      `/?error=${encodeURIComponent(error instanceof Error ? error.message : 'REQUEST_FAILED')}`,
    );
  }
  revalidatePath('/');
  redirect('/#repositories');
}
export async function createJob(form: FormData) {
  let job: { job: { id: string } };
  try {
    job = await api('/jobs', 'POST', {
      externalRequestId: String(form.get('requestId')),
      repository: String(form.get('repository')),
      instruction: String(form.get('instruction')),
      engine: 'codex',
      kind: 'develop',
      maxCostCents: Number(form.get('maxCostCents')),
    });
  } catch (error) {
    redirect(
      `/?error=${encodeURIComponent(error instanceof Error ? error.message : 'REQUEST_FAILED')}`,
    );
  }
  redirect(`/jobs/${job.job.id}`);
}
export async function jobAction(form: FormData) {
  const id = String(form.get('jobId'));
  const action = String(form.get('action'));
  if (!/^[a-f0-9-]{36}$/.test(id) || !['cancel', 'approve', 'merge'].includes(action))
    throw new Error('INVALID_ACTION');
  try {
    await api(`/jobs/${id}/${action}`, 'POST', {});
  } catch (error) {
    redirect(
      `/jobs/${id}?error=${encodeURIComponent(error instanceof Error ? error.message : 'REQUEST_FAILED')}`,
    );
  }
  revalidatePath(`/jobs/${id}`);
  redirect(`/jobs/${id}`);
}
