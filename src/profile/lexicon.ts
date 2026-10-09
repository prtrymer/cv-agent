/**
 * Technology lexicon used to ground generated text: anything recognised here must be claimable
 * in the scope it appears in, so the model cannot quietly introduce a stack item.
 * [id, label, pattern, 'cs' for case-sensitive]
 */
type Raw = [string, string, string] | [string, string, string, 'cs'];

const RAW: Raw[] = [
  ['typescript', 'TypeScript', 'TypeScript'], ['typescript', 'TypeScript', 'TS', 'cs'],
  ['javascript', 'JavaScript', 'JavaScript'], ['javascript', 'JavaScript', 'JS', 'cs'],
  ['nodejs', 'Node.js', 'Node\\.?js|NodeJS'], ['nodejs', 'Node.js', 'Node', 'cs'],
  ['nestjs', 'NestJS', 'NestJS|Nest\\.js'], ['nestjs', 'NestJS', 'Nest', 'cs'],
  ['react-native', 'React Native', 'React Native'], ['react', 'React', 'React'],
  ['nextjs', 'Next.js', 'Next\\.?js'], ['angular-material', 'Angular Material', 'Angular Material'],
  ['angularjs', 'AngularJS', 'AngularJS'], ['angular', 'Angular', 'Angular'],
  ['vue', 'Vue', 'Vue(?:\\.?js)?'], ['nuxt', 'Nuxt', 'Nuxt(?:\\.?js)?'], ['svelte', 'Svelte', 'Svelte(?:Kit)?'],
  ['solidjs', 'SolidJS', 'SolidJS'], ['remix', 'Remix', 'Remix', 'cs'], ['astro', 'Astro', 'Astro', 'cs'],
  ['redux', 'Redux', 'Redux(?: Toolkit)?|RTK'], ['mobx', 'MobX', 'MobX'], ['zustand', 'Zustand', 'Zustand'],
  ['tanstack', 'TanStack', 'TanStack(?: Query| Table)?|React Query'], ['react-hook-form', 'React Hook Form', 'React Hook Form'],
  ['zod', 'Zod', 'Zod', 'cs'], ['rxjs', 'RxJS', 'RxJS'],
  ['tailwind', 'Tailwind', 'Tailwind(?: ?CSS)?'], ['styled-components', 'styled-components', 'styled[- ]components'],
  ['css-modules', 'CSS Modules', 'CSS Modules'], ['scss', 'SCSS', 'SCSS|Sass'], ['shadcn', 'shadcn/ui', 'shadcn(?:/ui)?'],
  ['mui', 'MUI', 'MUI|Material[- ]UI'], ['bootstrap', 'Bootstrap', 'Bootstrap', 'cs'],
  ['vite', 'Vite', 'Vite', 'cs'], ['webpack', 'Webpack', 'Webpack'], ['esbuild', 'esbuild', 'esbuild'], ['turbopack', 'Turbopack', 'Turbopack'],
  ['jest', 'Jest', 'Jest', 'cs'], ['vitest', 'Vitest', 'Vitest'], ['cypress', 'Cypress', 'Cypress'],
  ['playwright', 'Playwright', 'Playwright'], ['selenium', 'Selenium', 'Selenium'], ['puppeteer', 'Puppeteer', 'Puppeteer'],
  ['storybook', 'Storybook', 'Storybook'], ['junit', 'JUnit', 'JUnit'], ['mockito', 'Mockito', 'Mockito'],
  ['assertj', 'AssertJ', 'AssertJ'], ['testcontainers', 'Testcontainers', 'Testcontainers'], ['tdd', 'TDD', 'TDD', 'cs'],
  ['java', 'Java', 'Java', 'cs'],
  ['spring', 'Spring', 'Spring(?: Boot| MVC| Data(?: JPA)?| Security| Cloud)?(?: 3)?', 'cs'],
  ['hibernate', 'Hibernate', 'Hibernate|JPA', 'cs'], ['maven', 'Maven', 'Maven'], ['gradle', 'Gradle', 'Gradle'],
  ['lombok', 'Lombok', 'Lombok'], ['mapstruct', 'MapStruct', 'MapStruct'], ['thymeleaf', 'Thymeleaf', 'Thymeleaf'],
  ['jsoup', 'JSoup', 'JSoup'], ['bean-validation', 'Bean Validation', 'Bean Validation'],
  ['kotlin', 'Kotlin', 'Kotlin'], ['scala', 'Scala', 'Scala', 'cs'],
  ['golang', 'Go', 'Golang'], ['golang', 'Go', 'Go(?=\\s*(?:[/,)+]|developer|engineer|lang|language|services?|microservices?|backend|and |or ))', 'cs'],
  ['rust', 'Rust', 'Rust', 'cs'], ['tokio', 'Tokio', 'Tokio'], ['python', 'Python', 'Python'],
  ['django', 'Django', 'Django'], ['flask', 'Flask', 'Flask'], ['fastapi', 'FastAPI', 'FastAPI'],
  ['ruby', 'Ruby', 'Ruby(?: on Rails)?'], ['rails', 'Rails', 'Rails', 'cs'], ['php', 'PHP', 'PHP'],
  ['laravel', 'Laravel', 'Laravel'], ['symfony', 'Symfony', 'Symfony'],
  ['dotnet', '.NET', '\\.NET|ASP\\.NET|C#'], ['cpp', 'C++', 'C\\+\\+'], ['swift', 'Swift', 'Swift', 'cs'],
  ['flutter', 'Flutter', 'Flutter'], ['dart', 'Dart', 'Dart', 'cs'],
  ['elixir', 'Elixir', 'Elixir'], ['phoenix', 'Phoenix', 'Phoenix', 'cs'], ['ecto', 'Ecto', 'Ecto'],
  ['otp', 'OTP', 'OTP', 'cs'], ['erlang', 'Erlang', 'Erlang'],
  ['express', 'Express.js', 'Express\\.?js'], ['express', 'Express.js', 'Express(?=\\s*(?:[/,)]|services?|backend|APIs?))', 'cs'],
  ['fastify', 'Fastify', 'Fastify'], ['koa', 'Koa', 'Koa', 'cs'], ['hono', 'Hono', 'Hono', 'cs'],
  ['hapi', 'Hapi', 'Hapi(?:\\.js)?|hapi\\.js', 'cs'], ['adonisjs', 'AdonisJS', 'Adonis(?:\\.?JS)?', 'cs'],
  ['graphql', 'GraphQL', 'GraphQL'], ['apollo', 'Apollo', 'Apollo', 'cs'], ['trpc', 'tRPC', 'tRPC'],
  ['grpc', 'gRPC', 'gRPC'], ['protobuf', 'Protobuf', 'Protobuf|Protocol Buffers'],
  ['socketio', 'Socket.IO', 'Socket\\.IO'], ['websocket', 'WebSocket', 'WebSockets?'],
  ['postgres', 'PostgreSQL', 'PostgreSQL|Postgres'], ['mysql', 'MySQL', 'MySQL'], ['mariadb', 'MariaDB', 'MariaDB'],
  ['sqlite', 'SQLite', 'SQLite'], ['mongodb', 'MongoDB', 'MongoDB'], ['mongodb', 'MongoDB', 'Mongo', 'cs'],
  ['redis', 'Redis', 'Redis'], ['valkey', 'Valkey', 'Valkey'],
  ['elasticsearch', 'Elasticsearch', 'Elasticsearch|Elastic Search'], ['opensearch', 'OpenSearch', 'OpenSearch'],
  ['dynamodb', 'DynamoDB', 'DynamoDB'], ['cassandra', 'Cassandra', 'Cassandra'], ['scylladb', 'ScyllaDB', 'ScyllaDB|Scylla'],
  ['clickhouse', 'ClickHouse', 'ClickHouse'], ['redshift', 'Redshift', 'Redshift'], ['snowflake', 'Snowflake', 'Snowflake', 'cs'],
  ['bigquery', 'BigQuery', 'BigQuery'], ['oracle', 'Oracle', 'Oracle', 'cs'], ['mssql', 'SQL Server', 'SQL Server|MSSQL'],
  ['prisma', 'Prisma', 'Prisma'], ['typeorm', 'TypeORM', 'TypeORM'], ['sequelize', 'Sequelize', 'Sequelize'],
  ['drizzle', 'Drizzle', 'Drizzle', 'cs'], ['mongoose', 'Mongoose', 'Mongoose'],
  ['kafka', 'Kafka', 'Kafka'], ['rabbitmq', 'RabbitMQ', 'RabbitMQ'], ['sqs', 'SQS', 'SQS', 'cs'],
  ['sns', 'SNS', 'SNS', 'cs'], ['nats', 'NATS', 'NATS', 'cs'], ['kinesis', 'Kinesis', 'Kinesis'],
  ['docker', 'Docker', 'Docker(?: Compose)?|docker-compose'], ['podman', 'Podman', 'Podman'],
  ['kubernetes', 'Kubernetes', 'Kubernetes|K8s'], ['aws-eks', 'AWS EKS', 'EKS', 'cs'], ['helm', 'Helm', 'Helm', 'cs'],
  ['terraform', 'Terraform', 'Terraform'], ['pulumi', 'Pulumi', 'Pulumi'], ['ansible', 'Ansible', 'Ansible'],
  ['cloudformation', 'CloudFormation', 'CloudFormation'],
  ['aws-s3', 'AWS S3', 'S3', 'cs'], ['aws-lambda', 'AWS Lambda', 'Lambda', 'cs'], ['aws-ecs', 'AWS ECS', 'ECS', 'cs'],
  ['aws-ec2', 'AWS EC2', 'EC2', 'cs'], ['aws', 'AWS', 'AWS|Amazon Web Services'],
  ['gcp-compute', 'GCP Compute Engine', 'Compute Engine'], ['gcp-functions', 'GCP Cloud Functions', 'Cloud Functions'],
  ['gcp-storage', 'GCP Cloud Storage', 'Cloud Storage'], ['gcp', 'GCP', 'GCP|Google Cloud(?: Platform)?'],
  ['azure-devops', 'Azure DevOps', 'Azure DevOps'], ['azure-app-service', 'Azure App Service', 'App Service'],
  ['azure-functions', 'Azure Functions', 'Azure Functions'], ['azure', 'Azure', 'Azure'],
  ['vercel', 'Vercel', 'Vercel'], ['netlify', 'Netlify', 'Netlify'], ['heroku', 'Heroku', 'Heroku'],
  ['flyio', 'Fly.io', 'Fly\\.io'], ['cloudflare', 'Cloudflare', 'Cloudflare'], ['firebase', 'Firebase', 'Firebase'],
  ['supabase', 'Supabase', 'Supabase'],
  ['github-actions', 'GitHub Actions', 'GitHub Actions'], ['gitlab', 'GitLab', 'GitLab(?: CI)?'],
  ['jenkins', 'Jenkins', 'Jenkins'], ['circleci', 'CircleCI', 'CircleCI'], ['bitbucket', 'Bitbucket', 'Bitbucket'],
  ['openai-api', 'OpenAI API', 'OpenAI(?: API)?'], ['langchain', 'LangChain', 'LangChain'],
  ['claude-code', 'Claude Code', 'Claude Code'], ['codex', 'Codex', 'Codex', 'cs'],
  ['copilot', 'GitHub Copilot', '(?:GitHub )?Copilot'], ['antigravity', 'Antigravity', '(?:Google )?Antigravity'],
  ['mailgun', 'Mailgun', 'Mailgun'], ['sendgrid', 'SendGrid', 'SendGrid'], ['stripe', 'Stripe', 'Stripe', 'cs'],
  ['solidgate', 'Solidgate', 'Solidgate'], ['paypal', 'PayPal', 'PayPal'],
  ['storyblok', 'Storyblok', 'Storyblok'], ['contentful', 'Contentful', 'Contentful'], ['strapi', 'Strapi', 'Strapi'],
  ['wordpress', 'WordPress', 'WordPress'],
  ['figma', 'Figma', 'Figma'], ['swagger', 'Swagger', 'Swagger|OpenAPI|springdoc(?:-openapi)?'], ['postman', 'Postman', 'Postman'],
  ['jwt', 'JWT', 'JWT'], ['oauth', 'OAuth', 'OAuth(?: ?2(?:\\.0)?)?'], ['rbac', 'RBAC', 'RBAC'],
  ['csrf', 'CSRF', 'CSRF'], ['xss', 'XSS', 'XSS'],
  ['ddd', 'DDD', 'DDD|Domain[- ]Driven Design'], ['cqrs', 'CQRS', 'CQRS'],
  ['pixijs', 'PixiJS', 'PixiJS|Pixi\\.js'], ['phaser', 'Phaser', 'Phaser', 'cs'], ['threejs', 'Three.js', 'Three\\.js'],
  ['webgl', 'WebGL', 'WebGL'], ['d3', 'D3', 'D3(?:\\.js)?', 'cs'],
  ['sentry', 'Sentry', 'Sentry', 'cs'], ['datadog', 'Datadog', 'Datadog'], ['grafana', 'Grafana', 'Grafana'],
  ['prometheus', 'Prometheus', 'Prometheus', 'cs'],
  ['electron', 'Electron', 'Electron', 'cs'], ['expo', 'Expo', 'Expo', 'cs'], ['jquery', 'jQuery', 'jQuery'],
  ['linux', 'Linux', 'Linux'], ['moon-ds', 'Moon design system', 'Moon design system'],
  ['bad-hombre', 'Bad Hombre', 'Bad Hombre'], ['google-business-profile', 'Google Business Profile API', 'Google Business Profile(?: API)?'],
];

const LEFT = '(?<![A-Za-z0-9_+#.])';
const RIGHT = '(?![A-Za-z0-9_+#])';
interface Entry { id: string; label: string; re: RegExp }
const ENTRIES: Entry[] = RAW.map(([id, label, pattern, cs]) => ({ id, label, re: new RegExp(`${LEFT}(?:${pattern})${RIGHT}`, cs === 'cs' ? 'g' : 'gi') }));
const LABELS = new Map(ENTRIES.map((e) => [e.id, e.label]));

export const labelOf = (id: string): string => LABELS.get(id) ?? id;

/** Technologies mentioned in a piece of text. Longest match wins, so "React Native" never counts as "React". */
export function detectTech(text: string): Set<string> {
  const hits: Array<{ s: number; e: number; id: string }> = [];
  for (const entry of ENTRIES) {
    entry.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = entry.re.exec(text)) !== null) {
      if (m[0] === '') { entry.re.lastIndex++; continue; }
      hits.push({ s: m.index, e: m.index + m[0].length, id: entry.id });
    }
  }
  hits.sort((a, b) => (b.e - b.s) - (a.e - a.s) || a.s - b.s);
  const taken: Array<[number, number]> = [];
  const found = new Set<string>();
  for (const h of hits) {
    if (taken.some(([s, e]) => h.s < e && h.e > s)) continue;
    taken.push([h.s, h.e]);
    found.add(h.id);
  }
  return found;
}

/** Naming a specific service implies the platform, so "AWS Lambda" in a stack also grants "AWS". */
export const PARENT: Record<string, string> = {
  'aws-s3': 'aws', 'aws-lambda': 'aws', 'aws-eks': 'aws', 'aws-ecs': 'aws', 'aws-ec2': 'aws', dynamodb: 'aws',
  'gcp-compute': 'gcp', 'gcp-functions': 'gcp', 'gcp-storage': 'gcp',
  'azure-devops': 'azure', 'azure-app-service': 'azure', 'azure-functions': 'azure',
  'react-native': 'react', 'angular-material': 'angular',
  typescript: 'javascript', // TypeScript compiles to and is written as JavaScript; years with one are years with both
};

export function idsOf(items: string[]): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    for (const id of detectTech(item)) {
      out.add(id);
      const parent = PARENT[id];
      if (parent) out.add(parent);
    }
  }
  return out;
}
