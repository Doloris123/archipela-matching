# archipela-matching

Constraint-aware **micro-help matching** and **capacitated global assignment** extracted from [研屿 Archipela](https://github.com/2365274664/archipela-matching).

Designed for quiet campus research collaboration: suggest who can help whom, **without** sending invitations. Host applications must keep a human confirmation step.

## What is original

| Module | Role |
|--------|------|
| `matching.mjs` | Help-scope / skill / capacity / slot / refusal gates; optional semantic score as a feature only |
| `optimizer.mjs` | Lexical / semantic / capacity / full variants; bounded branch-and-bound for capacitated packing |

Embedding models are **optional inputs**. Pass `semanticScores` if you have vectors; omit them for pure lexical matching.

## Install

```bash
git clone https://github.com/2365274664/archipela-matching.git
cd archipela-matching
node --test
```

No runtime npm dependencies. Node.js ≥ 18.

## Quick API

```js
import { rankCandidates } from './matching.mjs';
import { planAssignments } from './optimizer.mjs';

const request = {
  id: 'r1', authorId: 'u1', title: 'Matplotlib 双轴', description: '刻度对不齐',
  tags: ['Python', 'Matplotlib'], category: '数据可视化', mode: '线上', duration: 20,
  availability: ['周三晚间', '周五晚间'], status: 'open',
};
const profiles = [{
  id: 'h1', skills: ['Python', 'Matplotlib'], helpScope: ['数据可视化'],
  capacity: 2, modes: ['线上'], availableSlots: ['周三晚间', '周五晚间'],
}];

const ranked = rankCandidates(request, profiles, [], { limit: 5 });
const plan = planAssignments([request], profiles, [], { variant: 'full' });
// plan.assignments are suggestions; plan.diagnostics.producesInvitations === false
```

### Optional semantic feature

```js
const ranked = rankCandidates(request, profiles, [], {
  semanticReady: true,
  semanticScores: { h1: 0.82 }, // cosine similarity in [-1, 1]
  threshold: 0.55,
  weights: { semantic: 0.8 },
});
```

### Planner variants

- `lexical` — keyword gates only  
- `semantic` — hybrid relevance, no fairness/contact terms  
- `capacity` — global search with capacity packing  
- `full` — coverage + relevance + fairness + contact cost (default)

## Safety properties (tested)

- Semantic recall cannot invent undeclared expertise without a score ≥ threshold  
- Scope, capacity, slot conflict, and helper refusal remain hard gates  
- Planner never mutates input records and never creates invitations  
- Truncated searches never claim `optimal: true`

## License

MIT — see `LICENSE`. Upstream model attribution guidance — see `NOTICE`.

## Maintenance

- Issues and PRs welcome on this repository  
- Versioning follows semver for exported function behavior  
- Matching logic stays dependency-free so it can be vendored into desktop or server hosts
