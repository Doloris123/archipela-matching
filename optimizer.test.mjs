import test from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates, weeklyLoad, shanghaiWeek } from './matching.mjs';
import { planAssignments } from './optimizer.mjs';

const now = '2026-10-29T04:00:00.000Z';
const request = (id = 'r', extra = {}) => ({ id, authorId: `author-${id}`, title: 'Python', description: '工具交流',
  tags: ['Python'], category: '工具与方法', mode: '线上', duration: 20, availability: ['周一', '周二', '周三'],
  status: 'open', scope: '公开', createdAt: now, ...extra });
const profile = (id = 'h', extra = {}) => ({ id, skills: ['Python'], bio: '可分享编程经验', helpScope: ['工具与方法'],
  capacity: 3, modes: ['线上'], availableSlots: ['周一', '周二', '周三'], ...extra });
const session = (extra = {}) => ({ id: 's', requestIds: ['old'], helperId: 'h', initiatorId: 'other', participantIds: ['other', 'h'],
  slot: '周一', status: 'confirmed', createdAt: now, ...extra });

test('semantic recall expands synonyms but never invents an expertise claim', () => {
  const r = request('r', { title: '让红绿色觉障碍读者看清图表', description: '想调整配色与符号', tags: ['配色'] });
  const p = profile('h', { skills: ['无障碍可视化'] });
  assert.equal(rankCandidates(r, [p], [], { now }).candidates.length, 0);
  const result = rankCandidates(r, [p], [], { now, semanticReady: true, semanticScores: { h: .8 } });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].lexicalScore, 0);
  assert.equal(result.candidates[0].semanticScore, .8);
  assert.equal(result.candidates[0].reasons[0], '帮助卡与需求描述在语义上相关');
});

test('all variants retain scope, declaration, capacity, refusal, and participant conflict gates', () => {
  const r = request();
  const ps = [profile('self', { id: r.authorId }), profile('scope', { helpScope: [] }), profile('empty', { skills: [] }),
    profile('zero', { capacity: 0 }), profile('busy'), profile('refused'), profile('free')];
  const sessions = [session({ helperId: 'someone', participantIds: ['busy', 'someone'], slot: '周一' }),
    session({ id: 's2', helperId: 'refused', status: 'declined', declinedBy: ['refused'], requestIds: ['r'] })];
  r.availability = ['周一'];
  for (const variant of ['lexical', 'semantic', 'capacity', 'full']) {
    const result = planAssignments([r], ps, sessions, { now, variant, semanticReady: true,
      semanticScores: { r: Object.fromEntries(ps.map(p => [p.id, .99])) } });
    assert.deepEqual(result.assignments.map(a => a.profileId), ['free']);
    assert.equal(result.diagnostics.producesInvitations, false);
    assert.equal(result.assignments[0].requiresConfirmation, true);
  }
});

test('request author conflict is enforced even when author is helping elsewhere', () => {
  const r = request('r', { availability: ['周一'] });
  assert.equal(rankCandidates(r, [profile()], [session({ helperId: r.authorId, participantIds: [r.authorId, 'other'] })], { now }).candidates.length, 0);
});

test('all pending invitations count across Shanghai week boundaries', () => {
  assert.equal(shanghaiWeek('2026-10-25T15:59:59Z'), '2026-10-19');
  assert.equal(shanghaiWeek('2026-10-25T16:00:00Z'), '2026-10-26');
  const sessions = [session({ createdAt: '2020-01-01', status: 'pending' }),
    session({ createdAt: '2026-10-25T15:59:59Z', status: 'completed' }),
    session({ createdAt: '2026-10-25T16:00:00Z', status: 'completed' })];
  assert.equal(weeklyLoad('h', sessions, now), 2);
});

test('invitation budget, active request and missing semantic scores fail closed', () => {
  const r = request('r', { title: '', description: '', tags: ['不同'] });
  const ps = [profile()];
  assert.equal(rankCandidates(r, ps, [], { semanticReady: true, semanticScores: { h: NaN } }).candidates.length, 0);
  assert.equal(rankCandidates(request(), ps, [session({ requestIds: ['r'] })]).candidates.length, 0);
  const history = [1, 2, 3].map(i => session({ id: String(i), helperId: `x${i}`, requestIds: ['r'], status: 'declined' }));
  assert.equal(rankCandidates(request(), ps, history).candidates.length, 0);
});

test('cancellation by request author does not masquerade as helper refusal', () => {
  assert.equal(rankCandidates(request(), [profile()], [session({ requestIds: ['r'], status: 'declined', declinedBy: ['author-r'] })], { now }).candidates.length, 1);
});

test('optimizer repairs greedy dead-end while respecting one assignment per request', () => {
  const rs = [request('a', { tags: ['Python'], title: 'Python', availability: ['周一'] }),
    request('b', { tags: ['Matlab'], title: 'Matlab', availability: ['周一'] })];
  const ps = [profile('a', { skills: ['Python', 'Matlab'], capacity: 1 }), profile('b', { skills: ['Python'], capacity: 1 })];
  const baseline = planAssignments(rs, ps, [], { now, variant: 'lexical' });
  const optimized = planAssignments(rs, ps, [], { now, variant: 'capacity' });
  assert.equal(baseline.assignments.length, 1);
  assert.equal(optimized.assignments.length, 2);
  assert.equal(optimized.diagnostics.optimal, true);
  assert.equal(new Set(optimized.assignments.map(x => x.requestId)).size, 2);
});

test('a participant cannot be helper and author simultaneously in the same slot', () => {
  const rs = [request('a', { authorId: 'p', availability: ['周一'] }), request('b', { authorId: 'q', availability: ['周一'] })];
  const ps = [profile('p'), profile('q')];
  assert.equal(planAssignments(rs, ps, [], { now }).assignments.length, 1);
});

test('bounded search reports an honest lower bound and never claims optimal after truncation', () => {
  const rs = [request('a'), request('b'), request('c')];
  const ps = [profile('h1'), profile('h2')];
  const result = planAssignments(rs, ps, [], { now, nodeBudget: 1 });
  assert.equal(result.diagnostics.truncated, true);
  assert.equal(result.diagnostics.optimal, false);
  assert.ok(result.diagnostics.objectiveUpperBound >= result.objective);
});

test('too-large problems return a feasible greedy plan with a size-limit diagnosis', () => {
  const rs = Array.from({ length: 129 }, (_, i) => request(`r${i}`, { availability: [`slot${i}`] }));
  const ps = [profile('h', { capacity: 200, availableSlots: rs.map(r => r.availability[0]) })];
  const result = planAssignments(rs, ps, [], { now });
  assert.equal(result.assignments.length, 129);
  assert.equal(result.diagnostics.truncationReason, 'problem-size');
  assert.equal(result.diagnostics.optimal, false);
});

test('semantic, fairness, contact and global ablations are explicit and retain hard capacity', () => {
  for (const options of [{ weights: { semantic: 0 } }, { weights: { fairness: 0 } }, { weights: { contact: 0 } }, { global: false }]) {
    const result = planAssignments([request('a'), request('b')], [profile('h', { capacity: 1 })], [], { now, ...options });
    assert.equal(result.assignments.length, 1);
    if (options.global === false) assert.equal(result.diagnostics.algorithm, 'creation-order-greedy');
  }
});

test('convex load cost spreads equal-quality work and repeated-contact cost chooses a fresh helper', () => {
  const rs = [request('a', { availability: ['周一'] }), request('b', { availability: ['周二'] }), request('c', { availability: ['周三'] })];
  const ps = [profile('h1'), profile('h2'), profile('h3')];
  const full = planAssignments(rs, ps, [], { now });
  assert.equal(new Set(full.assignments.map(a => a.profileId)).size, 3);
  const withoutFairness = planAssignments(rs, ps, [], { now, weights: { fairness: 0 } });
  assert.equal(new Set(withoutFairness.assignments.map(a => a.profileId)).size, 1);
  const previous = session({ helperId: 'h1', participantIds: ['author-a', 'h1'], status: 'completed', createdAt: '2026-10-22T00:00:00Z' });
  assert.equal(planAssignments([rs[0]], ps.slice(0, 2), [previous], { now }).assignments[0].profileId, 'h2');
});

test('abstention remains feasible and planning never mutates source records', () => {
  const rs = [request('a')]; const ps = [profile('h1')];
  const sessions = [0, 1, 2].map(i => session({ id: `past${i}`, helperId: 'h1', participantIds: ['author-a', 'h1'], status: 'completed', createdAt: '2026-10-22T00:00:00Z' }));
  const before = JSON.stringify({ rs, ps, sessions });
  const result = planAssignments(rs, ps, sessions, { now, weights: { contact: 200 } });
  assert.equal(result.assignments.length, 0);
  assert.equal(result.objective, 0);
  assert.equal(JSON.stringify({ rs, ps, sessions }), before);
});

// Independent exhaustive enumeration, without using the planner's state or search code.
function exhaustive(rs, ps, scores) {
  let optimum = 0;
  const edges = rs.map(r => rankCandidates(r, ps, [], { now, limit: 100, semanticReady: true, semanticScores: scores[r.id] }).candidates
    .flatMap(c => c.slots.map(slot => ({ ...c, slot, authorId: r.authorId }))));
  function enumerate(index, picked) {
    if (index < rs.length) {
      enumerate(index + 1, picked);
      for (const e of edges[index]) enumerate(index + 1, [...picked, e]);
      return;
    }
    const occupancy = new Set(); const loads = {};
    let value = 0;
    for (const e of picked) {
      loads[e.profileId] = (loads[e.profileId] ?? 0) + 1;
      if (loads[e.profileId] > ps.find(p => p.id === e.profileId).capacity) return;
      for (const id of [e.profileId, e.authorId]) {
        const key = `${id}:${e.slot}`; if (occupancy.has(key)) return; occupancy.add(key);
      }
      value += 12 + 100 * e.relevance;
    }
    for (const p of ps) value -= 20 * ((loads[p.id] ?? 0) / p.capacity) ** 2;
    optimum = Math.max(optimum, value);
  }
  enumerate(0, []); return optimum;
}
test('branch-and-bound equals exhaustive oracle on 30 seeded small conflicting graphs', () => {
  let state = 731;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 30; trial++) {
    const rs = [0, 1, 2].map(i => request(`r${i}`, { authorId: random() < .35 ? 'shared-author' : `u${i}`, availability: ['周一', '周二'].filter(() => random() > .15) }));
    const ps = [0, 1].map(i => profile(`h${i}`, { capacity: random() < .5 ? 1 : 2 }));
    const scores = Object.fromEntries(rs.map(r => [r.id, Object.fromEntries(ps.map(p => [p.id, random()]))]));
    const actual = planAssignments(rs, ps, [], { now, semanticReady: true, semanticScores: scores, nodeBudget: 100000 });
    assert.equal(actual.diagnostics.optimal, true);
    assert.ok(Math.abs(actual.objective - exhaustive(rs, ps, scores)) < 1e-6, `trial ${trial}`);
  }
});
