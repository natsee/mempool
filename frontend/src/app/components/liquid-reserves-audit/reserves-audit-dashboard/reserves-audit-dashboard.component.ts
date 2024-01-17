import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { SeoService } from '../../../services/seo.service';
import { WebsocketService } from '../../../services/websocket.service';
import { StateService } from '../../../services/state.service';
import { Observable, concat, delay, filter, map, share, switchMap, tap } from 'rxjs';
import { ApiService } from '../../../services/api.service';
import { AuditStatus, CurrentPegs, FederationAddress, FederationUtxo } from '../../../interfaces/node-api.interface';

@Component({
  selector: 'app-reserves-audit-dashboard',
  templateUrl: './reserves-audit-dashboard.component.html',
  styleUrls: ['./reserves-audit-dashboard.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReservesAuditDashboardComponent implements OnInit {
  auditStatus$: Observable<AuditStatus>;
  currentPeg$: Observable<CurrentPegs>;
  currentReserves$: Observable<CurrentPegs>;
  federationUtxos$: Observable<FederationUtxo[]>;
  federationAddresses$: Observable<FederationAddress[]>;
  private lastPegBlockUpdate: number = 0;
  private lastReservesBlockUpdate: number = 0;


  constructor(
    private seoService: SeoService,
    private websocketService: WebsocketService,
    private apiService: ApiService,
    private stateService: StateService,
  ) {
    this.seoService.setTitle($localize`:@@liquid.reserves-audit:Reserves Audit Dashboard`);
  }

  ngOnInit(): void {
    this.websocketService.want(['blocks', 'mempool-blocks']);

    this.auditStatus$ = concat(
      this.apiService.federationAuditSynced$(),
      this.stateService.blocks$
        .pipe(
          delay(2000),
          switchMap(() => this.apiService.federationAuditSynced$())
        )
    );

    this.currentReserves$ = this.auditStatus$
      .pipe(
        filter(auditStatus => auditStatus.isAuditSynced === true),
        switchMap(_ =>
          concat(
            this.apiService.liquidReserves$()
              .pipe(
                tap((currentReserves) => this.lastReservesBlockUpdate = currentReserves.lastBlockUpdate)
              ),
            this.stateService.blocks$
              .pipe(
                delay(1000),
                switchMap(_ => this.apiService.liquidReserves$()),
                filter((currentReserves) => currentReserves.lastBlockUpdate > this.lastReservesBlockUpdate)
              )
          )),
        map((currentReserves) => {
          this.lastReservesBlockUpdate = currentReserves.lastBlockUpdate
          return currentReserves;
        }),
        share(),
      );

    this.currentPeg$ = concat(
      this.apiService.liquidPegs$()
        .pipe(
          tap((currentPeg) => this.lastPegBlockUpdate = currentPeg.lastBlockUpdate)
        ),
      this.stateService.blocks$.pipe(
        delay(1000),
        switchMap((_) => this.apiService.liquidPegs$()),
        filter((currentPeg) => currentPeg.lastBlockUpdate > this.lastPegBlockUpdate)
      )
    ).pipe(
      map((currentPeg) => {
        this.lastPegBlockUpdate = currentPeg.lastBlockUpdate;
        return currentPeg;
      }),
      share(),
    );

    this.federationUtxos$ = this.auditStatus$
      .pipe(
        filter(auditStatus => auditStatus.isAuditSynced === true),
        switchMap(_ =>
          concat(
            this.apiService.federationUtxos$(),
            this.stateService.blocks$
              .pipe(
                delay(1000),
                switchMap(_ => this.apiService.federationUtxos$())
              )
          )),
        share(),
      );
    
    this.federationAddresses$ = this.auditStatus$
      .pipe(
        filter(auditStatus => auditStatus.isAuditSynced === true),
        switchMap(_ =>
          concat(
            this.apiService.federationAddresses$(),
            this.stateService.blocks$
              .pipe(
                delay(1000),
                switchMap(_ => this.apiService.federationAddresses$())
              )
          )),
        share(),
      );

  }

}
