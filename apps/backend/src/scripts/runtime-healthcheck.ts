import Redis from 'ioredis';

async function main() {
  const serviceName = process.argv[2] ?? process.env.SERVICE_NAME ?? 'worker';
  const maxAgeMs = Number(process.env.RUNTIME_HEALTH_MAX_AGE_MS ?? 60_000);
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const key = `kore:runtime:heartbeat:${serviceName}`;

  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });

  try {
    const raw = await redis.get(key);
    if (!raw) {
      process.exitCode = 1;
      return;
    }

    const payload = JSON.parse(raw) as { ts?: number };
    if (!payload.ts || Date.now() - payload.ts > maxAgeMs) {
      process.exitCode = 1;
    }
  } finally {
    await redis.quit();
  }
}

main().catch(() => {
  process.exitCode = 1;
});
