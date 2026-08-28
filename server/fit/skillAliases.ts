// Fit Engine skill canonicalization — explicit, directional alias map.
// No vector DB, no embeddings. Aliases are directional where the semantics
// demand it: GKE/ EKS imply Kubernetes, but Kubernetes does NOT imply GKE.

export const SKILL_ALIASES: Record<string, string[]> = {
  kubernetes: ['k8s', 'kube'],
  'amazon web services': ['aws'],
  'google cloud platform': ['gcp'],
  'microsoft azure': ['azure'],
  'continuous integration': ['ci', 'cicd', 'ci/cd', 'continuous delivery'],
  'continuous delivery': ['cd', 'cicd', 'ci/cd'],
  'infrastructure as code': ['iac', 'terraform'],
  'java script': ['javascript', 'js'],
  typescript: ['ts'],
  'machine learning': ['ml'],
  'artificial intelligence': ['ai'],
  'site reliability': ['sre'],
  'security operations': ['secops'],
};

// Directional implications: skill A (value) implies skill B (key), but NOT
// vice versa. GKE → Kubernetes, but Kubernetes !→ GKE.
export const SKILL_IMPLIES: Record<string, string[]> = {
  kubernetes: ['gke', 'eks', 'aks', 'openshift'],
  'amazon web services': ['ec2', 's3', 'lambda', 'eks', 'rds', 'cloudformation', 'iam'],
  'google cloud platform': ['gke', 'bigquery', 'cloud run'],
  'microsoft azure': ['azure devops', 'aks'],
  terraform: ['iac', 'hcl'],
  'machine learning': ['tensorflow', 'pytorch', 'scikit-learn'],
  'artificial intelligence': ['llm', 'openai', 'gpt'],
  docker: ['docker compose', 'docker swarm'],
};

export function canonicalizeSkill(raw: string): string {
  const s = String(raw || '').toLowerCase().trim().replace(/[()]/g, '').replace(/\s+/g, ' ');
  if (!s) return s;
  for (const [canonical, aliases] of Object.entries(SKILL_ALIASES)) {
    if (s === canonical) return canonical;
    if (aliases.some((a) => s === a)) return canonical;
  }
  return s;
}

/** Does candidate evidence (as skills list) cover this required skill? */
export function skillCovered(requiredSkill: string, candidateSkills: string[]): { covered: boolean; by?: string } {
  const req = canonicalizeSkill(requiredSkill);
  if (!req) return { covered: false };
  const cand = candidateSkills.map(canonicalizeSkill).filter(Boolean);
  if (cand.includes(req)) return { covered: true, by: req };
  const implies = SKILL_IMPLIES[req] || [];
  for (const impl of implies) {
    if (cand.includes(impl)) return { covered: true, by: impl };
  }
  return { covered: false };
}