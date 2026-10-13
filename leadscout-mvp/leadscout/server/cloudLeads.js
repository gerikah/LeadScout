import express from 'express';

const VALID_STATUSES = new Set(['New', 'To Contact', 'Contacted', 'Follow-up', 'Interested', 'Not Interested', 'Closed']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IMPORT_RECORDS = 20;
const MAX_AUDIT_HISTORY_BYTES = 48 * 1024;

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch((error) => {
    console.error('Cloud lead API request failed:', error);
    if (res.headersSent) return next(error);
    res.set('Retry-After', '3');
    return res.status(503).json({ error: 'Cloud storage is temporarily unavailable. Please retry.' });
  });
}

function stringField(value, maxLength = 2_000) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function validateLead(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourceId = value.id;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const bounds = {
    category: 500,
    address: 2_000,
    location: 2_000,
    website: 2_048,
    phone: 500,
    email: 500,
    source: 2_048,
    notes: 10_000,
  };
  if (!/^(?:node|way|relation)\/\d+$/.test(sourceId) || !name || name.length > 500) return null;
  if (Object.entries(bounds).some(([field, limit]) =>
    value[field] !== undefined && (typeof value[field] !== 'string' || value[field].length > limit),
  )) return null;
  if (value.status !== undefined && !VALID_STATUSES.has(value.status)) return null;
  if (value.savedAt && !Number.isFinite(Date.parse(value.savedAt))) return null;

  const source = stringField(value.source, bounds.source);
  let sourceUrl;
  try {
    sourceUrl = new URL(source);
  } catch {
    return null;
  }
  if (
    !sourceUrl ||
    sourceUrl.protocol !== 'https:' ||
    sourceUrl.hostname !== 'www.openstreetmap.org' ||
    sourceUrl.username ||
    sourceUrl.password ||
    sourceUrl.port ||
    sourceUrl.search ||
    sourceUrl.hash ||
    sourceUrl.pathname.replace(/\/$/, '') !== `/${sourceId}`
  ) return null;

  const website = stringField(value.website, bounds.website);
  if (website) {
    try {
      const websiteUrl = new URL(website);
      if (!['http:', 'https:'].includes(websiteUrl.protocol) || websiteUrl.username || websiteUrl.password) return null;
    } catch {
      return null;
    }
  }
  const latitude = Number.isFinite(value.lat) && Math.abs(value.lat) <= 90 ? value.lat : null;
  const longitude = Number.isFinite(value.lon) && Math.abs(value.lon) <= 180 ? value.lon : null;
  if ((value.lat != null && latitude === null) || (value.lon != null && longitude === null)) return null;
  if (value.auditHistory != null && (!Array.isArray(value.auditHistory) || value.auditHistory.length > 100)) return null;
  if (value.websiteAudit != null && !validAudit(value.websiteAudit)) return null;
  const audits = [...(value.auditHistory || []), ...(value.websiteAudit ? [value.websiteAudit] : [])];
  if (audits.some((audit) => !validAudit(audit))) return null;
  const uniqueAudits = [...new Map(audits.map((audit) => [new Date(audit.checkedAt).toISOString(), audit])).values()];
  if (uniqueAudits.length > 100 || Buffer.byteLength(JSON.stringify(uniqueAudits)) > MAX_AUDIT_HISTORY_BYTES) return null;

  return {
    source_id: sourceId,
    name,
    category: stringField(value.category, 500),
    address: stringField(value.address),
    location: stringField(value.location),
    website,
    phone: stringField(value.phone, 500),
    email: stringField(value.email, 500),
    latitude,
    longitude,
    source_url: source,
    status: value.status || 'New',
    notes: stringField(value.notes, 10_000),
    saved_at: value.savedAt && Number.isFinite(Date.parse(value.savedAt))
      ? new Date(value.savedAt).toISOString()
      : new Date().toISOString(),
    auditHistory: uniqueAudits,
  };
}

function shapeLead(row) {
  const history = (row.website_audits || [])
    .map(({ audit_data: audit }) => audit)
    .filter((audit) => audit && typeof audit === 'object')
    .sort((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt));

  return {
    id: row.source_id,
    cloudId: row.id,
    name: row.name,
    category: row.category,
    address: row.address,
    location: row.location,
    website: row.website,
    phone: row.phone,
    email: row.email,
    lat: row.latitude,
    lon: row.longitude,
    source: row.source_url,
    status: row.status,
    notes: row.notes,
    savedAt: row.saved_at,
    websiteAudit: history[0] || null,
    auditHistory: history,
  };
}

function validAudit(audit) {
  return audit &&
    typeof audit === 'object' &&
    !Array.isArray(audit) &&
    ['completed', 'inconclusive'].includes(audit.status) &&
    typeof audit.checkedAt === 'string' &&
    Number.isFinite(Date.parse(audit.checkedAt)) &&
    ['available', 'unavailable', 'unknown'].includes(audit.availability) &&
    Array.isArray(audit.findings) &&
    audit.findings.length <= 100 &&
    Buffer.byteLength(JSON.stringify(audit)) <= 48 * 1024;
}

async function insertAudit(client, userId, leadId, audit) {
  if (!validAudit(audit)) return { error: new Error('Audit history record is malformed.') };
  return client.from('website_audits').insert({
    user_id: userId,
    lead_id: leadId,
    audit_data: audit,
    checked_at: new Date(audit.checkedAt).toISOString(),
  });
}

async function insertAuditHistory(client, userId, leadId, audits, report, index) {
  if (!audits.length) return;
  const rows = audits.map((audit) => ({
    user_id: userId,
    lead_id: leadId,
    audit_data: audit,
    checked_at: new Date(audit.checkedAt).toISOString(),
  }));
  const { error } = await client.from('website_audits').upsert(rows, {
    onConflict: 'lead_id,checked_at',
    ignoreDuplicates: true,
  });
  if (error) {
    report.auditFailures += 1;
    report.errors.push({ index, message: 'The lead was saved, but some website audit history could not be imported.' });
    console.error('Website audit history import failed:', error);
  }
}

export function createCloudLeadsRouter(requireUser) {
  const router = express.Router();
  router.use(requireUser);

  router.get('/', asyncRoute(async (req, res) => {
    const { data, error } = await req.supabaseClient
      .from('leads')
      .select('id, source_id, name, category, address, location, website, phone, email, latitude, longitude, source_url, status, notes, saved_at, website_audits(audit_data)')
      .order('saved_at', { ascending: false });
    if (error) {
      console.error('Cloud lead fetch failed:', error);
      return res.status(503).json({ error: 'Saved leads could not be loaded. Please retry.' });
    }
    return res.json({ leads: data.map(shapeLead) });
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const items = Array.isArray(req.body?.leads) ? req.body.leads : [req.body?.lead];
    if (!items.length || items.length > MAX_IMPORT_RECORDS) {
      return res.status(400).json({ error: `Import between 1 and ${MAX_IMPORT_RECORDS} records at a time.` });
    }

    const report = { imported: 0, skipped: 0, failed: 0, auditFailures: 0, errors: [] };
    const importedLeads = [];
    for (const [index, input] of items.entries()) {
      const lead = validateLead(input);
      if (!lead) {
        report.failed += 1;
        report.errors.push({ index, message: 'This local record is incomplete or has an unsupported source identifier.' });
        continue;
      }

      const { auditHistory, ...record } = lead;
      const { data, error } = await req.supabaseClient
        .from('leads')
        .insert({ ...record, user_id: req.supabaseUser.id })
        .select('id, source_id, name, category, address, location, website, phone, email, latitude, longitude, source_url, status, notes, saved_at')
        .single();
      if (error?.code === '23505') {
        report.skipped += 1;
        if (auditHistory.length) {
          const { data: existing, error: existingError } = await req.supabaseClient
            .from('leads')
            .select('id')
            .eq('user_id', req.supabaseUser.id)
            .eq('source_id', record.source_id)
            .single();
          if (!existingError && existing) {
            await insertAuditHistory(req.supabaseClient, req.supabaseUser.id, existing.id, auditHistory, report, index);
          }
        }
        continue;
      }
      if (error) {
        report.failed += 1;
        report.errors.push({ index, message: 'The lead could not be saved to your account.' });
        console.error('Cloud lead insert failed:', error);
        continue;
      }

      if (auditHistory.length) {
        await insertAuditHistory(req.supabaseClient, req.supabaseUser.id, data.id, auditHistory, report, index);
      }
      report.imported += 1;
      importedLeads.push(shapeLead({ ...data, website_audits: auditHistory.map((audit) => ({ audit_data: audit })) }));
    }

    if (!Array.isArray(req.body?.leads) && report.imported === 0 && report.failed > 0) {
      return res.status(400).json(report);
    }
    return res.status(200).json({ ...report, leads: importedLeads });
  }));

  router.patch('/:leadId', asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.leadId)) return res.status(400).json({ error: 'A valid saved-lead identifier is required.' });
    const changes = {};
    if (req.body?.status !== undefined) {
      if (!VALID_STATUSES.has(req.body.status)) return res.status(400).json({ error: 'Choose a valid outreach status.' });
      changes.status = req.body.status;
    }
    if (req.body?.notes !== undefined) {
      if (typeof req.body.notes !== 'string' || req.body.notes.length > 10_000) {
        return res.status(400).json({ error: 'Notes must be text up to 10,000 characters.' });
      }
      changes.notes = req.body.notes;
    }
    if (!Object.keys(changes).length) return res.status(400).json({ error: 'Provide notes or an outreach status to update.' });
    changes.updated_at = new Date().toISOString();
    const { data, error } = await req.supabaseClient
      .from('leads')
      .update(changes)
      .eq('id', req.params.leadId)
      .select('id, source_id, status, notes')
      .maybeSingle();
    if (error) {
      console.error('Cloud lead update failed:', error);
      return res.status(503).json({ error: 'Lead changes could not be saved. Please retry.' });
    }
    if (!data) return res.status(404).json({ error: 'Saved lead was not found.' });
    return res.json(data);
  }));

  router.post('/:leadId/audits', asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.leadId)) return res.status(400).json({ error: 'A valid saved-lead identifier is required.' });
    if (!validAudit(req.body?.audit)) return res.status(400).json({ error: 'A completed or inconclusive website audit is required.' });
    const { data: lead, error: leadError } = await req.supabaseClient
      .from('leads')
      .select('id')
      .eq('id', req.params.leadId)
      .maybeSingle();
    if (leadError) {
      console.error('Cloud lead authorization check failed:', leadError);
      return res.status(503).json({ error: 'Audit history could not be saved. Please retry.' });
    }
    if (!lead) return res.status(404).json({ error: 'Saved lead was not found.' });
    const { error } = await insertAudit(req.supabaseClient, req.supabaseUser.id, lead.id, req.body.audit);
    if (error) {
      console.error('Cloud website audit insert failed:', error);
      return res.status(503).json({ error: 'Audit history could not be saved. Please retry.' });
    }
    return res.status(201).json({ saved: true });
  }));

  router.delete('/:leadId', asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.leadId)) return res.status(400).json({ error: 'A valid saved-lead identifier is required.' });
    const { data, error } = await req.supabaseClient
      .from('leads')
      .delete()
      .eq('id', req.params.leadId)
      .select('id')
      .maybeSingle();
    if (error) {
      console.error('Cloud lead delete failed:', error);
      return res.status(503).json({ error: 'Saved lead could not be removed. Please retry.' });
    }
    if (!data) return res.status(404).json({ error: 'Saved lead was not found.' });
    return res.json({ deleted: true });
  }));

  return router;
}

export { shapeLead, validAudit };
