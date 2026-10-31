import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
export default defineWorkersConfig({ test: { poolOptions: { workers: { miniflare: {
 compatibilityDate: '2025-03-10', compatibilityFlags: ['nodejs_compat'],
 d1Databases: ['db'], kvNamespaces: ['kv'], bindings: { jwt_secret: 'local-test-only', admin: 'admin@example.test', domain: ['example.test'], orm_log: false }
} } } } });
