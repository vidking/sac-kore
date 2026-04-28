import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelStatus, SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type SessionHealthStatus = 'healthy' | 'syncing' | 'degraded' | 'offline' | 'stale' | 'error';

type SyncRunSnapshot = {
  id: string;
  status: SyncStatus;
  startedAt: Date;
  finishedAt: Date | null;
  heartbeatAt: Date | null;
  error: string | null;
};

type ChannelSnapshot = {
  id: string;
  sessionName: string;
  status: ChannelStatus;
  lastSyncAt: Date | null;
};

type SessionSummary = {
  sessionName: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'stale';
  healthStatus: SessionHealthStatus;
  sessionConnected: boolean;
  lastSuccessfulSyncAt: Date | null;
  lastError: string | null;
  retryCount: number;
  channel: ChannelSnapshot | null;
  activeRun: SyncRunSnapshot | null;
  latestRun: SyncRunSnapshot | null;
  recentRuns: SyncRunSnapshot[];
};

@Injectable()
export class SyncLifecycleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SyncLifecycleService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap() {
    const marked = await this.markStaleRuns();
    if (marked > 0) {
      this.logger.warn(`Marked ${marked} stale sync runs during bootstrap`);
    }
  }

  async markStaleRuns(sessionName?: string) {
    const staleBefore = new Date(Date.now() - this.staleTimeoutMs());

    const result = await this.prisma.syncRun.updateMany({
      where: {
        status: 'running',
        ...(sessionName ? { sessionName } : {}),
        OR: [
          { heartbeatAt: null, startedAt: { lt: staleBefore } },
          { heartbeatAt: { lt: staleBefore } },
        ],
      },
      data: {
        status: 'stale',
        heartbeatAt: new Date(),
        finishedAt: new Date(),
        error: 'Sync run marked stale after heartbeat timeout',
      },
    });

    return result.count;
  }

  heartbeat(runId: string) {
    return this.prisma.syncRun.update({
      where: { id: runId },
      data: { heartbeatAt: new Date() },
    });
  }

  async getStatusSummary() {
    await this.markStaleRuns();

    const [channels, recentRuns, activeRuns] = await Promise.all([
      this.prisma.channel.findMany({
        orderBy: { sessionName: 'asc' },
      }),
      this.prisma.syncRun.findMany({
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: 50,
        include: { channel: true },
      }),
      this.prisma.syncRun.findMany({
        where: { status: 'running' },
        include: { channel: true },
      }),
    ]);

    const recentRunsBySession = groupRunsBySession(recentRuns);
    const activeRunBySession = new Map<string, SyncRunSnapshot>();
    for (const run of activeRuns) {
      if (!activeRunBySession.has(run.sessionName)) {
        activeRunBySession.set(run.sessionName, toSnapshot(run));
      }
    }

    const sessionNames = new Set<string>([
      ...channels.map((channel) => channel.sessionName),
      ...recentRuns.map((run) => run.sessionName),
      ...activeRuns.map((run) => run.sessionName),
    ]);

    const sessions = [...sessionNames]
      .sort((left, right) => left.localeCompare(right))
      .map((sessionName) =>
        this.buildSessionSummary(
          sessionName,
          channels.find((item) => item.sessionName === sessionName) ?? null,
          recentRunsBySession.get(sessionName) ?? [],
          activeRunBySession.get(sessionName) ?? null,
        ),
      );

    return {
      sessions,
      recentRuns: recentRuns.map(toSnapshot),
    };
  }

  async getSessionStatus(sessionName: string): Promise<SessionSummary> {
    await this.markStaleRuns(sessionName);

    const [channel, recentRuns, activeRun] = await Promise.all([
      this.prisma.channel.findUnique({
        where: { sessionName },
      }),
      this.prisma.syncRun.findMany({
        where: { sessionName },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: 20,
      }),
      this.prisma.syncRun.findFirst({
        where: { sessionName, status: 'running' },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    return this.buildSessionSummary(
      sessionName,
      channel,
      recentRuns.map(toSnapshot),
      activeRun ? toSnapshot(activeRun) : null,
    );
  }

  staleTimeoutMs() {
    return Number(this.config.get<string>('SYNC_STALE_TIMEOUT_MS') ?? 15 * 60_000);
  }

  private buildSessionSummary(
    sessionName: string,
    channel: ChannelSnapshot | null,
    recentRuns: SyncRunSnapshot[],
    activeRun: SyncRunSnapshot | null,
  ): SessionSummary {
    const latestRun = recentRuns[0] ?? null;
    const retryCount = recentRuns.filter((run) => run.status === SyncStatus.failed || run.status === SyncStatus.stale).length;
    const sessionConnected = channel?.status === ChannelStatus.working;
    const lastSuccessfulSyncAt =
      (latestRun?.status === SyncStatus.completed ? latestRun.finishedAt : null) ??
      channel?.lastSyncAt ??
      null;
    const lastError = activeRun?.error ?? latestRun?.error ?? null;

    return {
      sessionName,
      status: activeRun
        ? 'running'
        : latestRun?.status ?? 'idle',
      healthStatus: this.deriveHealthStatus({
        channel,
        activeRun,
        latestRun,
        sessionConnected,
        lastSuccessfulSyncAt,
      }),
      sessionConnected,
      lastSuccessfulSyncAt,
      lastError,
      retryCount,
      channel,
      activeRun,
      latestRun,
      recentRuns,
    };
  }

  private deriveHealthStatus(input: {
    channel: ChannelSnapshot | null;
    activeRun: SyncRunSnapshot | null;
    latestRun: SyncRunSnapshot | null;
    sessionConnected: boolean;
    lastSuccessfulSyncAt: Date | null;
  }): SessionHealthStatus {
    if (input.activeRun) {
      return 'syncing';
    }

    if (!input.channel && !input.latestRun) {
      return 'offline';
    }

    if (input.latestRun?.status === SyncStatus.stale) {
      return 'stale';
    }

    if (input.latestRun?.status === SyncStatus.failed) {
      return 'error';
    }

    if (!input.sessionConnected) {
      return input.lastSuccessfulSyncAt ? 'degraded' : 'offline';
    }

    if (input.latestRun?.status === SyncStatus.completed) {
      return 'healthy';
    }

    if (!input.lastSuccessfulSyncAt) {
      return 'degraded';
    }

    return 'healthy';
  }
}

function groupRunsBySession(runs: Array<{
  sessionName: string;
  id: string;
  status: SyncStatus;
  startedAt: Date;
  finishedAt: Date | null;
  heartbeatAt: Date | null;
  error: string | null;
}>) {
  const map = new Map<string, SyncRunSnapshot[]>();
  for (const run of runs) {
    const current = map.get(run.sessionName) ?? [];
    current.push(toSnapshot(run));
    map.set(run.sessionName, current);
  }
  return map;
}

function toSnapshot(run: {
  id: string;
  status: SyncStatus;
  startedAt: Date;
  finishedAt: Date | null;
  heartbeatAt: Date | null;
  error: string | null;
}) {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    heartbeatAt: run.heartbeatAt,
    error: run.error,
  };
}
