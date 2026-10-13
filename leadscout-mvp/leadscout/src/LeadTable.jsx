import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Bookmark,
  BookmarkCheck,
  Check,
  ExternalLink,
  Globe,
  LoaderCircle,
  Mail,
  MapPin,
  RotateCw,
  Phone,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { LEAD_STATUSES } from './leadData.js';

function NotesEditor({ lead, disabled, onSave }) {
  const [draft, setDraft] = useState(lead.notes || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(lead.notes || ''), [lead.notes]);

  async function saveNotes() {
    setSaving(true);
    try {
      await onSave(lead, draft);
    } finally {
      setSaving(false);
    }
  }

  const changed = draft !== (lead.notes || '');
  return (
    <div className="notes-editor">
      <textarea
        aria-label={`Notes for ${lead.name || 'legacy saved lead'}`}
        disabled={disabled}
        rows={2}
        value={draft}
        placeholder={disabled ? 'Save this lead to add notes' : 'Add notes…'}
        onChange={(event) => setDraft(event.target.value)}
      />
      {changed && (
        <button className="save-note" disabled={saving || disabled} onClick={saveNotes}>
          <Check size={13} /> {saving ? 'Saving…' : 'Save notes'}
        </button>
      )}
    </div>
  );
}

function WebsiteAudit({ lead, saved, onAudit, onSaveAudit }) {
  const audit = lead.websiteAudit;
  const state = lead.auditState;
  const findings = audit?.findings || [];

  return (
    <div className="website-audit">
      <button
        className="audit-button"
        disabled={state?.loading}
        onClick={() => onAudit(lead)}
      >
        {state?.loading ? <LoaderCircle className="spin" size={14} /> : audit ? <RotateCw size={14} /> : <ShieldCheck size={14} />}
        {state?.loading ? 'Checking…' : audit ? 'Re-run audit' : 'Audit website'}
      </button>
      {state?.error && <small className="audit-error" role="alert">{state.error}</small>}
      {audit && (
        <details className="audit-details">
          <summary>
            {audit.status === 'inconclusive' ? 'Inconclusive audit' : `${audit.availability} · HTTP ${audit.httpStatus ?? 'unknown'}`}
          </summary>
          <div className="audit-report">
            <small>Last checked: {new Date(audit.checkedAt).toLocaleString()}</small>
            <small>HTTPS: {audit.https?.status || 'unknown'}{audit.https?.httpStatus ? ` · HTTP ${audit.https.httpStatus}` : ''}</small>
            {audit.latencyMs !== null && <small>Response time: {audit.latencyMs} ms</small>}
            {audit.finalUrl && <small className="audit-url">Final URL: {audit.finalUrl}</small>}
            {audit.redirects?.length > 0 && (
              <small>Redirects: {audit.redirects.map((redirect) => `${redirect.status} → ${redirect.to}`).join(' · ')}</small>
            )}
            {audit.message && <small>{audit.message}</small>}
            {audit.metadata && (
              <>
                <small>Title: {audit.metadata.title || 'Missing'}</small>
                <small>Description: {audit.metadata.description || 'Missing'}</small>
                <small>Viewport: {audit.metadata.viewport ? 'Present' : 'Missing'}</small>
                <small>Canonical: {audit.metadata.canonical || 'Not listed'}</small>
                <small>Open Graph: title {audit.metadata.openGraph?.title ? 'present' : 'missing'}; description {audit.metadata.openGraph?.description ? 'present' : 'missing'}; image {audit.metadata.openGraph?.image ? 'present' : 'missing'}</small>
                <small>Headings: H1 {audit.metadata.headings.h1}, H2 {audit.metadata.headings.h2}, H3 {audit.metadata.headings.h3}</small>
                <small>Image alt text: {audit.metadata.imageAlt.withAlt}/{audit.metadata.imageAlt.total}{audit.metadata.imageAlt.coveragePercent === null ? '' : ` (${audit.metadata.imageAlt.coveragePercent}%)`}{audit.metadata.sampled ? ' in sampled HTML' : ''}</small>
                <small>Mobile signals: viewport {audit.mobile?.viewport ? 'present' : 'missing'}; {audit.mobile?.responsiveIndicators.length || 0} embedded responsive indicators; {audit.mobile?.fixedWidthIndicators.length || 0} fixed-width indicators. Not a usability test.</small>
                {audit.mobile?.responsiveIndicators.map((indicator) => <small key={indicator.signal}>Responsive indicator: {indicator.evidence}</small>)}
                {audit.mobile?.fixedWidthIndicators.map((indicator) => <small key={indicator}>Fixed-width indicator: {indicator}</small>)}
              </>
            )}
            {findings.length > 0 ? (
              <ul>
                {findings.map((finding, index) => (
                  <li key={`${finding.code}-${index}`}>
                    <b>{finding.title}</b>: {finding.evidence}
                    {finding.confidence === 'indicator' && <em> · indicator only</em>}
                  </li>
                ))}
              </ul>
            ) : audit.status === 'completed' ? (
              <small>No measurable improvement findings from this check.</small>
            ) : null}
            {audit.mobile?.scope && <small>{audit.mobile.scope}</small>}
            {!saved && (
              <button className="save-audit" onClick={() => onSaveAudit(lead, audit)}>
                Save lead and audit results
              </button>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

export function LeadTable({
  leads,
  savedIds,
  selectedIds,
  onToggleSelected,
  onToggleAll,
  onSave,
  onStatusChange,
  onNotesSave,
  onAudit,
  onSaveAudit,
  onRemove,
}) {
  const allSelected = leads.length > 0 && leads.every((lead) => selectedIds.has(lead.id));

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="select-column">
              <input
                aria-label={allSelected ? 'Deselect all visible leads' : 'Select all visible leads'}
                checked={allSelected}
                onChange={() => onToggleAll(leads, allSelected)}
                type="checkbox"
              />
            </th>
            <th>BUSINESS</th>
            <th>CONTACT</th>
            <th>WEBSITE</th>
            <th>OPPORTUNITY SCORE</th>
            <th>NOTES</th>
            <th>OUTREACH</th>
            <th>SAVED</th>
            <th>ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => {
            const saved = savedIds.has(lead.id);
            return (
              <tr key={lead.id}>
                <td className="select-column">
                  <input
                    aria-label={`Select ${lead.name || 'legacy saved lead'}`}
                    checked={selectedIds.has(lead.id)}
                    onChange={() => onToggleSelected(lead.id)}
                    type="checkbox"
                  />
                </td>
                <td>
                  <div className="business">
                    <div className="business-avatar">{lead.name ? lead.name.slice(0, 1).toUpperCase() : '?'}</div>
                    <div>
                      {lead.legacy ? (
                        <strong>Business details unavailable</strong>
                      ) : (
                        <strong>{lead.name}</strong>
                      )}
                      <small>
                        {lead.legacy
                          ? `Legacy bookmark · ${lead.id}`
                          : `${lead.category || 'Business'}${lead.address ? ` · ${lead.address}` : ''}`}
                      </small>
                      {lead.location && <small className="lead-location"><MapPin size={11} /> {lead.location}</small>}
                      {lead.legacy ? (
                        <small className="legacy-notice">Search for this source record to restore its details.</small>
                      ) : (
                        <a href={lead.source} rel="noopener noreferrer" target="_blank">
                          OSM source <ArrowUpRight size={12} />
                        </a>
                      )}
                    </div>
                  </div>
                </td>
                <td>
                  {lead.legacy ? (
                    <span className="muted">Not available</span>
                  ) : (
                    <div className="contacts">
                      {lead.phone ? <a href={`tel:${lead.phone}`}><Phone size={13} /> {lead.phone}</a> : <span className="muted"><Phone size={13} /> Not listed</span>}
                      {lead.email ? <a href={`mailto:${lead.email}`}><Mail size={13} /> {lead.email}</a> : <span className="muted"><Mail size={13} /> Not listed</span>}
                      <small className="verification">{lead.contactVerification}</small>
                    </div>
                  )}
                </td>
                <td>
                  <div className="website-cell">
                    {lead.website ? (
                      <>
                        <a className="website-link" href={lead.website} rel="noopener noreferrer" target="_blank">
                          <Globe size={14} /> Visit <ExternalLink size={11} />
                        </a>
                        <WebsiteAudit
                          lead={lead}
                          saved={saved}
                          onAudit={onAudit}
                          onSaveAudit={onSaveAudit}
                        />
                      </>
                    ) : (
                      <span className="no-website"><Globe size={14} /> {lead.legacy ? 'Unknown' : 'Not listed'}</span>
                    )}
                  </div>
                </td>
                <td>
                  {lead.score === null || lead.score === undefined ? (
                    <span className="muted">Unavailable</span>
                  ) : (
                    <>
                      <div className="score">
                        <span className={`score-dot ${lead.score >= 65 ? 'hot' : ''}`} />
                        <strong>{lead.score}</strong><small>/ 100</small>
                      </div>
                      <small className="score-categories">Listing {lead.listingScore} · Website {lead.websiteScore}</small>
                      <small className="score-categories">Combined score is capped at 100.</small>
                      <details className="score-breakdown">
                        <summary>Why this score?</summary>
                        {lead.scoreFactors.length
                          ? <ul>{lead.scoreFactors.map((factor) => <li key={factor.label}><span>{factor.group === 'website' ? 'Website' : 'Listing'}: {factor.label}</span> <b>+{factor.points}</b></li>)}</ul>
                          : <span>No opportunity factors found.</span>}
                      </details>
                      <small className="score-note">{lead.opportunity}</small>
                    </>
                  )}
                </td>
                <td><NotesEditor disabled={!saved} lead={lead} onSave={onNotesSave} /></td>
                <td>
                  <select
                    aria-label={`Outreach status for ${lead.name || 'legacy saved lead'}`}
                    className="status-select"
                    disabled={!saved}
                    onChange={(event) => onStatusChange(lead, event.target.value)}
                    value={lead.status || 'New'}
                  >
                    {LEAD_STATUSES.map((status) => <option key={status}>{status}</option>)}
                  </select>
                </td>
                <td>{lead.savedAt ? new Date(lead.savedAt).toLocaleDateString() : <span className="muted">Unknown</span>}</td>
                <td>
                  {saved ? (
                    <button
                      aria-label={`Remove ${lead.name || 'legacy saved lead'}`}
                      className="bookmark-btn remove-lead"
                      onClick={() => onRemove(lead)}
                      title="Remove saved lead"
                    >
                      <Trash2 size={17} />
                    </button>
                  ) : (
                    <button
                      aria-label={`Save ${lead.name}`}
                      className="bookmark-btn"
                      onClick={() => onSave(lead)}
                      title="Save lead"
                    >
                      {saved ? <BookmarkCheck size={18} /> : <Bookmark size={18} />}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
