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

export function scoreLead(lead) {
  const factors = [
    {
      label: 'No website listed in OpenStreetMap',
      points: 50,
      applies: !lead.website,
    },
    {
      label: 'No publicly listed phone number',
      points: 10,
      applies: !lead.phone,
    },
    {
      label: 'No publicly listed email',
      points: 10,
      applies: !lead.email,
    },
    {
      label: 'Address is incomplete or not listed',
      points: 5,
      applies: !lead.address,
    },
    {
      label: 'Website is verified as unavailable',
      points: 25,
      applies: lead.websiteCheck?.status === 'unavailable',
    },
  ];

  return {
    score: Math.min(
      100,
      factors.reduce((total, factor) => total + (factor.applies ? factor.points : 0), 0),
    ),
    factors: factors.filter((factor) => factor.applies),
  };
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
  ['scoreReasons', 'Score factors'],
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
        return csvCell((lead.scoreFactors || []).map((factor) => `${factor.label} (+${factor.points})`).join('; '));
      }
      if (field === 'sourceIdentifier') return csvCell(lead.id);
      return csvCell(lead[field]);
    }).join(','),
  );

  return `\uFEFF${[header, ...rows].join('\r\n')}`;
}
