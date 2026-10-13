// Deterministic skill taxonomy for the Master CV: display casing + canonical
// placement. Service names belong in service/tooling sections ("EC2, VPC, S3"
// are AWS SERVICES, not cloud providers); practices belong in a practices
// section ("SLO", "on-call", "distributed systems" are NOT tools).
//
// Used by market enrichment (auto-placement of new skills) and by the
// skill organizer (repair/reorganization of the existing CV).

export const CANONICAL_BUCKETS = {
  awsServices: 'AWS Services',
  gcpServices: 'GCP Services',
  azureServices: 'Azure Services',
  databases: 'Databases & Data Stores',
  networking: 'Networking',
  practices: 'Site Reliability Practices',
  securityPractices: 'Security Practices',
  systems: 'Systems & OS',
} as const;

// Provider services belong together per provider (never mixed into the
// provider-platform list). Managed-K8s (EKS/GKE/AKS) stays in the CV's
// Containers section; security/IaC/CI-CD/AI provider services stay in their
// specialized sections.
const AWS_SERVICE_ITEMS = new Set([
  'ec2', 'vpc', 's3', 'rds', 'dynamodb', 'lambda', 'sqs', 'sns', 'route 53', 'route53',
  'cloudfront', 'ecr', 'efs', 'aurora', 'elasticache', 'direct connect', 'elb', 'alb', 'nlb',
]);

const GCP_SERVICE_ITEMS = new Set([
  'bigquery', 'cloud run', 'cloud functions', 'cloud storage', 'gcs', 'pub/sub', 'pubsub',
  'cloud build', 'cloud deploy', 'cloud sql', 'cloud spanner', 'cloud dns', 'cloud cdn',
  'cloud armor', 'cloud kms', 'cloud logging', 'cloud monitoring', 'firestore', 'dataflow',
  'dataproc', 'vertex ai', 'artifact registry', 'secret manager', 'memorystore', 'anthos',
  'cloud scheduler', 'cloud tasks', 'cloud composer', 'datastream', 'looker',
]);

const AZURE_SERVICE_ITEMS = new Set([
  'azure functions', 'app service', 'azure sql', 'cosmos db', 'cosmosdb', 'blob storage',
  'azure blob', 'azure storage', 'entra id', 'azure ad', 'key vault', 'front door',
  'vnet', 'virtual network', 'expressroute', 'logic apps', 'event hubs', 'service bus',
  'azure service bus', 'azure cache', 'azure container apps', 'azure arc', 'azure backup',
  'azure site recovery', 'azure firewall', 'azure bastion', 'azure policy', 'azure synapse',
]);

const DATABASE_ITEMS = new Set([
  'postgresql', 'postgres', 'mysql', 'mongodb', 'sql', 'nosql', 'kafka', 'redis', 'memcached',
  'snowflake', 'database', 'databases', 'sql server',
]);

const NETWORKING_ITEMS = new Set([
  'dns', 'vpn', 'networking', 'tcp/ip', 'load balancing', 'load balancers', 'cdn',
  'network policies', 'nginx', 'haproxy',
]);

const PRACTICE_ITEMS = new Set([
  'slo', 'sli', 'slos', 'on-call', 'on-call rotation', 'error budgets', 'toil reduction',
  'distributed systems', 'capacity planning', 'disaster recovery', 'high availability',
  'chaos engineering', 'cost optimization', 'change management', 'rollback', 'incident response',
]);

const SECURITY_PRACTICE_ITEMS = new Set([
  'threat modeling', 'penetration testing', 'red team', 'blue team', 'vulnerability management',
  'secure sdlc', 'secure code review', 'security architecture', 'risk assessment',
]);

const SYSTEM_ITEMS = new Set(['linux', 'windows', 'operating systems', 'unix', 'macos']);

/** Canonical bucket name for an item, or null when it is not bucketable. */
export function classifySkillBucket(raw: string): string | null {
  const key = String(raw || '').toLowerCase().trim();
  if (!key) return null;
  if (AWS_SERVICE_ITEMS.has(key)) return CANONICAL_BUCKETS.awsServices;
  if (GCP_SERVICE_ITEMS.has(key)) return CANONICAL_BUCKETS.gcpServices;
  if (AZURE_SERVICE_ITEMS.has(key)) return CANONICAL_BUCKETS.azureServices;
  if (DATABASE_ITEMS.has(key)) return CANONICAL_BUCKETS.databases;
  if (NETWORKING_ITEMS.has(key)) return CANONICAL_BUCKETS.networking;
  if (SECURITY_PRACTICE_ITEMS.has(key)) return CANONICAL_BUCKETS.securityPractices;
  if (PRACTICE_ITEMS.has(key)) return CANONICAL_BUCKETS.practices;
  if (SYSTEM_ITEMS.has(key)) return CANONICAL_BUCKETS.systems;
  return null;
}

// Display overrides for names a title-caser would get wrong.
const DISPLAY_OVERRIDES: Record<string, string> = {
  ec2: 'EC2', vpc: 'VPC', s3: 'S3', rds: 'RDS', dns: 'DNS', vpn: 'VPN', sqs: 'SQS', sns: 'SNS',
  dynamodb: 'DynamoDB', aurora: 'Aurora',
  slo: 'SLO', sli: 'SLI', slos: 'SLOs', apm: 'APM', elk: 'ELK', siem: 'SIEM', owasp: 'OWASP',
  sql: 'SQL', mysql: 'MySQL', postgresql: 'PostgreSQL', postgres: 'Postgres', mongodb: 'MongoDB', nosql: 'NoSQL',
  'sql server': 'SQL Server',
  'aws cdk': 'AWS CDK', 'aws config': 'AWS Config', 'aws kms': 'AWS KMS', 'aws organizations': 'AWS Organizations',
  'aws secrets manager': 'AWS Secrets Manager', 'aws codepipeline': 'AWS CodePipeline', codepipeline: 'CodePipeline',
  'route 53': 'Route 53', route53: 'Route 53', cloudfront: 'CloudFront', cloudtrail: 'CloudTrail',
  cloudwatch: 'CloudWatch', guardduty: 'GuardDuty', 'security hub': 'Security Hub',
  'direct connect': 'Direct Connect', efs: 'EFS', ecr: 'ECR', elb: 'ELB', alb: 'ALB', nlb: 'NLB',
  'github copilot': 'GitHub Copilot', 'azure devops': 'Azure DevOps', 'azure monitor': 'Azure Monitor',
  'new relic': 'New Relic', linux: 'Linux', windows: 'Windows', nexus: 'Nexus', nginx: 'NGINX',
  javascript: 'JavaScript', podman: 'Podman', rancher: 'Rancher', flux: 'Flux', teamcity: 'TeamCity', openshift: 'OpenShift',
  elasticache: 'ElastiCache', kafka: 'Kafka', redis: 'Redis', memcached: 'Memcached', snowflake: 'Snowflake',
  elasticsearch: 'Elasticsearch', kibana: 'Kibana', loki: 'Loki', splunk: 'Splunk', datadog: 'Datadog',
  opentelemetry: 'OpenTelemetry', sentry: 'Sentry', 'on-call': 'On-Call', 'on-call rotation': 'On-Call Rotation',
  'toil reduction': 'Toil Reduction', 'cost optimization': 'Cost Optimization', 'capacity planning': 'Capacity Planning',
  'disaster recovery': 'Disaster Recovery', 'high availability': 'High Availability', 'change management': 'Change Management',
  'distributed systems': 'Distributed Systems', 'error budgets': 'Error Budgets', 'chaos engineering': 'Chaos Engineering',
  'load balancing': 'Load Balancing', 'load balancers': 'Load Balancers', 'tcp/ip': 'TCP/IP', cdn: 'CDN',
  'network policies': 'Network Policies', 'threat modeling': 'Threat Modeling', 'penetration testing': 'Penetration Testing',
  'incident response': 'Incident Response', rollback: 'Rollback', networking: 'Networking',
  go: 'Go', golang: 'Golang', java: 'Java', ruby: 'Ruby', rust: 'Rust', swift: 'Swift', kotlin: 'Kotlin',
  bash: 'Bash', python: 'Python', iis: 'IIS', nist: 'NIST', hipaa: 'HIPAA', pci: 'PCI',
  // GCP services
  bigquery: 'BigQuery', 'cloud run': 'Cloud Run', 'cloud functions': 'Cloud Functions',
  'cloud storage': 'Cloud Storage', gcs: 'GCS', 'pub/sub': 'Pub/Sub', pubsub: 'Pub/Sub',
  'cloud build': 'Cloud Build', 'cloud deploy': 'Cloud Deploy', 'cloud sql': 'Cloud SQL',
  'cloud spanner': 'Cloud Spanner', 'cloud dns': 'Cloud DNS', 'cloud cdn': 'Cloud CDN',
  'cloud armor': 'Cloud Armor', 'cloud kms': 'Cloud KMS', 'cloud logging': 'Cloud Logging',
  'cloud monitoring': 'Cloud Monitoring', firestore: 'Firestore', dataflow: 'Dataflow',
  dataproc: 'Dataproc', 'vertex ai': 'Vertex AI', 'artifact registry': 'Artifact Registry',
  'secret manager': 'Secret Manager', memorystore: 'Memorystore', anthos: 'Anthos',
  'cloud scheduler': 'Cloud Scheduler', 'cloud tasks': 'Cloud Tasks', 'cloud composer': 'Cloud Composer',
  datastream: 'Datastream', looker: 'Looker',
  // Azure services
  'azure functions': 'Azure Functions', 'app service': 'App Service', 'azure sql': 'Azure SQL',
  'cosmos db': 'Cosmos DB', cosmosdb: 'Cosmos DB', 'blob storage': 'Blob Storage',
  'azure blob': 'Azure Blob Storage', 'azure storage': 'Azure Storage', 'entra id': 'Entra ID',
  'azure ad': 'Azure AD', 'key vault': 'Key Vault', 'front door': 'Front Door', vnet: 'VNet',
  'virtual network': 'Virtual Network', expressroute: 'ExpressRoute', 'logic apps': 'Logic Apps',
  'event hubs': 'Event Hubs', 'service bus': 'Service Bus', 'azure service bus': 'Azure Service Bus',
  'azure cache': 'Azure Cache', 'azure container apps': 'Azure Container Apps', 'azure arc': 'Azure Arc',
  'azure backup': 'Azure Backup', 'azure site recovery': 'Azure Site Recovery', 'azure firewall': 'Azure Firewall',
  'azure bastion': 'Azure Bastion', 'azure policy': 'Azure Policy', 'azure synapse': 'Azure Synapse',
  // security practices
  'red team': 'Red Team', 'blue team': 'Blue Team', 'vulnerability management': 'Vulnerability Management',
  'secure sdlc': 'Secure SDLC', 'secure code review': 'Secure Code Review', 'security architecture': 'Security Architecture',
  'risk assessment': 'Risk Assessment',
};

/** Display casing for a skill: overrides first, otherwise title-case plain
 *  lowercase words while preserving intentional casing (GitHub, Kubernetes). */
export function normalizeSkillDisplay(raw: string): string {
  const t = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!t) return t;
  const override = DISPLAY_OVERRIDES[t.toLowerCase()];
  if (override) return override;
  if (/[A-Z]/.test(t.slice(1))) return t; // already intentional casing
  return t
    .split(' ')
    .map((w) => (w.length > 1 && w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Sane NEW category names a proposal may create (2-4 words). */
export function isSaneCategoryName(name: string): boolean {
  const t = String(name || '').trim();
  if (!t || t.length > 40) return false;
  if (!/^[A-Za-z][A-Za-z0-9&/+ -]*$/.test(t)) return false;
  const words = t.split(/\s+/);
  return words.length >= 1 && words.length <= 4;
}

/** Final category for an item: canonical bucket (existing category with that
 *  name, or the canonical name itself) → LLM suggestion (existing or a sane
 *  new category) → Core Competencies. */
export function resolveSkillCategory(item: string, suggested: string, existingCategories: string[]): string {
  const existing = (existingCategories || []).map((c) => String(c || '').trim()).filter(Boolean);
  const bucket = classifySkillBucket(item);
  if (bucket) {
    const hit = existing.find((c) => c.toLowerCase() === bucket.toLowerCase());
    return hit || bucket;
  }
  const s = String(suggested || '').trim();
  if (s) {
    const hit = existing.find((c) => c.toLowerCase() === s.toLowerCase());
    if (hit) return hit;
    if (isSaneCategoryName(s)) return s;
  }
  return 'Core Competencies';
}

export interface SkillMove {
  item: string;
  from: string;
  to: string;
}

/** Deterministic reorganization of an existing skills section:
 *  - normalizes display casing everywhere;
 *  - moves canonical-bucket items into their proper section (creating the
 *    section when it does not exist);
 *  - removes items that merely repeat their own category name;
 *  - de-duplicates case-insensitively (keeps the first occurrence);
 *  - drops categories that end up empty; Core Competencies sinks to the end. */
export function organizeSkills(skills: Array<{ category: string; items: string[] }> | undefined): {
  skills: Array<{ category: string; items: string[] }>;
  moves: SkillMove[];
} {
  const source = (skills || []).filter((g) => g && g.category);
  const existingNames = source.map((g) => g.category);
  const groups = new Map<string, string[]>(); // canonical key -> [category display]
  const order: string[] = [];
  const ensure = (name: string) => {
    const key = name.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    const display = existingNames.find((n) => n.toLowerCase() === key) || name;
    return display;
  };

  const moves: SkillMove[] = [];
  const seenItems = new Set<string>();
  // Pre-seed source categories (original order) so newly created canonical
  // buckets are appended AFTER the CV's own sections.
  for (const g of source) ensure(g.category);
  // Two passes: place canonical items first (so bucket sections exist), then
  // everything else back into its home category.
  for (const g of source) {
    for (const rawItem of g.items || []) {
      const item = normalizeSkillDisplay(rawItem);
      const itemKey = item.toLowerCase();
      if (!itemKey || seenItems.has(itemKey)) continue;
      const bucket = classifySkillBucket(item);
      if (bucket) {
        if (itemKey === bucket.toLowerCase()) continue; // redundant: category already says it
        seenItems.add(itemKey);
        const target = ensure(bucket);
        groups.get(target.toLowerCase())!.push(item);
        if (target.toLowerCase() !== g.category.toLowerCase()) moves.push({ item, from: g.category, to: target });
      }
    }
  }
  for (const g of source) {
    for (const rawItem of g.items || []) {
      const item = normalizeSkillDisplay(rawItem);
      const itemKey = item.toLowerCase();
      if (!itemKey || seenItems.has(itemKey)) continue;
      if (classifySkillBucket(item)) continue;
      if (itemKey === g.category.toLowerCase()) continue; // redundant
      seenItems.add(itemKey);
      const target = ensure(g.category);
      groups.get(target.toLowerCase())!.push(item);
    }
  }

  // Rebuild in order: original categories first (minus Core Competencies),
  // new buckets appended, Core Competencies last when non-empty.
  const built: Array<{ category: string; items: string[] }> = [];
  const keyOrder = [...order].sort((a, b) => {
    const aCore = a === 'core competencies' ? 1 : 0;
    const bCore = b === 'core competencies' ? 1 : 0;
    return aCore - bCore;
  });
  for (const key of keyOrder) {
    const items = groups.get(key)!;
    if (!items.length) continue;
    const display = existingNames.find((n) => n.toLowerCase() === key) || orderDisplay(key);
    built.push({ category: display, items });
  }
  return { skills: built, moves };
}

function orderDisplay(key: string): string {
  const canonical = Object.values(CANONICAL_BUCKETS).find((b) => b.toLowerCase() === key);
  if (canonical) return canonical;
  return key
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}
