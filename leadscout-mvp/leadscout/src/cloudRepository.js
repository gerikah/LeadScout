async function cloudRequest(session, path, { method = 'GET', body } = {}) {
  if (!session?.access_token) throw new Error('Your sign-in session has expired. Sign in again to sync saved leads.');
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error('Cloud sync is temporarily unavailable. Your browser-local leads are still preserved.');
  }
  const result = await response.json().catch(() => null);
  if (response.status === 401) {
    throw new Error('Your sign-in session has expired. Sign in again to sync saved leads.');
  }
  if (!response.ok) throw new Error(result?.error || `Cloud sync failed (${response.status}).`);
  return result;
}

export function loadCloudLeads(session) {
  return cloudRequest(session, '/api/leads');
}

export function saveCloudLead(session, lead) {
  return cloudRequest(session, '/api/leads', { method: 'POST', body: { lead } });
}

export function importCloudLeads(session, leads) {
  return cloudRequest(session, '/api/leads', { method: 'POST', body: { leads } });
}

export function updateCloudLead(session, cloudId, changes) {
  return cloudRequest(session, `/api/leads/${encodeURIComponent(cloudId)}`, { method: 'PATCH', body: changes });
}

export function deleteCloudLead(session, cloudId) {
  return cloudRequest(session, `/api/leads/${encodeURIComponent(cloudId)}`, { method: 'DELETE' });
}

export function saveCloudAudit(session, cloudId, audit) {
  return cloudRequest(session, `/api/leads/${encodeURIComponent(cloudId)}/audits`, {
    method: 'POST',
    body: { audit },
  });
}

