// Test-only funnel for sibling fixtures, kept separate from cli/core.mjs so the
// shipped barrel never drags tools/ into the published import graph. Repointed
// at graduation the same way core.mjs is.
export { buildMixtape } from '../../tools/mixtape.mjs';
