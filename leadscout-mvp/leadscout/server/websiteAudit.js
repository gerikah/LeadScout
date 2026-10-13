import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const USER_AGENT = 'LeadScoutWebsiteAudit/1.0 (+https://github.com/gerikah/LeadScout)';
const REQUEST_TIMEOUT_MS = 5_000;
const AUDIT_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 160 * 1024;
const MAX_REDIRECTS = 3;
const MAX_AUDITS_PER_IP = 5;
const AUDIT_WINDOW_MS = 60_000;
const PRIVATE_IPV4_RANGES = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function invalidUrlError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function ipv4ToNumber(address) {
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function ipv6ToBigInt(address) {
  const normalized = address.toLowerCase().split('%')[0];
  const halves = normalized.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  let right = halves[1] ? halves[1].split(':') : [];
  if (right.some((part) => part.includes('.'))) {
    const ipv4 = right.pop().split('.').map(Number);
    right.push(((ipv4[0] << 8) | ipv4[1]).toString(16));
    right.push(((ipv4[2] << 8) | ipv4[3]).toString(16));
  }
  const parts = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part || '0'}`), 0n);
}

function inIpv6Range(address, network, bits) {
  const shift = 128n - BigInt(bits);
  return ipv6ToBigInt(address) >> shift === ipv6ToBigInt(network) >> shift;
}

function isPrivateAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToNumber(address);
    return PRIVATE_IPV4_RANGES.some(([range, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToNumber(range) & mask);
    });
  }
  if (family !== 6) return true;

  const value = ipv6ToBigInt(address);
  const ipv4MappedPrefix = BigInt('0xffff') << 32n;
  if ((value >> 32n) === ipv4MappedPrefix) {
    return isPrivateAddress(`${Number((value >> 24n) & 255n)}.${Number((value >> 16n) & 255n)}.${Number((value >> 8n) & 255n)}.${Number(value & 255n)}`);
  }

  const globalUnicast = value >> 125n === 1n;
  const documentationRange = inIpv6Range(address, '2001:db8::', 32);
  const special2001Range = inIpv6Range(address, '2001::', 23);
  const sixToFourRange = inIpv6Range(address, '2002::', 16);
  return !globalUnicast || documentationRange || special2001Range || sixToFourRange;
}

export function normalizeAuditUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2_048 || /[\u0000-\u0020\u007f]/.test(rawUrl)) {
    throw invalidUrlError('Enter a valid public website URL.');
  }

  let url;
  try {
    const candidate = /^[a-z][a-z\d+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    url = new URL(candidate);
  } catch {
    throw invalidUrlError('Enter a valid public website URL.');
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.port && !((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')))
  ) {
    throw invalidUrlError('Only public HTTP and HTTPS websites on standard ports can be audited.');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.test')
  ) {
    throw invalidUrlError('Private and local website addresses cannot be audited.');
  }

  if (isIP(hostname) && isPrivateAddress(hostname)) {
    throw invalidUrlError('Private and local website addresses cannot be audited.');
  }

  url.hash = '';
  return url;
}

async function resolvePublicAddresses(url, resolver) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];

  let addresses;
  try {
    addresses = await resolver(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw error;
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    const error = new Error('The website hostname resolves to a private or unsupported address.');
    error.code = 'ERR_PRIVATE_ADDRESS';
    throw error;
  }
  return addresses;
}

async function resolveBeforeDeadline(url, resolver, deadline) {
  const remaining = Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());
  if (remaining <= 0) {
    const error = new Error('Website audit exceeded its time limit.');
    error.code = 'ETIMEDOUT';
    throw error;
  }

  let timeoutId;
  try {
    return await Promise.race([
      resolvePublicAddresses(url, resolver),
      new Promise((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error('Website DNS lookup timed out.');
          error.code = 'ETIMEDOUT';
          reject(error);
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    const selected = addresses[0];
    if (options?.all) callback(null, [selected]);
    else callback(null, selected.address, selected.family);
  };
}

function requestPinned(url, addresses, {
  method = 'GET',
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html, text/plain;q=0.9, */*;q=0.1',
      'Accept-Encoding': 'identity',
      Connection: 'close',
    };
    if (maxBytes > 0) headers.Range = `bytes=0-${maxBytes - 1}`;
    const options = {
      method,
      headers,
      lookup: pinnedLookup(addresses),
      ...(url.protocol === 'https:' && !isIP(url.hostname.replace(/^\[|\]$/g, ''))
        ? { servername: url.hostname }
        : {}),
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    const request = transport(url, options, (response) => {
      const status = response.statusCode || 0;
      const responseHeaders = response.headers;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        finish(resolve, { status, headers: responseHeaders, body: '', truncated: false });
        return;
      }

      let bytes = 0;
      let truncated = false;
      const chunks = [];
      response.on('data', (chunk) => {
        const remaining = maxBytes - bytes;
        if (remaining <= 0) {
          truncated = true;
          response.destroy();
          finish(resolve, { status, headers: responseHeaders, body: Buffer.concat(chunks).toString('utf8'), truncated });
          return;
        }
        const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(accepted);
        bytes += accepted.length;
        if (chunk.length > remaining || bytes >= maxBytes) {
          truncated = true;
          response.destroy();
          finish(resolve, { status, headers: responseHeaders, body: Buffer.concat(chunks).toString('utf8'), truncated });
        }
      });
      response.on('end', () => finish(resolve, {
        status,
        headers: responseHeaders,
        body: Buffer.concat(chunks).toString('utf8'),
        truncated,
      }));
      response.on('error', (error) => {
        if (!settled) finish(reject, error);
      });
    });

    request.setTimeout(timeoutMs, () => {
      const error = new Error('Website request timed out.');
      error.code = 'ETIMEDOUT';
      request.destroy(error);
    });
    request.on('error', (error) => {
      if (!settled) finish(reject, error);
    });
    request.end();
  });
}

async function requestFollowingRedirects(rawUrl, {
  resolver,
  requestImpl,
  deadline,
  beforeRequest,
  method = 'GET',
  maxBytes = MAX_RESPONSE_BYTES,
} = {}) {
  let url = normalizeAuditUrl(rawUrl);
  const redirects = [];

  for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
    const addresses = await resolveBeforeDeadline(url, resolver, deadline);
    if (beforeRequest) {
      const permission = await beforeRequest(url);
      if (!permission.allowed) return { blocked: true, reason: permission.reason, url, redirects };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = new Error('Website audit exceeded its time limit.');
      error.code = 'ETIMEDOUT';
      throw error;
    }
    const startedAt = Date.now();
    const response = await requestImpl(url, addresses, {
      method,
      timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining),
      maxBytes,
    });
    response.latencyMs = Date.now() - startedAt;
    response.url = url;
    response.redirects = redirects;

    const location = response.headers.location;
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
    if (count === MAX_REDIRECTS) {
      response.redirectLimitExceeded = true;
      return response;
    }

    const destination = normalizeAuditUrl(new URL(location, url).href);
    redirects.push({ status: response.status, from: url.href, to: destination.href });
    url = destination;
  }

  throw new Error('Website redirect handling failed.');
}

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (match, code) => {
      const point = Number.parseInt(code, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/&#(\d+);?/g, (match, code) => {
      const point = Number.parseInt(code, 10);
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function getAttributes(tag) {
  const attributes = {};
  const text = tag.replace(/^<[^\s/>]+/, '').replace(/\/?>$/, '');
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(text))) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function textContent(markup) {
  return decodeEntities(markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

export function extractWebsiteMetadata(html, baseUrl) {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)(?:<\/head\s*>|$)/i)?.[1] || '';
  const title = textContent(head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '');
  const metadata = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const attributes = getAttributes(tag);
    const key = (attributes.name || attributes.property || '').toLowerCase();
    if (key) metadata[key] = attributes.content || '';
  }
  const linkTags = head.match(/<link\b[^>]*>/gi) || [];
  let canonical = '';
  for (const tag of linkTags) {
    const attributes = getAttributes(tag);
    if ((attributes.rel || '').toLowerCase().split(/\s+/).includes('canonical')) {
      try {
        canonical = new URL(attributes.href, baseUrl).href;
      } catch {
        canonical = '';
      }
      break;
    }
  }

  const headings = { h1: 0, h2: 0, h3: 0 };
  for (const level of Object.keys(headings)) {
    headings[level] = [...html.matchAll(new RegExp(`<${level}\\b[^>]*>([\\s\\S]*?)<\\/${level}\\s*>`, 'gi'))]
      .filter((match) => textContent(match[1])).length;
  }

  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map(([tag]) => getAttributes(tag));
  const imageAlt = {
    total: images.length,
    withAlt: images.filter((image) => Object.hasOwn(image, 'alt') && image.alt.trim()).length,
  };
  imageAlt.coveragePercent = imageAlt.total
    ? Math.round((imageAlt.withAlt / imageAlt.total) * 100)
    : null;

  const embeddedCss = [
    ...(html.match(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi) || []).map((style) => style.replace(/^<style\b[^>]*>|<\/style\s*>$/gi, '')),
    ...(html.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)).map(([, doubleQuoted, singleQuoted]) => doubleQuoted ?? singleQuoted ?? ''),
  ].join('\n');
  const responsiveIndicators = [];
  if (/@media\b/i.test(embeddedCss)) responsiveIndicators.push({ signal: 'media-query', evidence: 'Embedded CSS contains an @media rule.' });
  if (/\b(?:max|min)-width\s*:/i.test(embeddedCss)) responsiveIndicators.push({ signal: 'responsive-width-rule', evidence: 'Embedded CSS contains a max-width or min-width rule.' });
  if (/\b(?:flex-wrap\s*:\s*wrap|grid-template-columns\s*:[^;]*(?:auto-fit|auto-fill)|width\s*:\s*clamp\s*\()/i.test(embeddedCss)) {
    responsiveIndicators.push({ signal: 'flexible-layout-rule', evidence: 'Embedded CSS contains a flexible layout declaration.' });
  }
  const fixedWidthIndicators = [...embeddedCss.matchAll(/(?:^|[;{"])\s*(?:width|min-width)\s*:\s*(\d{4,})px\b/gi)]
    .map(([, width]) => `${width}px fixed width declared in embedded CSS.`);
  const viewport = /\b(?:width|initial-scale)\s*=/i.test(metadata.viewport || '');

  return {
    title: title || null,
    description: metadata.description || null,
    viewport,
    viewportContent: metadata.viewport || null,
    headComplete: /<\/head\s*>/i.test(html),
    canonical: canonical || null,
    openGraph: {
      title: metadata['og:title'] || null,
      description: metadata['og:description'] || null,
      image: metadata['og:image'] || null,
      url: metadata['og:url'] || null,
    },
    headings,
    imageAlt,
    mobile: {
      viewport,
      responsiveIndicators,
      fixedWidthIndicators,
      scope: 'Indicators inspect embedded CSS only; external stylesheets and rendered behavior are not tested.',
    },
  };
}

function parseRobotsRules(text) {
  const groups = [];
  let agents = [];
  let rules = [];
  let hasRule = false;

  const finishGroup = () => {
    if (agents.length) groups.push({ agents, rules });
    agents = [];
    rules = [];
    hasRule = false;
  };

  for (const line of text.split(/\r?\n/)) {
    const value = line.replace(/#.*$/, '').trim();
    const separator = value.indexOf(':');
    if (separator < 0) continue;
    const directive = value.slice(0, separator).trim().toLowerCase();
    const content = value.slice(separator + 1).trim();
    if (directive === 'user-agent') {
      if (hasRule) finishGroup();
      agents.push(content.toLowerCase());
      continue;
    }
    if ((directive === 'allow' || directive === 'disallow') && agents.length && content && content.length <= 2_048 && rules.length < 2_000) {
      rules.push({ allow: directive === 'allow', path: content });
      hasRule = true;
    }
  }
  finishGroup();

  const specificGroups = groups.filter((group) => group.agents.some((agent) =>
    agent !== '*' && USER_AGENT.toLowerCase().includes(agent),
  ));
  const selected = specificGroups.length ? specificGroups : groups.filter((group) => group.agents.includes('*'));
  return selected.flatMap((group) => group.rules);
}

function robotsPathMatches(rulePath, path) {
  const escaped = rulePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const anchored = rulePath.endsWith('$');
  const pattern = anchored ? `${escaped.slice(0, -2)}$` : escaped;
  return new RegExp(`^${pattern}`).test(path);
}

function checkRobots(rules, pathname) {
  const matching = rules
    .filter((rule) => robotsPathMatches(rule.path, pathname))
    .sort((left, right) =>
      right.path.replace(/[*$]/g, '').length - left.path.replace(/[*$]/g, '').length ||
      Number(right.allow) - Number(left.allow),
    );
  if (!matching.length) return { allowed: true };
  return matching[0].allow
    ? { allowed: true }
    : { allowed: false, reason: 'Website robots.txt disallows this automated request.' };
}

function finding(code, severity, title, evidence, scorePoints = 0, confidence = 'verified') {
  return { code, severity, title, evidence, scorePoints, confidence };
}

function baseResult(url) {
  return {
    version: 1,
    status: 'inconclusive',
    checkedAt: new Date().toISOString(),
    requestedUrl: url.href,
    finalUrl: null,
    availability: 'unknown',
    httpStatus: null,
    latencyMs: null,
    redirects: [],
    https: { status: 'unknown', httpStatus: null },
    metadata: null,
    mobile: null,
    findings: [],
    message: '',
  };
}

function isBlockedStatus(status) {
  return [401, 403, 429].includes(status);
}

function isUnavailableStatus(status) {
  return status >= 400 && status < 600 && !isBlockedStatus(status);
}

function failureAvailability(error) {
  if (
    ['ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']
      .includes(error.code)
  ) {
    return 'unavailable';
  }
  return 'unknown';
}

function createAuditLimiter() {
  const requests = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const address = req.ip || req.socket.remoteAddress || 'unknown';
    const recent = (requests.get(address) || []).filter((timestamp) => now - timestamp < AUDIT_WINDOW_MS);
    if (recent.length >= MAX_AUDITS_PER_IP) {
      res.set('Retry-After', String(Math.ceil((AUDIT_WINDOW_MS - (now - recent[0])) / 1000)));
      return res.status(429).json({ error: 'Website audit limit reached. Please wait before retrying.' });
    }
    recent.push(now);
    requests.set(address, recent);
    if (requests.size > 1_000) {
      for (const [ip, timestamps] of requests) {
        if (!timestamps.some((timestamp) => now - timestamp < AUDIT_WINDOW_MS)) requests.delete(ip);
      }
    }
    return next();
  };
}

export function createWebsiteAuditor({
  resolver = dnsLookup,
  requestImpl = requestPinned,
  now = () => Date.now(),
  maxConcurrent = 2,
} = {}) {
  let activeAudits = 0;

  return async function auditWebsite(rawUrl) {
    const url = normalizeAuditUrl(rawUrl);
    if (activeAudits >= maxConcurrent) {
      const error = new Error('Website audit capacity is busy. Please retry shortly.');
      error.statusCode = 503;
      error.retryAfter = 10;
      throw error;
    }

    activeAudits += 1;
    const deadline = now() + AUDIT_TIMEOUT_MS;
    const result = baseResult(url);
    const robotsCache = new Map();
    const networkRequest = (target, options = {}) => requestFollowingRedirects(target.href, {
      resolver,
      requestImpl,
      deadline,
      ...options,
    });

    async function robotsPolicy(target) {
      const origin = target.origin;
      if (!robotsCache.has(origin)) {
        const robotsUrl = new URL('/robots.txt', origin);
        const robots = await networkRequest(robotsUrl, { maxBytes: 64 * 1024 });
        let rules;
        if (robots.status === 404 || robots.status === 410) {
          rules = [];
        } else if (robots.blocked) {
          robotsCache.set(origin, { allowed: false, reason: robots.reason });
          return robotsCache.get(origin);
        } else if (
          isBlockedStatus(robots.status) ||
          robots.status >= 500 ||
          !robots.status ||
          (robots.status >= 300 && robots.status < 400)
        ) {
          robotsCache.set(origin, { allowed: false, reason: 'The website robots.txt policy could not be verified.' });
          return robotsCache.get(origin);
        } else if (robots.truncated || robots.status === 206) {
          robotsCache.set(origin, { allowed: false, reason: 'The website robots.txt file exceeds the safe inspection limit.' });
          return robotsCache.get(origin);
        } else {
          rules = parseRobotsRules(robots.body || '');
        }
        robotsCache.set(origin, { rules });
      }

      const policy = robotsCache.get(origin);
      return policy.rules ? checkRobots(policy.rules, `${target.pathname}${target.search}`) : policy;
    }

    try {
      const response = await networkRequest(url, {
        beforeRequest: (target) => robotsPolicy(target),
      });
      if (response.blocked) {
        result.message = response.reason;
        return result;
      }

      result.finalUrl = response.url.href;
      result.httpStatus = response.status;
      result.latencyMs = response.latencyMs;
      result.redirects = response.redirects;
      const observedHttps = response.url.protocol === 'https:' ||
        url.protocol === 'https:' ||
        response.redirects.some((redirect) => redirect.from.startsWith('https:'));
      result.https = { status: observedHttps ? 'available' : 'unknown', httpStatus: observedHttps ? response.status : null };
      if (response.redirectLimitExceeded) {
        result.message = 'The website exceeded the safe redirect limit; availability is unknown.';
        return result;
      }

      if (isBlockedStatus(response.status)) {
        result.message = `The website returned HTTP ${response.status}; automated access may be restricted.`;
        return result;
      }
      if (!response.status) {
        result.message = 'The website returned no HTTP response.';
        return result;
      }

      result.availability = isUnavailableStatus(response.status) ? 'unavailable' : 'available';
      result.status = 'completed';
      const contentType = response.headers['content-type'] || '';
      const isHtml = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
      if (response.status >= 200 && response.status < 300 && isHtml) {
        result.metadata = extractWebsiteMetadata(response.body, response.url);
        result.metadata.sampled = response.truncated || response.status === 206;
        result.mobile = result.metadata.mobile;
      }

      if (!observedHttps) {
        try {
          const httpsUrl = new URL(response.url.href);
          httpsUrl.protocol = 'https:';
          httpsUrl.port = '';
          const httpsResponse = await networkRequest(new URL('/', httpsUrl.origin), {
            beforeRequest: (target) => robotsPolicy(target),
            method: 'HEAD',
            maxBytes: 0,
          });
          if (httpsResponse.blocked) {
            result.https = { status: 'unknown', httpStatus: null };
          } else if (httpsResponse.status && !httpsResponse.requestError) {
            result.https = { status: 'available', httpStatus: httpsResponse.status };
          } else {
            result.https = { status: failureAvailability(httpsResponse.error || {}) === 'unavailable' ? 'unavailable' : 'unknown', httpStatus: null };
          }
        } catch (error) {
          result.https = {
            status: failureAvailability(error) === 'unavailable' ? 'unavailable' : 'unknown',
            httpStatus: null,
          };
        }
      }

      const findings = [];
      if (result.availability === 'unavailable') {
        findings.push(finding(
          'website-unavailable',
          'high',
          'Website page did not respond successfully',
          `The final page returned HTTP ${response.status}.`,
          20,
        ));
      }
      if (result.https.status === 'unavailable') {
        findings.push(finding(
          'missing-https',
          'medium',
          'HTTPS endpoint is unavailable',
          'A standard-port HTTPS request failed with a connection or TLS error.',
          8,
        ));
      }
      if (response.redirects.some((redirect) => redirect.from.startsWith('https:') && redirect.to.startsWith('http:'))) {
        findings.push(finding(
          'https-downgrade',
          'high',
          'HTTPS redirect downgrades to HTTP',
          'A redirect from an HTTPS URL ends at an unencrypted HTTP URL.',
          8,
        ));
      }
      if (result.metadata) {
        if (result.metadata.headComplete) {
          if (!result.metadata.title) findings.push(finding('missing-title', 'medium', 'Page title is missing', 'No non-empty <title> was found in the complete HTML head.', 5));
          if (!result.metadata.description) findings.push(finding('missing-description', 'medium', 'Meta description is missing', 'No non-empty meta description was found in the complete HTML head.', 5));
          if (!result.metadata.viewport) findings.push(finding('missing-viewport', 'medium', 'Viewport declaration is missing', 'No viewport meta tag was found in the complete HTML head.', 5));
        } else {
          findings.push(finding('incomplete-head-sample', 'info', 'Metadata sample is incomplete', 'The response ended before a closing head tag was observed; missing metadata was not scored.', 0, 'indicator'));
        }
        if (!result.metadata.headings.h1 && !result.metadata.sampled) {
          findings.push(finding('missing-h1', 'low', 'No H1 heading found', 'No non-empty H1 heading was found in the complete downloaded HTML.', 2));
        }
        if (result.metadata.imageAlt.total && result.metadata.imageAlt.withAlt < result.metadata.imageAlt.total) {
          findings.push(finding(
            'incomplete-image-alt',
            'low',
            'Some images have no alternative text',
            `${result.metadata.imageAlt.total - result.metadata.imageAlt.withAlt} of ${result.metadata.imageAlt.total} image tags in the downloaded${result.metadata.sampled ? ' sample' : ''} HTML have no non-empty alt attribute.`,
            3,
          ));
        }
        for (const evidence of result.metadata.mobile.fixedWidthIndicators) {
          findings.push(finding('fixed-width-indicator', 'info', 'Possible fixed-width layout indicator', evidence, 0, 'indicator'));
        }
        if (!result.metadata.mobile.responsiveIndicators.length) {
          findings.push(finding(
            'responsive-rules-not-observed',
            'info',
            'No responsive rules observed in embedded CSS',
            'No responsive rule was found in embedded CSS; external stylesheets and rendered layout were not tested.',
            0,
            'indicator',
          ));
        }
      }
      result.findings = findings;
      return result;
    } catch (error) {
      if (error.code === 'ERR_PRIVATE_ADDRESS') {
        const rejection = new Error(error.message);
        rejection.statusCode = 400;
        throw rejection;
      }
      result.message = {
        ETIMEDOUT: 'Website audit timed out; availability is unknown.',
        ENOTFOUND: 'Website hostname did not resolve (ENOTFOUND).',
        ECONNREFUSED: 'The website connection was refused (ECONNREFUSED).',
        EHOSTUNREACH: 'The website host could not be reached (EHOSTUNREACH).',
        ERR_TLS_CERT_ALTNAME_INVALID: 'The HTTPS certificate does not match the website hostname.',
        CERT_HAS_EXPIRED: 'The HTTPS certificate has expired.',
        DEPTH_ZERO_SELF_SIGNED_CERT: 'HTTPS certificate validation failed because the certificate is self-signed.',
      }[error.code] || 'The website could not be checked conclusively; the response may be blocked or the connection may have been interrupted.';
      result.availability = failureAvailability(error);
      if (url.protocol === 'https:' && result.availability !== 'unknown') {
        result.https = { status: 'unavailable', httpStatus: null };
      }
      result.status = result.availability === 'unavailable' ? 'completed' : 'inconclusive';
      result.findings = result.availability === 'unavailable'
        ? [finding('website-unavailable', 'high', 'Website could not be reached', error.code || error.message, 20)]
        : [];
      return result;
    } finally {
      activeAudits -= 1;
    }
  };
}

export { createAuditLimiter };
