import { IBitcoinApi } from '../bitcoin/bitcoin-api.interface';
import bitcoinClient from '../bitcoin/bitcoin-client';
import bitcoinSecondClient from '../bitcoin/bitcoin-second-client';
import { Common } from '../common';
import DB from '../../database';
import logger from '../../logger';

const federationChangeAddresses = ['bc1qxvay4an52gcghxq5lavact7r6qe9l4laedsazz8fj2ee2cy47tlqff4aj4', '3EiAcrzq1cELXScc98KeCswGWZaPGceT1d'];
const auditBlockOffsetWithTip = 1; // Wait for 1 block confirmation before processing the block in the audit process to reduce the risk of reorgs

class ElementsParser {
  private isRunning = false;
  private isUtxosUpdatingRunning = false;

  constructor() { }

  public async $parse() {
    if (this.isRunning) {
      return;
    }
    try {
      this.isRunning = true;
      const result = await bitcoinClient.getChainTips();
      const tip = result[0].height;
      const latestBlockHeight = await this.$getLatestBlockHeightFromDatabase();
      for (let height = latestBlockHeight + 1; height <= tip; height++) {
        const blockHash: IBitcoinApi.ChainTips = await bitcoinClient.getBlockHash(height);
        const block: IBitcoinApi.Block = await bitcoinClient.getBlock(blockHash, 2);
        await DB.query('START TRANSACTION;');
        await this.$parseBlock(block);
        await this.$saveLatestBlockToDatabase(block.height);
        await DB.query('COMMIT;');
      }
      this.isRunning = false;
    } catch (e) {
      await DB.query('ROLLBACK;');
      this.isRunning = false;
      throw new Error(e instanceof Error ? e.message : 'Error');
    }
  }

  protected async $parseBlock(block: IBitcoinApi.Block) {
    for (const tx of block.tx) {
      await this.$parseInputs(tx, block);
      await this.$parseOutputs(tx, block);
    }
  }

  protected async $parseInputs(tx: IBitcoinApi.Transaction, block: IBitcoinApi.Block) {
    for (const [index, input] of tx.vin.entries()) {
      if (input.is_pegin) {
        await this.$parsePegIn(input, index, tx.txid, block);
      }
    }
  }

  protected async $parsePegIn(input: IBitcoinApi.Vin, vindex: number, txid: string, block: IBitcoinApi.Block) {
    const bitcoinTx: IBitcoinApi.Transaction = await bitcoinSecondClient.getRawTransaction(input.txid, true);
    const bitcoinBlock: IBitcoinApi.Block = await bitcoinSecondClient.getBlock(bitcoinTx.blockhash);
    const prevout = bitcoinTx.vout[input.vout || 0];
    const outputAddress = prevout.scriptPubKey.address || (prevout.scriptPubKey.addresses && prevout.scriptPubKey.addresses[0]) || '';
    await this.$savePegToDatabase(block.height, block.time, prevout.value * 100000000, txid, vindex,
      outputAddress, bitcoinTx.txid, prevout.n, bitcoinBlock.height, bitcoinBlock.time, 1);
  }

  protected async $parseOutputs(tx: IBitcoinApi.Transaction, block: IBitcoinApi.Block) {
    for (const output of tx.vout) {
      if (output.scriptPubKey.pegout_chain) {
        await this.$savePegToDatabase(block.height, block.time, 0 - output.value * 100000000, tx.txid, output.n,
          (output.scriptPubKey.pegout_addresses && output.scriptPubKey.pegout_addresses[0] || ''), '', 0, 0, 0, 0);
      }
      if (!output.scriptPubKey.pegout_chain && output.scriptPubKey.type === 'nulldata'
        && output.value && output.value > 0 && output.asset && output.asset === Common.nativeAssetId) {
        await this.$savePegToDatabase(block.height, block.time, 0 - output.value * 100000000, tx.txid, output.n,
          (output.scriptPubKey.pegout_addresses && output.scriptPubKey.pegout_addresses[0] || ''), '', 0, 0, 0, 1);
      }
    }
  }

  protected async $savePegToDatabase(height: number, blockTime: number, amount: number, txid: string,
    txindex: number, bitcoinaddress: string, bitcointxid: string, bitcoinindex: number, bitcoinblock: number, bitcoinBlockTime: number, final_tx: number): Promise<void> {
    const query = `INSERT IGNORE INTO elements_pegs(
        block, datetime, amount, txid, txindex, bitcoinaddress, bitcointxid, bitcoinindex, final_tx
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const params: (string | number)[] = [
      height, blockTime, amount, txid, txindex, bitcoinaddress, bitcointxid, bitcoinindex, final_tx
    ];
    await DB.query(query, params);
    logger.debug(`Saved L-BTC peg from Liquid block height #${height} with TXID ${txid}.`);

    if (amount > 0) { // Peg-in
  
      // Add the address to the federation addresses table
      await DB.query(`INSERT IGNORE INTO federation_addresses (bitcoinaddress) VALUES (?)`, [bitcoinaddress]);
      logger.debug(`Saved new Federation address ${bitcoinaddress} to federation addresses.`);

      // Add the UTXO to the federation txos table
      const query_utxos = `INSERT IGNORE INTO federation_txos (txid, txindex, bitcoinaddress, amount, blocknumber, blocktime, unspent, lastblockupdate, lasttimeupdate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      const params_utxos: (string | number)[] = [bitcointxid, bitcoinindex, bitcoinaddress, amount, bitcoinblock, bitcoinBlockTime, 1, bitcoinblock - 1, 0];
      await DB.query(query_utxos, params_utxos);
      const [minBlockUpdate] = await DB.query(`SELECT MIN(lastblockupdate) AS lastblockupdate FROM federation_txos WHERE unspent = 1`)
      await this.$saveLastBlockAuditToDatabase(minBlockUpdate[0]['lastblockupdate']);
      logger.debug(`Saved new Federation UTXO ${bitcointxid}:${bitcoinindex} belonging to ${bitcoinaddress} to federation txos.`);

    }
  }

  protected async $getLatestBlockHeightFromDatabase(): Promise<number> {
    const query = `SELECT number FROM state WHERE name = 'last_elements_block'`;
    const [rows] = await DB.query(query);
    return rows[0]['number'];
  }

  protected async $saveLatestBlockToDatabase(blockHeight: number) {
    const query = `UPDATE state SET number = ? WHERE name = 'last_elements_block'`;
    await DB.query(query, [blockHeight]);
  }

  ///////////// FEDERATION AUDIT //////////////

  public async $updateFederationUtxos() {
    if (this.isUtxosUpdatingRunning) {
      return;
    }

    this.isUtxosUpdatingRunning = true;

    try {
      let auditProgress = await this.$getAuditProgress();
      // If no peg in transaction was found in the database, return
      if (!auditProgress.lastBlockAudit) {
        logger.debug(`No Federation UTXOs found in the database. Waiting for some to be confirmed before starting the Federation UTXOs audit.`);
        this.isUtxosUpdatingRunning = false;
        return;
      }

      const bitcoinBlocksToSync = await this.$getBitcoinBlockchainState();
      // If the bitcoin blockchain is not synced yet, return
      if (bitcoinBlocksToSync.bitcoinHeaders > bitcoinBlocksToSync.bitcoinBlocks + 1) {
        logger.debug(`Bitcoin client is not synced yet. ${bitcoinBlocksToSync.bitcoinHeaders - bitcoinBlocksToSync.bitcoinBlocks} blocks remaining to sync before the Federation audit process can start.`);
        this.isUtxosUpdatingRunning = false;
        return;
      }

      auditProgress.lastBlockAudit++;

      while (auditProgress.lastBlockAudit <= auditProgress.confirmedTip) {
        // First, get the current UTXOs that need to be scanned in the block
        const utxos = await this.$getFederationUtxosToScan(auditProgress.lastBlockAudit);
        logger.debug(`Found ${utxos.length} Federation UTXOs to scan in block ${auditProgress.lastBlockAudit} / ${auditProgress.confirmedTip}`);
        await DB.query('START TRANSACTION;');

        // The fast way: check if these UTXOs are still unspent as of the current block with gettxout
        let utxosToParse: any[];
        if (auditProgress.confirmedTip - auditProgress.lastBlockAudit <= 150) { // If the audit status is not too far in the past, we can use gettxout (fast way)
          utxosToParse = await this.$getUtxosToParse(utxos, auditProgress.confirmedTip);
          const message = `${utxos.length - utxosToParse.length} / ${utxos.length} Federation UTXOs are unspent as of tip`;
          const additionalInfo = (utxos.length - utxosToParse.length > 0) ? `, updated their lastblockupdate to ${auditProgress.confirmedTip}` : '';
          logger.debug(message + additionalInfo);
        } else { // If the audit status is too far in the past, it is useless to look for still unspent txos since they will all be spent as of the tip
          utxosToParse = utxos;
        }

        // The slow way: parse the block to look for the spending tx
        if (utxosToParse.length > 0) {
          logger.debug(`${utxosToParse.length} / ${utxos.length} Federation UTXOs are spent as of tip: Looking for their spending in block ${auditProgress.lastBlockAudit} / ${auditProgress.confirmedTip}`);

          const blockHash: IBitcoinApi.ChainTips = await bitcoinSecondClient.getBlockHash(auditProgress.lastBlockAudit);
          const block: IBitcoinApi.Block = await bitcoinSecondClient.getBlock(blockHash, 2);
          const nbUtxos = utxosToParse.length;

          await this.$parseBitcoinBlock(block, utxosToParse);
          logger.debug(`Watched for spending of ${nbUtxos} Federation UTXOs in block ${auditProgress.lastBlockAudit} / ${auditProgress.confirmedTip}`);
        }

        // Finally, update the lastblockupdate of the remaining UTXOs and save to the database
        const [minBlockUpdate] = await DB.query(`SELECT MIN(lastblockupdate) AS lastblockupdate FROM federation_txos WHERE unspent = 1`)
        await this.$saveLastBlockAuditToDatabase(minBlockUpdate[0]['lastblockupdate']);

        auditProgress = await this.$getAuditProgress();
        auditProgress.lastBlockAudit++;
        await DB.query('COMMIT;');
      }

      this.isUtxosUpdatingRunning = false;
    } catch (e) {
      await DB.query('ROLLBACK;');
      this.isUtxosUpdatingRunning = false;
      throw new Error(e instanceof Error ? e.message : 'Error');
    } 
  }

  // Get the UTXOs that need to be scanned in block height (UTXOs that were last updated in the block height - 1)
  protected async $getFederationUtxosToScan(height: number) { 
    const query = `SELECT txid, txindex, bitcoinaddress, amount FROM federation_txos WHERE lastblockupdate = ? AND unspent = 1`;
    const [rows] = await DB.query(query, [height - 1]);
    return rows as any[];
  }

  // Returns the UTXOs that are spent as of tip and need to be scanned
  protected async $getUtxosToParse(utxos: any[], confirmedTip: number): Promise<any[]> {
    const utxosToScan: any[] = [];

    for (const utxo of utxos) {
      const result = await bitcoinSecondClient.getTxOut(utxo.txid, utxo.txindex, false);
      if (!result) { // The UTXO is spent as of the tip, we need to look for its spending in blocks
        utxosToScan.push(utxo);
      } else { // The UTXO is still unspent as of the tip, we can update its lastblockupdate
        await DB.query(`UPDATE federation_txos SET lastblockupdate = ? WHERE txid = ? AND txindex = ?`, [confirmedTip, utxo.txid, utxo.txindex]);
      }
    }
    
    return utxosToScan;
  }

  protected async $parseBitcoinBlock(block: IBitcoinApi.Block, utxos: any[]) {
      for (const tx of block.tx) {
        for (const input of tx.vin) {
          const txo = utxos.find(txo => txo.txid === input.txid && txo.txindex === input.vout);
          if (txo) {
            await DB.query(`UPDATE federation_txos SET unspent = 0, lastblockupdate = ?, lasttimeupdate = ? WHERE txid = ? AND txindex = ?`, [block.height, block.time, txo.txid, txo.txindex]);
            // Remove the TXO from the utxo array
            utxos.splice(utxos.indexOf(txo), 1);
            logger.debug(`Federation UTXO ${txo.txid}:${txo.txindex} (${txo.amount} sats) was spent in block ${block.height}.`);
          }
        }
        // Checking if an output is sent to a change address of the federation
        for (const output of tx.vout) {
          if (output.scriptPubKey.address && federationChangeAddresses.includes(output.scriptPubKey.address)) {
            // Check that the UTXO was not already added in the DB by previous scans
            const [rows_check] = await DB.query(`SELECT txid FROM federation_txos WHERE txid = ? AND txindex = ?`, [tx.txid, output.n]) as any[];
            if (rows_check.length === 0) {
              const query_utxos = `INSERT INTO federation_txos (txid, txindex, bitcoinaddress, amount, blocknumber, blocktime, unspent, lastblockupdate, lasttimeupdate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
              const params_utxos: (string | number)[] = [tx.txid, output.n, output.scriptPubKey.address, output.value * 100000000, block.height, block.time, 1, block.height, 0];
              await DB.query(query_utxos, params_utxos);
              // Add the UTXO to the utxo array
              utxos.push({
                txid: tx.txid,
                txindex: output.n,
                bitcoinaddress: output.scriptPubKey.address,
                amount: output.value * 100000000
              });
              logger.debug(`Added new Federation UTXO ${tx.txid}:${output.n} of ${output.value * 100000000} sats belonging to ${output.scriptPubKey.address} (Federation change address).`);
            }
          }
        }
      }

      for (const utxo of utxos) {
        await DB.query(`UPDATE federation_txos SET lastblockupdate = ? WHERE txid = ? AND txindex = ?`, [block.height, utxo.txid, utxo.txindex]);    
      }
  }

  protected async $saveLastBlockAuditToDatabase(blockHeight: number) {
    const query = `UPDATE state SET number = ? WHERE name = 'last_bitcoin_block_audit'`;
    await DB.query(query, [blockHeight]);
  }

  // Get the bitcoin block the audit process was last updated
  protected async $getAuditProgress(): Promise<any> {
    const lastblockaudit = await this.$getLastBlockAudit();
    const bitcoinBlocksToSync = await this.$getBitcoinBlockchainState();
    return {
      lastBlockAudit: lastblockaudit,
      confirmedTip: bitcoinBlocksToSync.bitcoinBlocks - auditBlockOffsetWithTip,
    };
  }

  // Get the bitcoin blocks remaining to be synced
  protected async $getBitcoinBlockchainState(): Promise<any> {
    const result = await bitcoinSecondClient.getBlockchainInfo();
    return {
      bitcoinBlocks: result.blocks,
      bitcoinHeaders: result.headers,
    }
  }

  protected async $getLastBlockAudit(): Promise<number> {
    const query = `SELECT number FROM state WHERE name = 'last_bitcoin_block_audit'`;
    const [rows] = await DB.query(query);
    return rows[0]['number'];
  }

    ///////////// DATA QUERY //////////////

    public async $getAuditStatus(): Promise<any> {
    const lastBlockAudit = await this.$getLastBlockAudit();
    const bitcoinBlocksToSync = await this.$getBitcoinBlockchainState();
    return {
      bitcoinBlocks: bitcoinBlocksToSync.bitcoinBlocks,
      bitcoinHeaders: bitcoinBlocksToSync.bitcoinHeaders,
      lastBlockAudit: lastBlockAudit,
      isAuditSynced: bitcoinBlocksToSync.bitcoinHeaders - bitcoinBlocksToSync.bitcoinBlocks <= 2 && bitcoinBlocksToSync.bitcoinBlocks - lastBlockAudit <= 3,
    };
  }

  public async $getPegDataByMonth(): Promise<any> {
    const query = `SELECT SUM(amount) AS amount, DATE_FORMAT(FROM_UNIXTIME(datetime), '%Y-%m-01') AS date FROM elements_pegs GROUP BY DATE_FORMAT(FROM_UNIXTIME(datetime), '%Y%m')`;
    const [rows] = await DB.query(query);
    return rows;
  }

  public async $getFederationReservesByMonth(): Promise<any> {
    const query = `
    SELECT SUM(amount) AS amount, DATE_FORMAT(FROM_UNIXTIME(blocktime), '%Y-%m-01') AS date FROM federation_txos 
    WHERE
        (blocktime > UNIX_TIMESTAMP(LAST_DAY(FROM_UNIXTIME(blocktime) - INTERVAL 1 MONTH) + INTERVAL 1 DAY))
      AND 
        ((unspent = 1) OR (unspent = 0 AND lasttimeupdate > UNIX_TIMESTAMP(LAST_DAY(FROM_UNIXTIME(blocktime)) + INTERVAL 1 DAY)))
    GROUP BY 
        date;`;          
    const [rows] = await DB.query(query);
    return rows;
  }

  // Get the current L-BTC pegs and the last Liquid block it was updated
  public async $getCurrentLbtcSupply(): Promise<any> {
    const [rows] = await DB.query(`SELECT SUM(amount) AS LBTC_supply FROM elements_pegs;`);
    const lastblockupdate = await this.$getLatestBlockHeightFromDatabase();
    return {
      amount: rows[0]['LBTC_supply'],
      lastBlockUpdate: lastblockupdate
    };
  }

  // Get the current reserves of the federation and the last Bitcoin block it was updated
  public async $getCurrentFederationReserves(): Promise<any> {
    const [rows] = await DB.query(`SELECT SUM(amount) AS total_balance FROM federation_txos WHERE unspent = 1;`);
    const lastblockaudit = await this.$getLastBlockAudit();
    return {
      amount: rows[0]['total_balance'],
      lastBlockUpdate: lastblockaudit
    };
  }

  // Get the "rich list" of the federation addresses
  public async $getFederationTopAddresses(): Promise<any> {
    const query = `SELECT bitcoinaddress, SUM(amount) AS balance FROM federation_txos WHERE unspent = 1 GROUP BY bitcoinaddress ORDER BY balance DESC;`;
    const [rows] = await DB.query(query);
    return rows;
  }

  // Get all the UTXOs held by the federation, most recent first
  public async $getFederationUtxos(): Promise<any> {
    const query = `SELECT * FROM federation_txos WHERE unspent = 1 ORDER BY blocktime DESC;`;
    const [rows] = await DB.query(query);
    return rows;
  }

}

export default new ElementsParser();
