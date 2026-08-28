// Fit Engine skill matching — TRUE ALIASES vs DIRECTIONAL HIERARCHIES.
//
// TRUE ALIASES: interchangeable synonyms (k8s ↔ kubernetes). Canonicalized
// to one term; satisfying either satisfies the other.
//
// HIERARCHIES: specific technology IMPLIES the general concept, never the
// reverse. GKE → Kubernetes, but Kubernetes -/→ GKE. Terraform → IaC, but
// IaC -/→ Terraform. Lambda → AWS, but AWS -/→ Lambda. PyTorch → ML, but
// ML -/→ PyTorch.
//
// Matching rule: candidate skill S covers required skill R iff
//   canonical(S) == canonical(R)          (true alias)
//   OR S is a known SPECIFIC of R         (hierarchy: S → R)

/** True synonyms only — NEVER hierarchy entries. */
export const SKILL_ALIASES: Record<string, string[]> = {
  kubernetes: ['k8s', 'kube'],
  'amazon web services': ['aws'],
  'google cloud platform': ['gcp'],
  'microsoft azure': ['azure'],
  'continuous integration': ['ci', 'cicd', 'ci/cd'],
  'continuous delivery': ['cd', 'cicd', 'ci/cd'],
  'infrastructure as code': ['iac'],
  'java script': ['javascript', 'js'],
  typescript: ['ts'],
  'machine learning': ['ml'],
  'artificial intelligence': ['ai'],
  'site reliability': ['sre'],
  'security operations': ['secops', 'soc'],
  containers: ['containerization', 'container'],
};

/**
 * Directional hierarchy: the KEY is the general concept; the VALUE list is
 * the SPECIFIC technologies that imply it. Never the reverse.
 *   GKE/EKS/AKS/OpenShift → Kubernetes
 *   Terraform/Pulumi/CloudFormation → Infrastructure as Code
 *   Lambda/S3/EC2/... → AWS
 *   PyTorch/TensorFlow → Machine Learning
 *   GitLab CI/GitHub Actions/Jenkins → CI/CD
 *   Prometheus/Grafana/Datadog → Monitoring
 *   PostgreSQL/MySQL → SQL/Database
 */
export const SKILL_IMPLIES: Record<string, string[]> = {
  kubernetes: ['gke', 'eks', 'aks', 'openshift'],
  'amazon web services': ['ec2', 's3', 'lambda', 'eks', 'rds', 'cloudformation', 'iam', 'cloudwatch'],
  'google cloud platform': ['gke', 'bigquery', 'cloud run'],
  'microsoft azure': ['azure devops', 'aks'],
  'infrastructure as code': ['terraform', 'pulumi', 'cloudformation', 'ansible'],
  'machine learning': ['pytorch', 'tensorflow', 'scikit-learn', 'keras', 'xgboost'],
  'artificial intelligence': ['llm', 'rag', 'openai', 'gpt', 'langchain'],
  'continuous integration': ['gitlab ci', 'gitlab', 'github actions', 'github', 'jenkins', 'circleci', 'travis'],
  'continuous delivery': ['gitlab ci', 'gitlab', 'github actions', 'github', 'jenkins', 'argo', 'spinnaker'],
  monitoring: ['prometheus', 'grafana', 'datadog', 'new relic', 'cloudwatch', 'splunk'],
  sql: ['postgresql', 'postgres', 'mysql', 'sqlite', 'mariadb'],
  containers: ['docker', 'containerd', 'podman'],
  'model serving': ['triton', 'sagemaker', 'mlflow', 'torchserve'],
  'llm engineering': ['rag', 'langchain', 'llamaindex', 'openai api', 'vector database', 'embeddings'],
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

function tokenPresent(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

/** Does candidate evidence (as skills list) cover this required skill? */
export function skillCovered(requiredSkill: string, candidateSkills: string[]): { covered: boolean; by?: string } {
  const req = canonicalizeSkill(requiredSkill);
  if (!req) return { covered: false };
  const rawReq = String(requiredSkill || '').toLowerCase().trim();
  const cand = candidateSkills.map((c) => canonicalizeSkill(c)).filter(Boolean);
  // 1. True alias: the same canonical term present (exact or word-boundary
  //    token — "kubernetes clusters" still evidences kubernetes). Both the
  //    canonical form AND the raw term are token-tested (a raw "ci/cd"
  //    mention must satisfy a canonicalized "continuous integration").
  const hitAlias = (term: string) => cand.some((c) => c === term || tokenPresent(c, term));
  if (hitAlias(req) || (rawReq && hitAlias(rawReq))) return { covered: true, by: rawReq || req };
  // 2. Hierarchy: candidate holds a SPECIFIC that implies the requirement.
  const specifics = SKILL_IMPLIES[req] || [];
  for (const spec of specifics) {
    if (hitAlias(spec)) return { covered: true, by: spec };
  }
  return { covered: false };
}