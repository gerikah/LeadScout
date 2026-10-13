export const LEAD_STATUSES = [
  'New',
  'To Contact',
  'Contacted',
  'Follow-up',
  'Interested',
  'Not Interested',
  'Closed',
];

export const CONTACT_VERIFICATION = 'Not verified (source listing only)';

const AUDIT_SCORE_POINTS = {
  'website-unavailable': 20,
  'missing-https': 8,
  'https-downgrade': 8,
  'missing-title': 5,
  'missing-description': 5,
  'missing-viewport': 5,
  'missing-h1': 2,
  'incomplete-image-alt': 3,
};

export function scoreLead(lead) {
  const factors = [
    {
      label: 'No website listed in OpenStreetMap',
      points: 50,
      group: 'listing',
      applies: !lead.website,
    },
    {
      label: 'No publicly listed phone number',
      points: 10,
      group: 'listing',
      applies: !lead.phone,
    },
    {
      label: 'No publicly listed email',
      points: 10,
      group: 'listing',
      applies: !lead.email,
    },
    {
      label: 'Address is incomplete or not listed',
      points: 5,
      group: 'listing',
      applies: !lead.address,
    },
    {
      label: 'Website is verified as unavailable',
      points: 25,
      group: 'website',
      applies: !lead.websiteAudit && lead.websiteCheck?.status === 'unavailable',
    },
  ];

  if (lead.websiteAudit?.status === 'completed') {
    const verifiedFindings = new Set(
      (lead.websiteAudit.findings || [])
        .filter((finding) => finding.confidence === 'verified')
        .map((finding) => finding.code),
    );
    for (const [code, points] of Object.entries(AUDIT_SCORE_POINTS)) {
      if (verifiedFindings.has(code)) {
        factors.push({
          label: auditScoreLabel(code),
          points,
          group: 'website',
          applies: true,
        });
      }
    }
    if (lead.websiteAudit.https?.status === 'unavailable' && !verifiedFindings.has('missing-https')) {
      factors.push({
        label: 'HTTPS endpoint is unavailable',
        points: AUDIT_SCORE_POINTS['missing-https'],
        group: 'website',
        applies: true,
      });
    }
  }

  const listingScore = factors
    .filter((factor) => factor.group === 'listing' && factor.applies)
    .reduce((total, factor) => total + factor.points, 0);
  const websiteScore = factors
    .filter((factor) => factor.group === 'website' && factor.applies)
    .reduce((total, factor) => total + factor.points, 0);
  const appliedFactors = factors.filter((factor) => factor.applies);
  return {
    score: Math.min(100, listingScore + websiteScore),
    listingScore,
    websiteScore,
    verifiedOpportunityPoints: websiteScore,
    factors: appliedFactors,
  };
}

function auditScoreLabel(code) {
  return {
    'website-unavailable': 'Website returned an unsuccessful response',
    'missing-https': 'HTTPS endpoint is unavailable',
    'https-downgrade': 'HTTPS redirects to an unencrypted HTTP page',
    'missing-title': 'Page title is missing',
    'missing-description': 'Meta description is missing',
    'missing-viewport': 'Viewport declaration is missing',
    'missing-h1': 'No H1 heading found',
    'incomplete-image-alt': 'Some images have no alternative text',
  }[code];
}

export function getLeadId(lead) {
  if (typeof lead?.id === 'string' && /^(node|way|relation)\/\d+$/.test(lead.id.trim())) {
    return lead.id.trim();
  }

  const source = typeof lead?.source === 'string' ? lead.source : '';
  const match = source.match(/openstreetmap\.org\/(node|way|relation)\/(\d+)/i);
  return match ? `${match[1].toLowerCase()}/${match[2]}` : '';
}

export function enrichLead(lead) {
  if (lead.legacy) {
    return {
      ...lead,
      id: getLeadId(lead),
      score: null,
      scoreFactors: [],
      contactVerification: 'Not available until business details are restored',
      opportunity: 'Details need to be restored',
    };
  }

  const { score, factors } = scoreLead(lead);
  return {
    ...lead,
    id: getLeadId(lead),
    score,
    scoreFactors: factors,
    contactVerification: lead.contactVerification || CONTACT_VERIFICATION,
    opportunity: !lead.website
      ? 'No listed website'
      : !lead.email
        ? 'No public email listed'
        : 'Website listed',
  };
}

function normalizeSearchText(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

export function filterAndSortLeads(leads, filters = {}) {
  const scoredLeads = leads.map((lead) => (
    lead.score === undefined && !lead.legacy
      ? { ...lead, score: scoreLead(lead).score }
      : lead
  ));
  const search = normalizeSearchText(filters.search);
  const location = normalizeSearchText(filters.location);
  const category = normalizeSearchText(filters.category);
  const website = filters.website || 'all';
  const contact = filters.contact || 'all';
  const status = filters.status || 'all';
  const auditStatus = filters.auditStatus || 'all';
  const minimumScore = filters.minimumScore !== '' && filters.minimumScore !== undefined &&
    Number.isFinite(Number(filters.minimumScore))
    ? Number(filters.minimumScore)
    : 0;
  const maximumScore = filters.maximumScore !== '' && filters.maximumScore !== undefined &&
    Number.isFinite(Number(filters.maximumScore))
    ? Number(filters.maximumScore)
    : 100;
  const savedAfter = filters.savedAfter ? new Date(filters.savedAfter).getTime() : null;
  const savedBefore = filters.savedBefore
    ? new Date(`${filters.savedBefore}T23:59:59.999`).getTime()
    : null;

  const result = scoredLeads.filter((lead) => {
    const text = normalizeSearchText(
      [lead.name, lead.category, lead.address, lead.location, lead.website, lead.phone, lead.email]
        .filter(Boolean)
        .join(' '),
    );
    const leadLocation = normalizeSearchText([lead.location, lead.address].filter(Boolean).join(' '));
    const score = Number(lead.score) || 0;
    const hasContact = Boolean(lead.phone || lead.email);
    const savedAt = lead.savedAt ? new Date(lead.savedAt).getTime() : null;

    return (
      (!search || text.includes(search)) &&
      (!location || leadLocation.includes(location)) &&
      (!category || normalizeSearchText(lead.category) === category) &&
      (website === 'all' ||
        (website === 'listed' && Boolean(lead.website)) ||
        (website === 'not-listed' && !lead.website)) &&
      (contact === 'all' ||
        (contact === 'available' && hasContact) ||
        (contact === 'missing' && !hasContact)) &&
      (auditStatus === 'all' ||
        (auditStatus === 'not-audited' && !lead.websiteAudit) ||
        (auditStatus === 'completed' && lead.websiteAudit?.status === 'completed') ||
        (auditStatus === 'inconclusive' && lead.websiteAudit?.status === 'inconclusive') ||
        (auditStatus === 'available' && lead.websiteAudit?.availability === 'available') ||
        (auditStatus === 'unavailable' && lead.websiteAudit?.availability === 'unavailable')) &&
      score >= minimumScore &&
      score <= maximumScore &&
      (status === 'all' || lead.status === status) &&
      (savedAfter === null || (savedAt !== null && savedAt >= savedAfter)) &&
      (savedBefore === null || (savedAt !== null && savedAt <= savedBefore))
    );
  });

  const sort = filters.sort || 'score-desc';
  return result.sort((left, right) => {
    if (sort === 'score-asc') return left.score - right.score;
    if (sort === 'name') return left.name.localeCompare(right.name);
    if (sort === 'saved-desc') {
      return (right.savedAt || '').localeCompare(left.savedAt || '');
    }
    if (sort === 'verified-opportunities') {
      return scoreLead(right).verifiedOpportunityPoints - scoreLead(left).verifiedOpportunityPoints ||
        Number(right.score || 0) - Number(left.score || 0);
    }
    return right.score - left.score;
  });
}

const CSV_FIELDS = [
  ['name', 'Business name'],
  ['sourceIdentifier', 'Source identifier'],
  ['category', 'Category'],
  ['location', 'Search location'],
  ['address', 'Address'],
  ['website', 'Website'],
  ['phone', 'Public phone'],
  ['email', 'Public email'],
  ['score', 'Opportunity score'],
  ['listingScore', 'Listing completeness score'],
  ['websiteScore', 'Website quality opportunities score'],
  ['scoreReasons', 'Score factors'],
  ['auditStatus', 'Website audit status'],
  ['auditAvailability', 'Website availability'],
  ['auditHttpStatus', 'Website HTTP status'],
  ['auditHttpsStatus', 'HTTPS status'],
  ['auditCheckedAt', 'Website last checked'],
  ['auditFindings', 'Website findings'],
  ['auditMetadata', 'Website metadata'],
  ['auditMobile', 'Mobile indicators'],
  ['contactVerification', 'Contact verification'],
  ['status', 'Outreach status'],
  ['savedAt', 'Date saved'],
  ['notes', 'Notes'],
  ['source', 'Source attribution'],
];

function csvCell(value) {
  const text = String(value ?? '').replace(/\r\n?|\n/g, '\r\n');
  const safeText = /^[\t ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

export function exportLeadsToCsv(leads) {
  const header = CSV_FIELDS.map(([, label]) => csvCell(label)).join(',');
  const rows = leads.map((lead) =>
    CSV_FIELDS.map(([field]) => {
      if (field === 'scoreReasons') {
        return csvCell((lead.scoreFactors || []).map((factor) => `${factor.group === 'website' ? 'Website' : 'Listing'}: ${factor.label} (+${factor.points})`).join('; '));
      }
      if (field === 'listingScore' || field === 'websiteScore') {
        if (lead.legacy) return csvCell('');
        const score = scoreLead(lead);
        return csvCell(field === 'listingScore' ? score.listingScore : score.websiteScore);
      }
      if (field === 'sourceIdentifier') return csvCell(lead.id);
      if (field === 'auditStatus') return csvCell(lead.websiteAudit?.status);
      if (field === 'auditAvailability') return csvCell(lead.websiteAudit?.availability);
      if (field === 'auditHttpStatus') return csvCell(lead.websiteAudit?.httpStatus);
      if (field === 'auditHttpsStatus') return csvCell(lead.websiteAudit?.https?.status);
      if (field === 'auditCheckedAt') return csvCell(lead.websiteAudit?.checkedAt);
      if (field === 'auditFindings') {
        return csvCell((lead.websiteAudit?.findings || []).map((finding) => `${finding.title}: ${finding.evidence}`).join('; '));
      }
      if (field === 'auditMetadata') {
        const metadata = lead.websiteAudit?.metadata;
        return csvCell(metadata
          ? `title=${metadata.title || 'missing'}; description=${metadata.description || 'missing'}; viewport=${metadata.viewport ? 'present' : 'missing'}; canonical=${metadata.canonical || ''}`
          : '');
      }
      if (field === 'auditMobile') {
        const mobile = lead.websiteAudit?.mobile;
        return csvCell(mobile
          ? `viewport=${mobile.viewport ? 'present' : 'missing'}; responsive=${mobile.responsiveIndicators.map((indicator) => indicator.evidence).join('|')}; fixed-width=${mobile.fixedWidthIndicators.join('|')}`
          : '');
      }
      return csvCell(lead[field]);
    }).join(','),
  );

  return `\uFEFF${[header, ...rows].join('\r\n')}`;
}
