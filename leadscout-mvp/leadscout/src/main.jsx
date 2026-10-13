import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  Bookmark,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  Globe,
  LayoutDashboard,
  MapPin,
  Menu,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Star,
  Target,
  X,
} from 'lucide-react';
import { LeadTable } from './LeadTable.jsx';
import { enrichLead, exportLeadsToCsv, filterAndSortLeads } from './leadData.js';
import { createLeadRepository } from './leadRepository.js';
import { cloudConfigured, supabase } from './supabaseClient.js';
import {
  deleteCloudLead,
  importCloudLeads,
  loadCloudLeads,
  saveCloudAudit,
  saveCloudLead,
  updateCloudLead,
} from './cloudRepository.js';
import './styles.css';

const NICHES = [
  ['cafe', 'Cafés'],
  ['restaurant', 'Restaurants'],
  ['salon', 'Beauty salons'],
  ['gym', 'Gyms & fitness'],
  ['dental', 'Dental clinics'],
  ['hotel', 'Hotels'],
  ['retail', 'Retail shops'],
  ['bakery', 'Bakeries'],
  ['realestate', 'Real estate'],
];

const EMPTY_FILTERS = {
  search: '',
  category: '',
  location: '',
  website: 'all',
  contact: 'all',
  minimumScore: '',
  maximumScore: '',
  status: 'all',
  auditStatus: 'all',
  savedAfter: '',
  savedBefore: '',
  sort: 'score-desc',
};

function downloadCsv(leads, filename) {
  if (!leads.length) return false;
  const blob = new Blob([exportLeadsToCsv(leads)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return true;
}

function App() {
  const [repository] = useState(() => {
    try {
      return createLeadRepository(window.localStorage);
    } catch {
      return null;
    }
  });
  const [niche, setNiche] = useState('cafe');
  const [location, setLocation] = useState('Makati, Metro Manila, Philippines');
  const [radius, setRadius] = useState('5000');
  const [limit, setLimit] = useState('100');
  const [loading, setLoading] = useState(false);
  const [storageLoading, setStorageLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const [stored, setStored] = useState({ version: 2, leads: [], legacy: {} });
  const [onlySaved, setOnlySaved] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [auditResults, setAuditResults] = useState({});
  const [sidebar, setSidebar] = useState(false);
  const [session, setSession] = useState(null);
  const [cloudLeads, setCloudLeads] = useState([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authMode, setAuthMode] = useState('signin');
  const [authBusy, setAuthBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importReport, setImportReport] = useState(null);

  useEffect(() => {
    if (!repository) {
      setError('Browser storage is unavailable. Saved leads cannot be loaded or changed.');
      setStorageLoading(false);
      return;
    }
    try {
      setStored(repository.load());
    } catch (storageError) {
      setError(storageError.message);
    } finally {
      setStorageLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (active) setSession(nextSession);
    });
    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError) setError(`Authentication session could not be restored: ${sessionError.message}`);
      setSession(data.session);
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) {
      setCloudLeads([]);
      setCloudLoading(false);
      return undefined;
    }
    let active = true;
    setCloudLoading(true);
    loadCloudLeads(session).then((result) => {
      if (active) setCloudLeads(result.leads || []);
    }).catch((cloudError) => {
      if (active) setError(cloudError.message);
    }).finally(() => {
      if (active) setCloudLoading(false);
    });
    return () => { active = false; };
  }, [session?.access_token]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(''), 3_500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const localLeads = useMemo(() => [
    ...stored.leads.map(enrichLead),
    ...Object.values(stored.legacy).map((legacy) => enrichLead({ ...legacy, legacy: true })),
  ], [stored]);
  const savedLeads = useMemo(
    () => (session ? cloudLeads.map(enrichLead) : localLeads),
    [session, cloudLeads, localLeads],
  );
  const savedIds = useMemo(() => new Set(savedLeads.map((lead) => lead.id)), [savedLeads]);
  const searchLeads = useMemo(
    () => (data?.leads || []).map((lead) => {
      const saved = (session ? cloudLeads : stored.leads).find((record) => record.id === lead.id);
      const legacy = session ? null : stored.legacy[lead.id];
      return enrichLead({
        ...(saved || {}),
        ...lead,
        location: saved?.location || data.location,
        status: saved?.status || legacy?.status || 'New',
        notes: saved?.notes || legacy?.notes || '',
        savedAt: saved ? saved.savedAt : legacy?.savedAt || null,
        cloudId: saved?.cloudId,
        websiteAudit: saved?.websiteAudit || null,
        auditHistory: saved?.auditHistory || [],
      });
    }),
    [data, stored, session, cloudLeads],
  );
  const sourceLeads = (onlySaved ? savedLeads : searchLeads).map((lead) => enrichLead({
    ...lead,
    websiteAudit: auditResults[lead.id]?.result || lead.websiteAudit,
    auditState: auditResults[lead.id],
  }));
  const filteredLeads = useMemo(() => {
    let results = filterAndSortLeads(sourceLeads, filters);
    if (!onlySaved) {
      if (filter === 'no-website') results = results.filter((lead) => !lead.website);
      if (filter === 'has-contact') results = results.filter((lead) => lead.email || lead.phone);
      if (filter === 'high') results = results.filter((lead) => lead.score >= 65);
    }
    return results;
  }, [sourceLeads, filters, filter, onlySaved]);
  const shownLeads = filteredLeads.slice(page * 10, (page + 1) * 10);
  const pageCount = Math.max(1, Math.ceil(filteredLeads.length / 10));
  const categories = [...new Set(sourceLeads.map((lead) => lead.category).filter(Boolean))].sort();
  const selectedLeads = filteredLeads.filter((lead) => selectedIds.has(lead.id));
  const legacyCount = session ? 0 : Object.keys(stored.legacy).length;

  useEffect(() => {
    if (page >= pageCount) setPage(Math.max(0, pageCount - 1));
  }, [page, pageCount]);

  function updateStored(next) {
    if (!next) return false;
    setStored(next);
    setError('');
    return true;
  }

  async function search(event) {
    event?.preventDefault();
    setLoading(true);
    setError('');
    setPage(0);
    setSelectedIds(new Set());
    setOnlySaved(false);
    try {
      const parameters = new URLSearchParams({ niche, location, limit, radius });
      const response = await fetch(`/api/search?${parameters}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || `Business search failed (${response.status}).`);
      if (!Array.isArray(result?.leads)) throw new Error('Business data provider returned an invalid response.');
      setData(result);
      if (repository) {
        try {
          updateStored(repository.restoreLegacy(result.leads.map((lead) => ({
            ...lead,
            location: result.location,
          }))));
        } catch (storageError) {
          setError(storageError.message);
        }
      }
      setToast(`${result.leads.length} businesses found. Save prospects to keep them.`);
    } catch (searchError) {
      setError(searchError.message || 'Search failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function saveLead(lead) {
    if (session) {
      try {
        const response = await saveCloudLead(session, {
          ...lead,
          location: lead.location || data?.location || '',
        });
        await refreshCloudLeads();
        setToast(response.imported ? `Lead saved to your cloud account.` : 'This business is already in your cloud leads.');
      } catch (saveError) {
        setError(saveError.message);
      }
      return;
    }
    if (!repository) {
      setError('Browser storage is unavailable. This lead could not be saved.');
      return;
    }
    try {
      const nextLead = repository.save({
        ...lead,
        location: lead.location || data?.location || '',
      });
      updateStored(repository.load());
      setToast(savedIds.has(nextLead.id) ? 'Saved lead updated with source listing details.' : 'Lead saved with full business details.');
    } catch (storageError) {
      setError(storageError.message);
    }
  }

  async function changeLead(lead, changes) {
    if (session) {
      try {
        await updateCloudLead(session, lead.cloudId, changes);
        await refreshCloudLeads();
        if (changes.notes !== undefined) setToast('Notes synced.');
      } catch (updateError) {
        setError(updateError.message);
      }
      return;
    }
    if (!repository) {
      setError('Browser storage is unavailable. Your changes were not saved.');
      return;
    }
    try {
      updateStored(repository.update(lead.id, changes));
      if (changes.notes !== undefined) setToast('Notes saved.');
    } catch (storageError) {
      setError(storageError.message);
    }
  }

  async function auditWebsite(lead) {
    setAuditResults((current) => ({
      ...current,
      [lead.id]: { loading: true, error: '', result: current[lead.id]?.result || lead.websiteAudit || null },
    }));
    try {
      const response = await fetch('/api/audit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ url: lead.website }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || `Website audit failed (${response.status}).`);
      if (!result || !['completed', 'inconclusive'].includes(result.status)) {
        throw new Error('Website audit returned an invalid response.');
      }

      setAuditResults((current) => ({ ...current, [lead.id]: { result, loading: false, error: '' } }));
      if (savedIds.has(lead.id)) {
        if (session) {
          await saveCloudAudit(session, lead.cloudId, result);
          await refreshCloudLeads();
        } else {
          await changeLead(lead, { websiteAudit: result });
        }
      }
      setToast(result.status === 'inconclusive'
        ? `Audit of ${lead.name} was inconclusive; no unknown signals were scored.`
        : `Website audit completed for ${lead.name}.`);
    } catch (auditError) {
      setAuditResults((current) => ({
        ...current,
        [lead.id]: { ...current[lead.id], loading: false, error: auditError.message || 'Website audit failed.' },
      }));
    }
  }

  async function saveAudit(lead, websiteAudit) {
    if (session) {
      try {
        await saveCloudLead(session, {
          ...lead,
          websiteAudit,
          location: lead.location || data?.location || '',
        });
        await refreshCloudLeads();
        setToast(`Lead and website audit synced for ${lead.name}.`);
      } catch (saveError) {
        setError(saveError.message);
      }
      return;
    }
    if (!repository) {
      setError('Browser storage is unavailable. The audit result could not be saved.');
      return;
    }
    try {
      repository.save({
        ...lead,
        websiteAudit,
        location: lead.location || data?.location || '',
      });
      updateStored(repository.load());
      setToast(`Lead and website audit saved for ${lead.name}.`);
    } catch (storageError) {
      setError(storageError.message);
    }
  }

  async function refreshCloudLeads() {
    if (!session) return;
    setCloudLoading(true);
    try {
      const result = await loadCloudLeads(session);
      setCloudLeads(result.leads || []);
    } finally {
      setCloudLoading(false);
    }
  }

  async function submitAuth(event) {
    event.preventDefault();
    if (!supabase) return;
    setAuthBusy(true);
    setError('');
    try {
      const result = authMode === 'signup'
        ? await supabase.auth.signUp({ email: authEmail, password: authPassword })
        : await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
      if (result.error) throw result.error;
      if (result.data.session) setSession(result.data.session);
      else if (authMode === 'signup') setToast('Check your email to confirm your account before signing in.');
      setAuthPassword('');
    } catch (authError) {
      setError(authError.message || 'Authentication failed. Please try again.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    if (!supabase) return;
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) setError(`Could not sign out: ${signOutError.message}`);
  }

  async function importLocalLeads() {
    if (!session) return;
    const importable = stored.leads;
    setImportBusy(true);
    setImportReport(null);
    try {
      const totals = { imported: 0, skipped: 0, failed: 0, auditFailures: 0, errors: [] };
      for (let start = 0; start < importable.length; start += 20) {
        const report = await importCloudLeads(session, importable.slice(start, start + 20));
        totals.imported += report.imported;
        totals.skipped += report.skipped;
        totals.failed += report.failed;
        totals.auditFailures += report.auditFailures || 0;
        totals.errors.push(...(report.errors || []).map((item) => ({ ...item, index: item.index + start })));
        setImportReport({ ...totals, errors: [...totals.errors] });
      }
      setImportReport(totals);
      await refreshCloudLeads();
    } catch (importError) {
      setError(importError.message);
    } finally {
      setImportBusy(false);
    }
  }

  async function removeLead(lead) {
    if (session) {
      try {
        await deleteCloudLead(session, lead.cloudId);
        await refreshCloudLeads();
        setToast(`${lead.name} removed from cloud leads.`);
      } catch (removeError) {
        setError(removeError.message);
      }
      return;
    }
    if (!repository) {
      setError('Browser storage is unavailable. This lead could not be removed.');
      return;
    }
    try {
      updateStored(repository.remove(lead.id));
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(lead.id);
        return next;
      });
      setToast(lead.name ? `${lead.name} removed from saved leads.` : 'Legacy bookmark removed.');
    } catch (storageError) {
      setError(storageError.message);
    }
  }

  function toggleSelected(id) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(leads, currentlySelected) {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const lead of leads) {
        if (currentlySelected) next.delete(lead.id);
        else next.add(lead.id);
      }
      return next;
    });
  }

  function exportFiltered() {
    exportRecords(
      filteredLeads,
      onlySaved ? 'leadscout-filtered-saved-leads.csv' : 'leadscout-filtered-search-results.csv',
      'There are no leads in the current results to export.',
    );
  }

  function exportAllSaved() {
    exportRecords(savedLeads, 'leadscout-all-saved-leads.csv', 'There are no saved leads to export.');
  }

  function exportSelected() {
    exportRecords(
      selectedLeads,
      'leadscout-selected-leads.csv',
      'Select one or more leads from the current filtered results to export.',
    );
  }

  function exportRecords(leads, filename, emptyMessage) {
    if (!leads.length) {
      setError(emptyMessage);
      return;
    }
    try {
      downloadCsv(leads, filename);
      setError('');
      setToast(`${leads.length} lead${leads.length === 1 ? '' : 's'} prepared for CSV export.`);
    } catch (exportError) {
      setError(`CSV export failed: ${exportError.message || 'Unable to create the download.'}`);
    }
  }

  function updateFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(0);
  }

  function openView(saved) {
    setOnlySaved(saved);
    setFilter('all');
    setFilters(EMPTY_FILTERS);
    setPage(0);
    setSelectedIds(new Set());
    setSidebar(false);
  }

  return (
    <div className="app">
      <aside className={`sidebar ${sidebar ? 'show' : ''}`}>
        <div className="brand">
          <div className="brand-icon"><Target size={23} /></div>
          <div><strong>leadscout<span>.</span></strong><small>BUSINESS INTELLIGENCE</small></div>
        </div>
        <div className="side-label">WORKSPACE</div>
        <button className={`nav ${!onlySaved ? 'active' : ''}`} onClick={() => openView(false)}>
          <LayoutDashboard size={18} /> Lead explorer
        </button>
        <button className={`nav ${onlySaved ? 'active' : ''}`} onClick={() => openView(true)}>
          <Bookmark size={18} /> Saved leads
          <span className="navcount">{savedLeads.length}</span>
        </button>
        <div className="sidebar-end">
          <div className="info-box">
            <Database size={18} />
            <strong>Open data powered</strong>
            <p>Search OpenStreetMap listings. No subscription or Google Maps API key needed.</p>
          </div>
          <div className="side-footer">LEADSCOUT · OPEN DATA</div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="mobilemenu icon-btn" aria-label="Toggle navigation" onClick={() => setSidebar(!sidebar)}>
            <Menu size={21} />
          </button>
          <div className="breadcrumb">Workspace <span>/</span> <b>{onlySaved ? 'Saved leads' : 'Lead explorer'}</b></div>
          <div className="status"><span className="green-dot" /> Open data search</div>
          {cloudConfigured && (
            <div className="account-controls">
              {session ? (
                <>
                  <span className="account-email">{session.user.email}</span>
                  <span className="sync-state">{cloudLoading ? 'Syncing…' : 'Cloud synced'}</span>
                  {localLeads.length > 0 && <button className="outline" onClick={() => { setImportReport(null); setImportOpen(true); }}>Import local ({stored.leads.length})</button>}
                  <button className="outline" onClick={signOut}>Sign out</button>
                </>
              ) : (
                <form className="auth-form" onSubmit={submitAuth}>
                  <input aria-label="Account email" type="email" autoComplete="email" required placeholder="Email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} />
                  <input aria-label="Account password" type="password" autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} minLength={8} required placeholder="Password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} />
                  <button className="outline" type="submit" disabled={authBusy || storageLoading}>{authBusy ? 'Please wait…' : authMode === 'signup' ? 'Create account' : 'Sign in'}</button>
                  <button className="auth-switch" type="button" onClick={() => setAuthMode(authMode === 'signup' ? 'signin' : 'signup')}>{authMode === 'signup' ? 'Have an account?' : 'Create account'}</button>
                </form>
              )}
            </div>
          )}
        </header>

        <div className="content">
          <div className="heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-dot" /> PROSPECTING WORKSPACE</div>
              <h1>Discover your next <em>client.</em></h1>
              <p>Find local businesses, uncover website opportunities, and build a focused outreach pipeline.</p>
            </div>
            <div className="heading-badge"><Star size={16} /> LEAD GENERATION, SIMPLIFIED</div>
          </div>

          <section className="search-card">
            <div className="section-line">
              <div className="section-name">
                <div className="section-icon"><Search size={19} /></div>
                <div><h2>Find businesses</h2><p>Enter a niche and target location to discover public business listings.</p></div>
              </div>
              <span className="source-pill"><span /> OPENSTREETMAP</span>
            </div>
            <form className="search-form" onSubmit={search}>
              <label className="field">
                <span>BUSINESS NICHE</span>
                <select value={niche} onChange={(event) => setNiche(event.target.value)}>
                  {NICHES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              <label className="field location-field">
                <span>LOCATION</span>
                <div className="input-icon"><MapPin size={17} /><input required minLength={2} maxLength={120} value={location} onChange={(event) => setLocation(event.target.value)} placeholder="City, region, country" /></div>
              </label>
              <label className="field short">
                <span>RADIUS</span>
                <select value={radius} onChange={(event) => setRadius(event.target.value)}>
                  <option value="500">500 m</option><option value="1500">1.5 km</option><option value="3000">3 km</option><option value="5000">5 km</option><option value="10000">10 km</option><option value="15000">15 km</option>
                </select>
              </label>
              <label className="field short">
                <span>MAX LEADS</span>
                <select value={limit} onChange={(event) => setLimit(event.target.value)}>
                  <option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="250">250</option>
                </select>
              </label>
              <button className="primary search-button" disabled={loading} type="submit">
                {loading ? <RefreshCw className="spin" size={18} /> : <Search size={18} />}
                {loading ? 'Searching…' : 'Find leads'}
              </button>
            </form>
            <div className="search-foot">
              <span><CheckCircle2 size={14} /> Public business listings</span>
              <span><CheckCircle2 size={14} /> No API key required</span>
              <span><CheckCircle2 size={14} /> Save prospects to keep them</span>
            </div>
          </section>

          {error && (
            <div className="error" role="alert">
              <AlertTriangle size={18} /><span>{error}</span>
              <button aria-label="Dismiss" onClick={() => setError('')}><X size={17} /></button>
            </div>
          )}
          {toast && <div className="toast" role="status">{toast}</div>}

          <div className="stats">
            <div className="stat"><div className="stat-top"><span>{onlySaved ? 'SAVED LEADS' : 'LEADS FOUND'}</span><Building2 size={19} /></div><strong>{onlySaved ? savedLeads.length : searchLeads.length}</strong><small>{onlySaved ? 'Available across searches' : 'From your latest search'}</small></div>
            <div className="stat"><div className="stat-top"><span>NO LISTED WEBSITE</span><Globe size={19} /></div><strong>{sourceLeads.filter((lead) => !lead.website && !lead.legacy).length}</strong><small>Listing signal, not proof no site exists</small></div>
            <div className="stat"><div className="stat-top"><span>WITH CONTACT INFO</span><MapPin size={18} /></div><strong>{sourceLeads.filter((lead) => lead.phone || lead.email).length}</strong><small>Public phone or email listed</small></div>
            <div className="stat"><div className="stat-top"><span>SAVED LEADS</span><Bookmark size={18} /></div><strong>{savedLeads.length}</strong><small>{cloudConfigured && !session ? 'Stored in this browser · sign in to sync' : session ? 'Synced to your account' : legacyCount ? `${legacyCount} need details restored` : 'Stored in this browser'}</small></div>
          </div>

          <section className="results">
            <div className="result-header">
              <div>
                <div className="result-title"><h2>{onlySaved ? 'Saved prospects' : 'Business leads'}</h2><span>{filteredLeads.length} results</span></div>
                <p>{onlySaved ? session ? 'Your saved leads sync to your account across devices.' : 'Your saved leads are stored independently of your latest search.' : data ? `Results near ${data.location} · ${new Date(data.fetchedAt).toLocaleString()}` : 'Run a search to discover real businesses in your target area.'}</p>
              </div>
              <div className="export-actions">
                <button className="outline" disabled={!filteredLeads.length} onClick={exportFiltered}><Download size={16} /> Export filtered</button>
                <button className="outline" disabled={!savedLeads.length} onClick={exportAllSaved}><Bookmark size={15} /> All saved</button>
                <button className="outline" disabled={!selectedLeads.length} onClick={exportSelected}><CheckCircle2 size={15} /> Selected ({selectedLeads.length})</button>
              </div>
            </div>

            {legacyCount > 0 && onlySaved && (
              <div className="migration-notice">
                <AlertTriangle size={16} />
                <span>{legacyCount} older bookmark{legacyCount === 1 ? '' : 's'} only stored a source ID and status. Search the same area to restore its public details; the original status was preserved.</span>
              </div>
            )}

            <div className="filters">
              <div className="tabs">
                {[
                  ['all', 'All leads'],
                  ['no-website', 'No website listed'],
                  ['has-contact', 'Has contact'],
                  ['high', 'Score 65+'],
                ].map(([id, label]) => (
                  <button key={id} className={filter === id ? 'selected' : ''} onClick={() => { setFilter(id); setPage(0); }}>
                    {label}
                  </button>
                ))}
              </div>
              <label className="table-search"><Search size={16} /><input aria-label="Search leads" placeholder="Search leads..." value={filters.search} onChange={(event) => updateFilter('search', event.target.value)} /></label>
            </div>

            <div className="advanced-filters">
              <div className="advanced-filter-title"><SlidersHorizontal size={16} /><strong>Filter and sort</strong></div>
              <label>Category
                <select value={filters.category} onChange={(event) => updateFilter('category', event.target.value)}>
                  <option value="">All categories</option>{categories.map((category) => <option key={category}>{category}</option>)}
                </select>
              </label>
              <label>City / location<input placeholder="Filter location" value={filters.location} onChange={(event) => updateFilter('location', event.target.value)} /></label>
              <label>Website listing
                <select value={filters.website} onChange={(event) => updateFilter('website', event.target.value)}>
                  <option value="all">All</option><option value="listed">Listed</option><option value="not-listed">Not listed</option>
                </select>
              </label>
              <label>Contact details
                <select value={filters.contact} onChange={(event) => updateFilter('contact', event.target.value)}>
                  <option value="all">All</option><option value="available">Phone or email listed</option><option value="missing">None listed</option>
                </select>
              </label>
              <label>Outreach status
                <select value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}>
                  <option value="all">All statuses</option>{['New', 'To Contact', 'Contacted', 'Follow-up', 'Interested', 'Not Interested', 'Closed'].map((status) => <option key={status}>{status}</option>)}
                </select>
              </label>
              <label>Website audit
                <select value={filters.auditStatus} onChange={(event) => updateFilter('auditStatus', event.target.value)}>
                  <option value="all">All audit states</option><option value="not-audited">Not audited</option><option value="completed">Audit completed</option><option value="inconclusive">Inconclusive</option><option value="available">Website available</option><option value="unavailable">Website unavailable</option>
                </select>
              </label>
              <label>Score from<input aria-label="Minimum score" type="number" min="0" max="100" placeholder="0" value={filters.minimumScore} onChange={(event) => updateFilter('minimumScore', event.target.value)} /></label>
              <label>Score to<input aria-label="Maximum score" type="number" min="0" max="100" placeholder="100" value={filters.maximumScore} onChange={(event) => updateFilter('maximumScore', event.target.value)} /></label>
              <label>Saved after<input aria-label="Saved after date" title="Applies to saved leads with a known save date" type="date" value={filters.savedAfter} onChange={(event) => updateFilter('savedAfter', event.target.value)} /></label>
              <label>Saved before<input aria-label="Saved before date" title="Applies to saved leads with a known save date" type="date" value={filters.savedBefore} onChange={(event) => updateFilter('savedBefore', event.target.value)} /></label>
              <label>Sort by
                <select value={filters.sort} onChange={(event) => updateFilter('sort', event.target.value)}>
                  <option value="score-desc">Highest opportunity score</option><option value="score-asc">Lowest opportunity score</option><option value="verified-opportunities">Most verified website opportunities</option><option value="name">Business name</option><option value="saved-desc">Most recently saved</option>
                </select>
              </label>
              <button className="clear-filters" onClick={() => { setFilters(EMPTY_FILTERS); setFilter('all'); setPage(0); }}>Clear filters</button>
            </div>

            {storageLoading ? (
              <div className="empty" role="status"><RefreshCw className="spin" size={22} /><h3>Loading saved leads…</h3></div>
            ) : shownLeads.length ? (
              <LeadTable
                leads={shownLeads}
                savedIds={savedIds}
                selectedIds={selectedIds}
                onToggleSelected={toggleSelected}
                onToggleAll={toggleAll}
                onSave={saveLead}
                onStatusChange={(lead, status) => changeLead(lead, { status })}
                onNotesSave={(lead, notes) => changeLead(lead, { notes })}
                onAudit={auditWebsite}
                onSaveAudit={saveAudit}
                onRemove={removeLead}
              />
            ) : (
              <div className="empty">
                <div className="empty-icon"><SlidersHorizontal size={25} /></div>
                <h3>{onlySaved ? 'No saved leads match these filters' : data ? 'No matching leads' : 'Your lead list is waiting'}</h3>
                <p>{onlySaved
                  ? 'Try clearing filters, or search and save businesses to build your prospect list.'
                  : data
                    ? 'Try adjusting your filters, search query or location.'
                    : 'Search for a business niche and location to populate your prospect list.'}</p>
                {onlySaved && savedLeads.length > 0 && <button className="outline" onClick={() => { setFilters(EMPTY_FILTERS); setFilter('all'); setPage(0); }}>Clear filters</button>}
              </div>
            )}

            <div className="table-footer">
              <span>Showing {filteredLeads.length ? Math.min(page * 10 + 1, filteredLeads.length) : 0}–{Math.min((page + 1) * 10, filteredLeads.length)} of {filteredLeads.length}</span>
              <div>
                <button aria-label="Previous page" disabled={page === 0} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={17} /></button>
                <span>Page {Math.min(page + 1, pageCount)} of {pageCount}</span>
                <button aria-label="Next page" disabled={page + 1 >= pageCount} onClick={() => setPage((current) => current + 1)}><ChevronRight size={17} /></button>
              </div>
            </div>
          </section>

          <div className="disclaimer">
            <AlertTriangle size={16} />
            <p><b>Data quality &amp; scoring:</b> OpenStreetMap records are community contributed. “No website listed” is a listing gap, not proof a business has no website. Listing completeness is scored separately from verified website findings; unknown or blocked audits do not affect the score. Website checks are bounded automated indicators—not a design review, mobile usability test, or guarantee of business quality. Contact details are not independently verified. Legacy saves retain their status, but missing source details are never invented.</p>
          </div>
          <footer>© 2026 LeadScout · Data © OpenStreetMap contributors · <a href="https://www.openstreetmap.org/copyright" rel="noreferrer" target="_blank">ODbL attribution</a></footer>
        </div>
      </main>
      {importOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
            <div className="section-line">
              <div><h2 id="import-title">Preview local lead import</h2><p>Nothing is removed from this browser. Import is safe to retry; existing cloud leads are skipped.</p></div>
              <button className="icon-btn" aria-label="Close import preview" onClick={() => setImportOpen(false)}><X size={18} /></button>
            </div>
            <div className="import-preview">
              {localLeads.slice(0, 100).map((lead) => (
                <div key={lead.id}>
                  <strong>{lead.name || 'Legacy bookmark'}</strong>
                  <span>{lead.category || 'No category'} · {lead.status || 'New'} · {lead.websiteAudit ? 'Audit history present' : 'No audit history'}</span>
                  {lead.notes && <small>{lead.notes}</small>}
                </div>
              ))}
              {localLeads.length > 100 && <p>Showing the first 100 of {localLeads.length} complete records. Imports run in safe batches.</p>}
              {Object.keys(stored.legacy).length > 0 && <p>{Object.keys(stored.legacy).length} legacy bookmarks contain no complete business details and will remain local, unchanged.</p>}
            </div>
            {importReport && (
              <div className="import-report" role="status">
                <strong>Import finished</strong>
                <span>Imported: {importReport.imported} · Skipped as duplicates: {importReport.skipped} · Failed: {importReport.failed} · Audit records failed: {importReport.auditFailures || 0}</span>
                {importReport.errors?.map((item, index) => <small key={`${item.index}-${index}`}>{item.message}</small>)}
              </div>
            )}
            <div className="import-actions">
              <button className="outline" onClick={() => setImportOpen(false)}>Keep local records</button>
              <button className="primary" disabled={importBusy || stored.leads.length === 0} onClick={importLocalLeads}>
              {importBusy ? 'Importing…' : `Import ${stored.leads.length} complete records`}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
