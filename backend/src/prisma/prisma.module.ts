import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { DeadlockDetectorService } from '../common/monitoring/deadlock-detector.service';
import { ReplicaBalancerService } from './replica-balancer.service';
import { ShardingRouterService } from './sharding-router.service';
import { TenantShardingService } from './tenant-sharding.service';
import { TenantInterceptor } from '../common/interceptors/tenant.interceptor';
import { SecurityModule } from '../modules/security/security.module';
import { QueryAnalyzerService } from './query-analyzer.service';

@Global()
@Module({
  imports: [SecurityModule],
  providers: [
    PrismaService,
    DeadlockDetectorService,
    ReplicaBalancerService,
    ShardingRouterService,
    TenantShardingService,
    TenantInterceptor,
    QueryAnalyzerService,
  ],
  exports: [
    PrismaService,
    DeadlockDetectorService,
    ReplicaBalancerService,
    ShardingRouterService,
    TenantShardingService,
    TenantInterceptor,
    QueryAnalyzerService,
  ],
})
export class PrismaModule {}
