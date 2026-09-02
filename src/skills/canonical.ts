/**
 * The canonical skill vocabulary.
 *
 * This is a *normalisation* table, not an allow-list. Its job is to collapse
 * the many spellings of a known skill onto one slug and give it a category, so
 * that "Postgres", "PostgreSQL" and "psql" all count as one match rather than
 * three misses. Skills absent from this table still flow through the pipeline —
 * they simply arrive uncategorised, which the matcher handles.
 *
 * Categories exist because they change how a match should be read. Missing a
 * `language` is a different kind of gap from missing a `domain`, and the
 * profile view groups by them.
 */

export const SKILL_CATEGORIES = [
  "language",
  "framework",
  "datastore",
  "cloud",
  "practice",
  "domain",
  "tool",
  "other",
] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export interface CanonicalSkill {
  /** Lowercase slug used as the key everywhere. */
  slug: string;
  /** Display form, as a person would write it. */
  label: string;
  category: SkillCategory;
  /** Other spellings that resolve to this slug. */
  aliases?: string[];
}

/**
 * Skill names that are also ordinary English words.
 *
 * Matching these on sight produces confident nonsense: a go-to-market
 * operations posting reading "Go beyond code — help users set up their teams"
 * was credited with the Go programming language and ranked top of the list.
 * The extractor requires supporting context before accepting any of these,
 * rather than dropping them — plenty of postings do mean the language.
 */
export const AMBIGUOUS_SLUGS: ReadonlySet<string> = new Set([
  "go",
  "c",
  "r",
  "rust",
  "swift",
  "dart",
  "spark",
  "kong",
  "agile",
  "performance",
  "security",
  "testing",
  "identity",
  "caching",
]);

/* Written as compact tuples to keep several hundred entries readable:
   [slug, label, category, ...aliases] */
type Row = [string, string, SkillCategory, ...string[]];

const ROWS: Row[] = [
  // ── languages ────────────────────────────────────────────────────
  ["java", "Java", "language", "java8", "java 8", "java11", "core java"],
  ["python", "Python", "language", "python3", "py"],
  ["javascript", "JavaScript", "language", "js", "es6", "ecmascript"],
  ["typescript", "TypeScript", "language", "ts"],
  ["go", "Go", "language", "golang"],
  ["rust", "Rust", "language"],
  ["c", "C", "language"],
  ["cpp", "C++", "language", "c++", "cplusplus"],
  ["csharp", "C#", "language", "c#", "c sharp", "dotnet c#"],
  ["ruby", "Ruby", "language"],
  ["php", "PHP", "language"],
  ["scala", "Scala", "language"],
  ["kotlin", "Kotlin", "language"],
  ["swift", "Swift", "language"],
  ["objective-c", "Objective-C", "language", "objc"],
  ["sql", "SQL", "language", "t-sql", "pl/sql", "plsql"],
  ["bash", "Bash", "language", "shell", "shell scripting", "sh"],
  ["r", "R", "language"],
  ["perl", "Perl", "language"],
  ["elixir", "Elixir", "language"],
  ["clojure", "Clojure", "language"],
  ["haskell", "Haskell", "language"],
  ["dart", "Dart", "language"],
  ["lua", "Lua", "language"],
  ["solidity", "Solidity", "language"],

  // ── frameworks and runtimes ──────────────────────────────────────
  ["spring", "Spring", "framework", "spring framework"],
  ["spring-boot", "Spring Boot", "framework", "springboot", "spring.boot"],
  ["hibernate", "Hibernate", "framework", "jpa"],
  ["node", "Node.js", "framework", "nodejs", "node js", "node.js"],
  ["express", "Express", "framework", "expressjs", "express.js"],
  ["nestjs", "NestJS", "framework", "nest.js", "nest"],
  ["react", "React", "framework", "reactjs", "react.js"],
  ["nextjs", "Next.js", "framework", "next.js", "next js"],
  ["vue", "Vue", "framework", "vuejs", "vue.js"],
  ["angular", "Angular", "framework", "angularjs", "angular.js"],
  ["svelte", "Svelte", "framework", "sveltekit"],
  ["django", "Django", "framework"],
  ["flask", "Flask", "framework"],
  ["fastapi", "FastAPI", "framework"],
  ["rails", "Ruby on Rails", "framework", "ruby on rails", "ror"],
  ["laravel", "Laravel", "framework"],
  ["dotnet", ".NET", "framework", ".net", "asp.net", "aspnet", "dot net"],
  ["react-native", "React Native", "framework", "react-native"],
  ["flutter", "Flutter", "framework"],
  ["tailwind", "Tailwind CSS", "framework", "tailwindcss"],
  ["graphql", "GraphQL", "framework"],
  ["grpc", "gRPC", "framework"],
  ["rest", "REST", "framework", "restful", "rest api", "restful api", "rest apis"],

  // ── datastores and streaming ─────────────────────────────────────
  ["postgresql", "PostgreSQL", "datastore", "postgres", "psql", "postgre sql"],
  ["mysql", "MySQL", "datastore", "my sql"],
  ["oracle", "Oracle", "datastore", "oracle db", "oracle database"],
  ["sqlserver", "SQL Server", "datastore", "mssql", "microsoft sql server"],
  ["sqlite", "SQLite", "datastore"],
  ["mongodb", "MongoDB", "datastore", "mongo"],
  ["redis", "Redis", "datastore"],
  ["cassandra", "Cassandra", "datastore"],
  ["dynamodb", "DynamoDB", "datastore", "dynamo"],
  ["elasticsearch", "Elasticsearch", "datastore", "elastic search", "opensearch"],
  ["kafka", "Kafka", "datastore", "apache kafka", "event streaming"],
  ["rabbitmq", "RabbitMQ", "datastore", "rabbit mq", "amqp"],
  ["snowflake", "Snowflake", "datastore"],
  ["bigquery", "BigQuery", "datastore", "big query"],
  ["clickhouse", "ClickHouse", "datastore"],
  ["neo4j", "Neo4j", "datastore"],

  // ── cloud and infrastructure ─────────────────────────────────────
  ["aws", "AWS", "cloud", "amazon web services"],
  ["azure", "Azure", "cloud", "microsoft azure"],
  ["gcp", "GCP", "cloud", "google cloud", "google cloud platform"],
  ["docker", "Docker", "cloud", "containers", "containerisation", "containerization"],
  ["kubernetes", "Kubernetes", "cloud", "k8s", "eks", "gke", "aks"],
  ["terraform", "Terraform", "cloud", "hcl"],
  ["ansible", "Ansible", "cloud"],
  ["helm", "Helm", "cloud"],
  ["jenkins", "Jenkins", "cloud"],
  ["github-actions", "GitHub Actions", "cloud", "gh actions"],
  ["gitlab-ci", "GitLab CI", "cloud", "gitlab ci/cd"],
  ["prometheus", "Prometheus", "cloud"],
  ["grafana", "Grafana", "cloud"],
  ["datadog", "Datadog", "cloud", "data dog"],
  ["nginx", "Nginx", "cloud"],
  ["kong", "Kong", "cloud"],
  ["serverless", "Serverless", "cloud", "lambda", "aws lambda", "cloud functions"],
  ["linux", "Linux", "cloud", "unix"],

  // ── practices ────────────────────────────────────────────────────
  ["distributed-systems", "Distributed systems", "practice", "distributed system"],
  ["microservices", "Microservices", "practice", "microservice", "micro services"],
  ["api-design", "API design", "practice", "api development", "api architecture"],
  ["system-design", "System design", "practice", "systems design"],
  ["testing", "Testing", "practice", "unit testing", "automated testing", "tdd", "bdd"],
  ["ci-cd", "CI/CD", "practice", "ci/cd", "cicd", "continuous integration", "continuous delivery"],
  ["agile", "Agile", "practice", "scrum", "kanban"],
  ["code-review", "Code review", "practice"],
  ["observability", "Observability", "practice", "monitoring", "telemetry"],
  ["performance", "Performance engineering", "practice", "performance tuning", "optimisation"],
  ["security", "Security", "practice", "appsec", "application security"],
  ["sre", "SRE", "practice", "site reliability", "sre practices", "reliability engineering"],
  ["event-driven", "Event-driven architecture", "practice", "eda", "event driven"],
  ["caching", "Caching", "practice"],
  ["data-modelling", "Data modelling", "practice", "data modeling", "schema design"],
  ["machine-learning", "Machine learning", "practice", "ml", "deep learning"],
  ["mlops", "MLOps", "practice"],
  ["etl", "ETL", "practice", "elt", "data pipelines"],

  // ── domains ──────────────────────────────────────────────────────
  ["payments", "Payments", "domain", "payment systems", "payment processing", "payment gateway"],
  ["ledgers", "Ledgers", "domain", "ledger", "double entry", "general ledger"],
  ["settlement", "Settlement", "domain", "reconciliation", "settlements"],
  ["card-networks", "Card networks", "domain", "visa", "mastercard", "card processing"],
  ["pci", "PCI compliance", "domain", "pci-dss", "pci dss"],
  ["fintech", "Fintech", "domain", "financial services", "banking"],
  ["lending", "Lending", "domain", "credit", "underwriting"],
  ["fraud", "Fraud detection", "domain", "risk", "aml", "kyc"],
  ["ecommerce", "E-commerce", "domain", "e-commerce", "commerce"],
  ["healthcare", "Healthcare", "domain", "healthtech"],
  ["gaming", "Gaming", "domain", "games"],
  ["adtech", "Adtech", "domain", "advertising"],
  ["identity", "Identity", "domain", "iam", "authentication", "authorization", "oauth", "sso"],

  // ── tools ────────────────────────────────────────────────────────
  ["git", "Git", "tool", "github", "gitlab", "version control"],
  ["jira", "Jira", "tool"],
  ["maven", "Maven", "tool"],
  ["gradle", "Gradle", "tool"],
  ["webpack", "Webpack", "tool"],
  ["vite", "Vite", "tool"],
  ["tomcat", "Tomcat", "tool", "apache tomcat", "apachetomcat"],
  ["weblogic", "WebLogic", "tool"],
  ["kibana", "Kibana", "tool"],
  ["airflow", "Airflow", "tool", "apache airflow"],
  ["spark", "Spark", "tool", "apache spark", "pyspark"],
  ["hadoop", "Hadoop", "tool"],
  ["pandas", "pandas", "tool"],
  ["numpy", "NumPy", "tool"],
  ["pytorch", "PyTorch", "tool"],
  ["tensorflow", "TensorFlow", "tool"],
];

export const CANONICAL_SKILLS: readonly CanonicalSkill[] = ROWS.map(
  ([slug, label, category, ...aliases]) => ({ slug, label, category, aliases }),
);

/** slug → skill */
export const BY_SLUG: ReadonlyMap<string, CanonicalSkill> = new Map(
  CANONICAL_SKILLS.map((s) => [s.slug, s]),
);

/**
 * Every spelling that resolves to a slug, including the slug and label.
 *
 * Built once at module load. A later alias learned from a job posting is added
 * to the database, not here — this table is the shipped baseline.
 */
export const ALIAS_TO_SLUG: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const skill of CANONICAL_SKILLS) {
    map.set(skill.slug, skill.slug);
    map.set(skill.label.toLowerCase(), skill.slug);
    for (const alias of skill.aliases ?? []) map.set(alias.toLowerCase(), skill.slug);
  }
  return map;
})();

/**
 * Every way this skill might be written.
 *
 * Needed because depth is judged by how often a skill is described, and the
 * extractor scans longest-alias-first. "Payment systems" wins the match over
 * "payments", so counting only the matched phrase reads 1 mention where the
 * résumé has 3 — and rates a career speciality as passing exposure.
 */
export function spellingsOf(slug: string): string[] {
  const skill = BY_SLUG.get(slug);
  if (!skill) return [slug];
  const all = new Set<string>([skill.label.toLowerCase(), ...(skill.aliases ?? [])]);
  if (!skill.slug.includes("-")) all.add(skill.slug);
  return [...all];
}

export function categoryOf(slug: string): SkillCategory {
  return BY_SLUG.get(slug)?.category ?? "other";
}

export function labelOf(slug: string): string {
  return BY_SLUG.get(slug)?.label ?? slug;
}
