import { rankCandidates, weeklyLoad } from './matching.mjs';

export const DEFAULT_WEIGHTS = Object.freeze({ relevance: 100, coverage: 12, fairness: 20, contact: 16, semantic: 0.8 });
const VARIANTS = new Set(['lexical', 'semantic', 'capacity', 'full']);
const EPSILON = 1e-9;
const safeNumber = (value, fallback) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
const order = (a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.id.localeCompare(b.id);
const busyKey = (id, slot) => JSON.stringify([id, slot]);

/**
 * Side-effect-free capacitated set packing. All variants keep the same safety gates.
 * Full/capacity use bounded branch-and-bound; incomplete searches explicitly report it.
 * Returned assignments are suggestions, not sessions or invitations.
 */
export function planAssignments(requests, profiles, sessions = [], options = {}) {
  const started = performance.now();
  const variant = options.variant ?? 'full';
  if (!VARIANTS.has(variant)) throw new TypeError(`Unknown planner variant: ${variant}`);
  const weights = Object.fromEntries(Object.entries(DEFAULT_WEIGHTS).map(([key, value]) => [key, safeNumber(options.weights?.[key], value)]));
  if (variant !== 'full') { weights.fairness = 0; weights.contact = 0; }
  if (variant === 'lexical') weights.semantic = 0;
  weights.semantic = Math.min(1, weights.semantic);
  const now = options.now ?? new Date();
  const profileById = new Map(profiles.map(profile => [profile.id, profile]));
  const loads = new Map(profiles.map(profile => [profile.id, weeklyLoad(profile.id, sessions, now)]));
  const requested = [...new Map(requests.map(request => [request.id, request])).values()].sort(order);
  const rows = requested.map(request => {
    const ranked = rankCandidates(request, profiles, sessions, {
      ...options, variant, weights, now, limit: profiles.length,
      semanticScores: options.semanticScores?.[request.id] ?? {},
    });
    const edges = ranked.candidates.flatMap(candidate => candidate.slots.map(slot => ({
      ...candidate, slot, requestId: request.id, authorId: request.authorId,
      baseUtility: weights.coverage + weights.relevance * candidate.relevance - weights.contact * candidate.contactCost,
    }))).sort((a, b) => b.baseUtility - a.baseUtility || a.profileId.localeCompare(b.profileId) || a.slot.localeCompare(b.slot));
    return { request, edges, reason: ranked.reason, trace: ranked.trace, rejected: ranked.rejected };
  });
  const used = new Map();
  const busy = new Set();
  const selected = [];
  const feasible = edge => {
    const profile = profileById.get(edge.profileId);
    return (used.get(edge.profileId) ?? 0) + loads.get(edge.profileId) < profile.capacity
      && !busy.has(busyKey(edge.profileId, edge.slot)) && !busy.has(busyKey(edge.authorId, edge.slot));
  };
  const marginalUtility = edge => {
    const profile = profileById.get(edge.profileId);
    const before = loads.get(edge.profileId) + (used.get(edge.profileId) ?? 0);
    // Exact incremental cost of sum_h ((existing_h + assigned_h) / capacity_h)^2.
    const convexDelta = ((before + 1) ** 2 - before ** 2) / profile.capacity ** 2;
    return edge.baseUtility - weights.fairness * convexDelta;
  };
  const add = edge => {
    used.set(edge.profileId, (used.get(edge.profileId) ?? 0) + 1);
    busy.add(busyKey(edge.profileId, edge.slot)); busy.add(busyKey(edge.authorId, edge.slot));
    selected.push(edge);
  };
  const remove = edge => {
    selected.pop(); used.set(edge.profileId, used.get(edge.profileId) - 1);
    busy.delete(busyKey(edge.profileId, edge.slot)); busy.delete(busyKey(edge.authorId, edge.slot));
  };
  function greedy(rowOrder) {
    let objective = 0;
    for (const row of rowOrder) {
      const edge = row.edges.filter(feasible).map(candidate => ({ candidate, utility: marginalUtility(candidate) }))
        .sort((a, b) => b.utility - a.utility || a.candidate.profileId.localeCompare(b.candidate.profileId) || a.candidate.slot.localeCompare(b.candidate.slot))[0];
      if (edge && edge.utility > EPSILON) { objective += edge.utility; add(edge.candidate); }
    }
    const result = { objective, selected: [...selected] };
    for (const edge of [...selected].reverse()) remove(edge);
    return result;
  }
  const isGlobal = options.global !== false && (variant === 'capacity' || variant === 'full');
  const searchRows = rows.filter(row => row.edges.length).sort((a, b) => a.edges.length - b.edges.length || order(a.request, b.request));
  let best = greedy(isGlobal ? searchRows : rows);
  let searchNodes = 0;
  let truncated = false;
  let truncationReason = null;
  const nodeBudget = Math.max(1, Math.floor(safeNumber(options.nodeBudget, 150000)));
  const timeBudgetMs = safeNumber(options.timeBudgetMs, Infinity);
  const rootUpperBound = searchRows.reduce((sum, row) => sum + Math.max(0, ...row.edges.map(edge => edge.baseUtility)), 0);
  const upperBound = index => searchRows.slice(index).reduce((sum, row) =>
    sum + Math.max(0, ...row.edges.filter(feasible).map(edge => Math.max(0, marginalUtility(edge)))), 0);
  function search(index, objective) {
    if (searchNodes >= nodeBudget || performance.now() - started >= timeBudgetMs) {
      truncated = true;
      truncationReason = searchNodes >= nodeBudget ? 'node-budget' : 'time-budget';
      return;
    }
    searchNodes++;
    if (objective > best.objective + EPSILON) best = { objective, selected: [...selected] };
    if (index >= searchRows.length || objective + upperBound(index) <= best.objective + EPSILON) return;
    const alternatives = searchRows[index].edges.filter(feasible)
      .map(edge => ({ edge, utility: marginalUtility(edge) }))
      .filter(item => item.utility > EPSILON)
      .sort((a, b) => b.utility - a.utility || a.edge.profileId.localeCompare(b.edge.profileId) || a.edge.slot.localeCompare(b.edge.slot));
    for (const { edge, utility } of alternatives) {
      add(edge); search(index + 1, objective + utility); remove(edge);
      if (truncated) return;
    }
    search(index + 1, objective); // Abstention is always feasible.
  }
  if (isGlobal && searchRows.length <= 128) search(0, 0);
  else if (isGlobal) { truncated = true; truncationReason = 'problem-size'; }
  const assignments = best.selected.map(({ baseUtility, ...edge }) => ({ ...edge, requiresConfirmation: true }))
    .sort((a, b) => a.requestId.localeCompare(b.requestId));
  const assigned = new Set(assignments.map(edge => edge.requestId));
  const finalLoads = Object.fromEntries(profiles.map(profile => [profile.id,
    loads.get(profile.id) + assignments.filter(edge => edge.profileId === profile.id).length]));
  return {
    assignments,
    rejections: rows.filter(row => !assigned.has(row.request.id)).map(row => ({ requestId: row.request.id,
      reason: row.reason ?? '本轮容量、时间冲突或联系成本下暂不安排' })),
    objective: Number(best.objective.toFixed(8)),
    diagnostics: {
      algorithm: isGlobal ? 'bounded-branch-and-bound' : 'creation-order-greedy', variant,
      optimal: isGlobal && !truncated, truncated, truncationReason, searchNodes, nodeBudget,
      objectiveUpperBound: Number((isGlobal && !truncated ? best.objective : rootUpperBound).toFixed(8)),
      elapsedMs: Number((performance.now() - started).toFixed(3)),
      requestCount: rows.length, candidateEdgeCount: rows.reduce((sum, row) => sum + row.edges.length, 0),
      weights, finalLoads, semanticReady: options.semanticReady === true,
      producesInvitations: false,
    },
    trace: rows.map(row => ({ requestId: row.request.id, ...row.trace, rejected: row.rejected,
      candidateEdges: row.edges.length,
      selectedProfileId: assignments.find(edge => edge.requestId === row.request.id)?.profileId ?? null })),
  };
}
