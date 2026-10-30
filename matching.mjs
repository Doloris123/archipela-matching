/** Deterministic, side-effect-free recommendation rules shared by service and evaluation. */
const ALIASES = Object.freeze({
  ppt: '汇报表达', '演示文稿': '汇报表达', '学术汇报': '科研汇报',
  'eye-tracking': '眼动', eyetracking: '眼动', '眼动仪': '眼动', '眼动设备': '眼动',
  'git hub': 'github', py: 'python',
});
export const DEFAULT_SEMANTIC_THRESHOLD = 0.55;
export const DEFAULT_SEMANTIC_WEIGHT = 0.8;
export const activeSession = session => session.status === 'pending' || session.status === 'confirmed';
export function normalizeTag(value) {
  const normalized = String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  return ALIASES[normalized] ?? normalized;
}
const uniqueTags = values => new Set((values ?? []).map(normalizeTag).filter(Boolean));
const common = (left, right) => [...new Set(left ?? [])].filter(value => new Set(right ?? []).has(value));
const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Free-text themes still need to respect declared helpScope labels. */
export function matchesHelpScope(request, profile) {
  const scopes = profile.helpScope ?? [];
  if (!scopes.length) return false;
  if (scopes.includes(request.category)) return true;
  const haystack = normalizeTag([request.category, request.title, ...(request.tags ?? [])].filter(Boolean).join(' '));
  return scopes.some(scope => {
    const needle = normalizeTag(scope);
    return needle && (haystack.includes(needle) || needle.includes(normalizeTag(request.category ?? '')));
  });
}

/** Structured `周X|HH:00-HH:00` slots map onto legacy 下午/晚间 labels for intersection. */
export function coarseAvailability(values = []) {
  const out = new Set();
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    const structured = text.match(/^(周[一二三四五六日])\|(\d{2}):00-(\d{2}):00$/);
    if (structured) {
      const day = structured[1];
      const start = Number(structured[2]);
      const end = Number(structured[3]);
      for (let hour = start; hour < end; hour++) {
        const band = hour < 12 ? '下午' : hour < 18 ? '下午' : '晚间';
        out.add(`${day}${band}`);
      }
      continue;
    }
    out.add(text);
  }
  return [...out];
}
export function shanghaiWeek(value) {
  const millis = new Date(value).getTime();
  if (!Number.isFinite(millis)) return null;
  const shifted = new Date(millis + 8 * 3600000);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() - ((shifted.getUTCDay() + 6) % 7));
  return shifted.toISOString().slice(0, 10);
}
export function weeklyLoad(profileId, sessions, now = new Date()) {
  const week = shanghaiWeek(now);
  return sessions.filter(session => {
    if (session.helperId !== profileId || session.status === 'declined') return false;
    if (activeSession(session)) return true;
    return session.status === 'completed' && (shanghaiWeek(session.createdAt) === null || shanghaiWeek(session.createdAt) === week);
  }).length;
}
export function sessionParticipants(session) {
  return [...new Set([session.helperId, session.initiatorId, ...(session.participantIds ?? [])].filter(Boolean))];
}
export function lexicalCoverage(request, profile) {
  const requestTags = uniqueTags(request.tags);
  const searchable = normalizeTag(`${request.title ?? ''} ${request.description ?? ''}`);
  const declared = [...uniqueTags(profile.skills)];
  const matches = declared.filter(skill => {
    if (requestTags.has(skill)) return true;
    if (skill.length < 2) return false;
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return /^[a-z0-9 .+#-]+$/.test(skill)
      ? new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(searchable)
      : searchable.includes(skill);
  });
  return { score: Math.min(1, matches.length / Math.max(requestTags.size, 1)), matches };
}
function wasDeclined(request, profile, sessions) {
  return sessions.some(session => session.requestIds?.includes(request.id) && session.helperId === profile.id
    && session.status === 'declined' && (!session.declinedBy || session.declinedBy.includes(profile.id)));
}
function contactsWithinWindow(request, profile, sessions, now, days) {
  const nowMs = new Date(now).getTime();
  return sessions.filter(session => {
    const stamp = new Date(session.createdAt).getTime();
    return session.helperId === profile.id
      && (sessionParticipants(session).includes(request.authorId) || session.requestIds?.includes(request.id))
      && (activeSession(session) || (stamp <= nowMs && stamp >= nowMs - days * 86400000));
  }).length;
}

/**
 * Embedding scores may expand semantic recall, but cannot override declared consent,
 * scope, availability, reservations or refusal. This function never contacts anyone.
 */
export function rankCandidates(request, profiles, sessions = [], options = {}) {
  const now = options.now ?? new Date();
  const semanticWeight = Math.min(1, Math.max(0, finite(options.weights?.semantic, DEFAULT_SEMANTIC_WEIGHT)));
  const semanticEnabled = options.semanticReady === true && semanticWeight > 0 && options.variant !== 'lexical';
  const threshold = Math.min(1, Math.max(-1, finite(options.threshold, DEFAULT_SEMANTIC_THRESHOLD)));
  const invitationLimit = Math.max(0, finite(options.invitationLimit, 3));
  const previous = sessions.filter(session => session.requestIds?.includes(request.id));
  const empty = reason => ({ candidates: [], reason, semanticUsed: false, semanticAvailable: semanticEnabled,
    rejected: { request: profiles.length, scope: 0, relevance: 0, capacity: 0, availability: 0, declined: 0 },
    trace: { considered: profiles.length, eligible: 0, returned: 0, semanticThreshold: threshold, semanticWeight, requestGate: reason } });
  if (request.status !== 'open') return empty('需求当前未开放');
  if (!(request.availability ?? []).length) return empty('尚未填写可用时间');
  if (previous.some(activeSession)) return empty('已有邀请正在等待或交流中');
  if (previous.length >= invitationLimit) return empty('已达到这条需求的邀请次数上限');
  const requestedModes = request.mode === '均可' ? ['线上', '线下'] : [request.mode];
  const rejected = { request: 0, scope: 0, relevance: 0, capacity: 0, availability: 0, declined: 0 };
  const candidates = [];
  for (const profile of profiles) {
    if (Boolean(request.demo) !== Boolean(profile.demo) || profile.id === request.authorId
      || !matchesHelpScope(request, profile) || uniqueTags(profile.skills).size === 0) { rejected.scope++; continue; }
    if (wasDeclined(request, profile, previous)) { rejected.declined++; continue; }
    const lexical = lexicalCoverage(request, profile);
    const rawSemantic = options.semanticScores?.[profile.id];
    const hasSemantic = semanticEnabled && typeof rawSemantic === 'number' && Number.isFinite(rawSemantic) && rawSemantic >= -1 && rawSemantic <= 1;
    const semanticScore = hasSemantic ? rawSemantic : null;
    if (lexical.matches.length === 0 && !(hasSemantic && semanticScore >= threshold)) { rejected.relevance++; continue; }
    const load = weeklyLoad(profile.id, sessions, now);
    if (!Number.isInteger(profile.capacity) || profile.capacity <= 0 || load >= profile.capacity) { rejected.capacity++; continue; }
    const modes = common(requestedModes, profile.modes);
    const occupied = new Set(sessions.filter(activeSession).filter(session => {
      const people = sessionParticipants(session);
      return people.includes(profile.id) || people.includes(request.authorId);
    }).map(session => session.slot));
    const requestSlots = coarseAvailability(request.availability);
    const slots = common(requestSlots, profile.availableSlots).filter(slot => !occupied.has(slot));
    if (!modes.length || !slots.length) { rejected.availability++; continue; }
    const semanticRelevance = Math.max(0, semanticScore ?? 0);
    const relevance = hasSemantic ? semanticWeight * semanticRelevance + (1 - semanticWeight) * lexical.score : lexical.score;
    const contactCount = contactsWithinWindow(request, profile, sessions, now, Math.max(1, finite(options.contactWindowDays, 14)));
    candidates.push({
      profileId: profile.id,
      score: Math.round(100 * relevance), relevance,
      lexicalScore: lexical.score, semanticScore,
      source: hasSemantic ? 'hybrid' : 'lexical',
      slot: slots[0], slots, mode: modes[0], duration: request.duration,
      weeklyLoad: load, remainingCapacity: profile.capacity - load,
      contactCount, contactCost: Math.min(1, contactCount / 3),
      reasons: [
        lexical.matches.length ? `已声明${lexical.matches.slice(0, 2).join('、')}经验` : '帮助卡与需求描述在语义上相关',
        `${slots[0]}均可交流`,
        `本周剩余 ${profile.capacity - load} 次帮助额度`,
      ],
    });
  }
  candidates.sort((a, b) => b.relevance - a.relevance || a.contactCost - b.contactCost || a.profileId.localeCompare(b.profileId));
  const limit = Math.max(0, finite(options.limit, 5));
  return {
    candidates: candidates.slice(0, limit),
    reason: candidates.length ? null : rejected.capacity ? '相关成员的帮助额度已用完'
      : rejected.availability ? '暂无兼容的时间与交流方式' : rejected.declined ? '相关成员已婉拒这条需求' : '暂无符合条件的成员',
    semanticUsed: candidates.some(candidate => candidate.source === 'hybrid'),
    semanticAvailable: semanticEnabled,
    rejected,
    trace: { considered: profiles.length, eligible: candidates.length, returned: Math.min(candidates.length, limit),
      semanticThreshold: threshold, semanticWeight, requestGate: null },
  };
}
