import { AfterViewInit, ChangeDetectionStrategy, Component, OnDestroy, OnInit } from '@angular/core';
import { combineLatest, concat, EMPTY, interval, merge, Observable, of, Subscription } from 'rxjs';
import { catchError, delay, filter, map, mergeMap, scan, share, startWith, switchMap, tap } from 'rxjs/operators';
import { AuditStatus, BlockExtended, CurrentPegs, OptimizedMempoolStats } from '../interfaces/node-api.interface';
import { MempoolInfo, TransactionStripped, ReplacementInfo } from '../interfaces/websocket.interface';
import { ApiService } from '../services/api.service';
import { StateService } from '../services/state.service';
import { WebsocketService } from '../services/websocket.service';
import { SeoService } from '../services/seo.service';

interface MempoolBlocksData {
  blocks: number;
  size: number;
}

interface MempoolInfoData {
  memPoolInfo: MempoolInfo;
  vBytesPerSecond: number;
  progressWidth: string;
  progressColor: string;
}

interface MempoolStatsData {
  mempool: OptimizedMempoolStats[];
  weightPerSecond: any;
}

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardComponent implements OnInit, OnDestroy, AfterViewInit {
  featuredAssets$: Observable<any>;
  network$: Observable<string>;
  mempoolBlocksData$: Observable<MempoolBlocksData>;
  mempoolInfoData$: Observable<MempoolInfoData>;
  mempoolLoadingStatus$: Observable<number>;
  vBytesPerSecondLimit = 1667;
  transactions$: Observable<TransactionStripped[]>;
  blocks$: Observable<BlockExtended[]>;
  replacements$: Observable<ReplacementInfo[]>;
  latestBlockHeight: number;
  mempoolTransactionsWeightPerSecondData: any;
  mempoolStats$: Observable<MempoolStatsData>;
  transactionsWeightPerSecondOptions: any;
  isLoadingWebSocket$: Observable<boolean>;
  liquidPegsMonth$: Observable<any>;
  currentPeg$: Observable<CurrentPegs>;
  auditStatus$: Observable<AuditStatus>;
  liquidReservesMonth$: Observable<any>;
  currentReserves$: Observable<CurrentPegs>;
  fullHistory$: Observable<any>;
  currencySubscription: Subscription;
  currency: string;
  private lastPegBlockUpdate: number = 0;
  private lastReservesBlockUpdate: number = 0;

  constructor(
    public stateService: StateService,
    private apiService: ApiService,
    private websocketService: WebsocketService,
    private seoService: SeoService
  ) { }

  ngAfterViewInit(): void {
    this.stateService.focusSearchInputDesktop();
  }

  ngOnDestroy(): void {
    this.currencySubscription.unsubscribe();
    this.websocketService.stopTrackRbfSummary();
  }

  ngOnInit(): void {
    this.isLoadingWebSocket$ = this.stateService.isLoadingWebSocket$;
    this.seoService.resetTitle();
    this.seoService.resetDescription();
    this.websocketService.want(['blocks', 'stats', 'mempool-blocks', 'live-2h-chart']);
    this.websocketService.startTrackRbfSummary();
    this.network$ = merge(of(''), this.stateService.networkChanged$);
    this.mempoolLoadingStatus$ = this.stateService.loadingIndicators$
      .pipe(
        map((indicators) => indicators.mempool !== undefined ? indicators.mempool : 100)
      );

    this.mempoolInfoData$ = combineLatest([
      this.stateService.mempoolInfo$,
      this.stateService.vbytesPerSecond$
    ])
      .pipe(
        map(([mempoolInfo, vbytesPerSecond]) => {
          const percent = Math.round((Math.min(vbytesPerSecond, this.vBytesPerSecondLimit) / this.vBytesPerSecondLimit) * 100);

          let progressColor = 'bg-success';
          if (vbytesPerSecond > 1667) {
            progressColor = 'bg-warning';
          }
          if (vbytesPerSecond > 3000) {
            progressColor = 'bg-danger';
          }

          const mempoolSizePercentage = (mempoolInfo.usage / mempoolInfo.maxmempool * 100);
          let mempoolSizeProgress = 'bg-danger';
          if (mempoolSizePercentage <= 50) {
            mempoolSizeProgress = 'bg-success';
          } else if (mempoolSizePercentage <= 75) {
            mempoolSizeProgress = 'bg-warning';
          }

          return {
            memPoolInfo: mempoolInfo,
            vBytesPerSecond: vbytesPerSecond,
            progressWidth: percent + '%',
            progressColor: progressColor,
            mempoolSizeProgress: mempoolSizeProgress,
          };
        })
      );

    this.mempoolBlocksData$ = this.stateService.mempoolBlocks$
      .pipe(
        map((mempoolBlocks) => {
          const size = mempoolBlocks.map((m) => m.blockSize).reduce((a, b) => a + b, 0);
          const vsize = mempoolBlocks.map((m) => m.blockVSize).reduce((a, b) => a + b, 0);

          return {
            size: size,
            blocks: Math.ceil(vsize / this.stateService.blockVSize)
          };
        })
      );

    this.featuredAssets$ = this.apiService.listFeaturedAssets$()
      .pipe(
        map((featured) => {
          const newArray = [];
          for (const feature of featured) {
            if (feature.ticker !== 'L-BTC' && feature.asset) {
              newArray.push(feature);
            }
          }
          return newArray.slice(0, 4);
        }),
      );

    this.transactions$ = this.stateService.transactions$
      .pipe(
        scan((acc, tx) => {
          if (acc.find((t) => t.txid == tx.txid)) {
            return acc;
          }
          acc.unshift(tx);
          acc = acc.slice(0, 6);
          return acc;
        }, []),
      );

    this.blocks$ = this.stateService.blocks$
      .pipe(
        tap((blocks) => {
          this.latestBlockHeight = blocks[0].height;
        }),
        switchMap((blocks) => {
          if (this.stateService.env.MINING_DASHBOARD === true) {
            for (const block of blocks) {
              // @ts-ignore: Need to add an extra field for the template
              block.extras.pool.logo = `/resources/mining-pools/` +
                block.extras.pool.slug + '.svg';
            }
          }
          return of(blocks.slice(0, 6));
        })
      );

    this.replacements$ = this.stateService.rbfLatestSummary$;

    this.mempoolStats$ = this.stateService.connectionState$
      .pipe(
        filter((state) => state === 2),
        switchMap(() => this.apiService.list2HStatistics$().pipe(
          catchError((e) => {
            return of(null);
          })
        )),
        switchMap((mempoolStats) => {
          return merge(
            this.stateService.live2Chart$
              .pipe(
                scan((acc, stats) => {
                  acc.unshift(stats);
                  acc = acc.slice(0, 120);
                  return acc;
                }, mempoolStats)
              ),
            of(mempoolStats)
          );
        }),
        map((mempoolStats) => {
          if (mempoolStats) {
            return {
              mempool: mempoolStats,
              weightPerSecond: this.handleNewMempoolData(mempoolStats.concat([])),
            };
          } else {
            return null;
          }
        }),
        share(),
      );

    if (this.stateService.network === 'liquid' || this.stateService.network === 'liquidtestnet') {
      ////////// Pegs historical data //////////
      this.liquidPegsMonth$ = interval(24 * 60 * 60 * 1000)
        .pipe(
          startWith(0),
          switchMap(() => this.apiService.listLiquidPegsMonth$()),
          map((pegs) => {
            const labels = pegs.map((stats) => stats.date);
            const series = pegs.map((stats) => parseFloat(stats.amount) / 100000000);
            series.reduce((prev, curr, i) => (series[i] = prev + curr), 0);
            return {
              series,
              labels
            };
          }),
          share(),
        );

      this.currentPeg$ = concat(
        // We fetch the current peg when the page load and
        // wait for the API response before listening to websocket blocks
        this.apiService.liquidPegs$()
          .pipe(
            tap((currentPeg) => this.lastPegBlockUpdate = currentPeg.lastBlockUpdate)
          ),
        // Or when we receive a newer block, we wait 2 seconds so that the backend updates and we fetch the current peg
        this.stateService.blocks$
          .pipe(
            delay(2000),
            switchMap((_) => this.apiService.liquidPegs$()),
            filter((currentPeg) => currentPeg.lastBlockUpdate > this.lastPegBlockUpdate),
            tap((currentPeg) => this.lastPegBlockUpdate = currentPeg.lastBlockUpdate)
          )
      ).pipe(
        share()
      );

      ////////// BTC Reserves historical data //////////
      this.auditStatus$ = concat(
        this.apiService.federationAuditSynced$(),
        this.stateService.blocks$.pipe(
          delay(2000),
          switchMap(() => this.apiService.federationAuditSynced$()),
          share()
        )
      );
      
      this.liquidReservesMonth$ = interval(24 * 60 * 60 * 1000).pipe(
        startWith(0),
        mergeMap(() => this.apiService.federationAuditSynced$()),
        switchMap((auditStatus) => {
          return auditStatus.isAuditSynced ? this.apiService.listLiquidReservesMonth$() : EMPTY;
        }),
        map(reserves => {
          const labels = reserves.map(stats => stats.date);
          const series = reserves.map(stats => parseFloat(stats.amount) / 100000000);
          return {
            series,
            labels
          };
        }),
        share()
      );

      this.currentReserves$ = this.auditStatus$.pipe(
        filter(auditStatus => auditStatus.isAuditSynced === true),
        switchMap(_ =>
          this.apiService.liquidReserves$().pipe(
            filter((currentReserves) => currentReserves.lastBlockUpdate > this.lastReservesBlockUpdate),
            tap((currentReserves) => {
              this.lastReservesBlockUpdate = currentReserves.lastBlockUpdate;
            })
          )
        ),
        share()
      );

      this.fullHistory$ = combineLatest([this.liquidPegsMonth$, this.currentPeg$, this.liquidReservesMonth$, this.currentReserves$])
        .pipe(
          map(([liquidPegs, currentPeg, liquidReserves, currentReserves]) => {
            liquidPegs.series[liquidPegs.series.length - 1] = parseFloat(currentPeg.amount) / 100000000;

            if (liquidPegs.series.length === liquidReserves?.series.length) {
              liquidReserves.series[liquidReserves.series.length - 1] = parseFloat(currentReserves?.amount) / 100000000;
            } else if (liquidPegs.series.length === liquidReserves?.series.length + 1) {
              liquidReserves.series.push(parseFloat(currentReserves?.amount) / 100000000);
            } else {
              liquidReserves = {
                series: [],
                labels: []
              };
            }

            return {
              liquidPegs,
              liquidReserves
            };
          })
        );
    }

    this.currencySubscription = this.stateService.fiatCurrency$.subscribe((fiat) => {
      this.currency = fiat;
    });
  }

  handleNewMempoolData(mempoolStats: OptimizedMempoolStats[]) {
    mempoolStats.reverse();
    const labels = mempoolStats.map(stats => stats.added);

    return {
      labels: labels,
      series: [mempoolStats.map((stats) => [stats.added * 1000, stats.vbytes_per_second])],
    };
  }

  trackByBlock(index: number, block: BlockExtended) {
    return block.height;
  }
}
