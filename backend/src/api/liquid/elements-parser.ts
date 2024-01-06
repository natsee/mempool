import { IBitcoinApi } from '../bitcoin/bitcoin-api.interface';
import bitcoinClient from '../bitcoin/bitcoin-client';
import bitcoinSecondClient from '../bitcoin/bitcoin-second-client';
import { Common } from '../common';
import DB from '../../database';
import logger from '../../logger';

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
        await this.$parseBlock(block);
        await this.$saveLatestBlockToDatabase(block.height);
      }
      this.isRunning = false;
    } catch (e) {
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
    const query = `INSERT INTO elements_pegs(
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
      const query_utxos = `INSERT INTO federation_txos (txid, txindex, bitcoinaddress, amount, blocknumber, blocktime, unspent, lastblockupdate, lasttimeupdate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
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
    const changeAddresses = ['bc1qxvay4an52gcghxq5lavact7r6qe9l4laedsazz8fj2ee2cy47tlqff4aj4', '3EiAcrzq1cELXScc98KeCswGWZaPGceT1d'];

    try {
      let auditProgress = await this.$getAuditProgress();

      if (!auditProgress.lastBlockAudit) {
        this.isUtxosUpdatingRunning = false;
        return;
      }

      auditProgress.lastBlockAudit++;

      while (auditProgress.lastBlockAudit <= auditProgress.tip) {
        const blockHash: IBitcoinApi.ChainTips = await bitcoinSecondClient.getBlockHash(auditProgress.lastBlockAudit);
        const block: IBitcoinApi.Block = await bitcoinSecondClient.getBlock(blockHash, 2);
        const utxos = await this.$getFederationUtxosToScan(auditProgress.lastBlockAudit);
        const nbUtxos = utxos.length;

        await this.$parseBitcoinBlock(block, utxos, changeAddresses);
        logger.debug(`Watched for spending of ${nbUtxos} Federation UTXOs in block ${auditProgress.lastBlockAudit} / ${auditProgress.tip}`);

        auditProgress = await this.$getAuditProgress();
        auditProgress.lastBlockAudit++;
      }

      this.isUtxosUpdatingRunning = false;
    } catch (e) {
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

  protected async $parseBitcoinBlock(block: IBitcoinApi.Block, utxos: any[], changeAddresses: string[]) {
    try {
      await DB.query('START TRANSACTION;');
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
          if (output.scriptPubKey.address && changeAddresses.includes(output.scriptPubKey.address)) {
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

      const [minBlockUpdate] = await DB.query(`SELECT MIN(lastblockupdate) AS lastblockupdate FROM federation_txos WHERE unspent = 1`)
      await this.$saveLastBlockAuditToDatabase(minBlockUpdate[0]['lastblockupdate']);

      await DB.query('COMMIT;');
    } catch (e) {
      await DB.query('ROLLBACK;');
      throw new Error(e instanceof Error ? e.message : 'Error');
    }
  }

  // // Check that recently added federation txos in the database are still part of the blockchain
  // protected async $checkForReorgs(height: number) {
  //   const [rows] = await DB.query(`SELECT txid, txindex FROM federation_txos WHERE blocknumber > ?`, [height]) as any[];
  //   let reorgDetected = false;
  //   for (const txo of rows) {
  //     const tx = await bitcoinSecondClient.getRawTransaction(txo.txid, true);
  //     if (!tx || !tx.vout[txo.txindex]) {
  //       // The UTXO is not part of the blockchain anymore: remove it from the database
  //       await DB.query(`DELETE FROM federation_txos WHERE txid = ? AND txindex = ?`, [txo.txid, txo.txindex]);
  //       reorgDetected = true;
  //       logger.debug(`WARNING: Federation UTXO ${txo.txid}:${txo.txindex} was removed from the database because it was not found in the blockchain, probably due to a reorg.`);
  //     }
  //   }
  //   if (reorgDetected) {
  //     // Update the last block audit
  //     const [minBlockUpdate] = await DB.query(`SELECT MIN(lastblockupdate) AS lastblockupdate FROM federation_txos WHERE unspent = 1`)
  //     await this.$saveLastBlockAuditToDatabase(minBlockUpdate[0]['lastblockupdate']);
  //   } else {
  //     logger.debug(`All Federation UTXOs from block ${height} are still part of the blockchain.`);
  //   }
  // }

  ///////////// DATA QUERY //////////////

  public async $getPegDataByMonth(): Promise<any> {
    const query = `SELECT SUM(amount) AS amount, DATE_FORMAT(FROM_UNIXTIME(datetime), '%Y-%m-01') AS date FROM elements_pegs GROUP BY DATE_FORMAT(FROM_UNIXTIME(datetime), '%Y%m')`;
    const [rows] = await DB.query(query);
    return rows;
  }

  // Get the bitcoin block the audit process was last updated
  protected async $getAuditProgress(): Promise<any> {
    const query = `SELECT number FROM state WHERE name = 'last_bitcoin_block_audit'`;
    const [rows] = await DB.query(query);
    const result = await bitcoinSecondClient.getChainTips();
    return {
      lastBlockAudit: rows[0]['number'],
      tip: result[0].height - 6 // We don't want a block reorg to mess up with the Federation UTXOs (regularly check that recent txos are part of the blockchain?)
    };
  }

  protected async $saveLastBlockAuditToDatabase(blockHeight: number) {
    const query = `UPDATE state SET number = ? WHERE name = 'last_bitcoin_block_audit'`;
    await DB.query(query, [blockHeight]);
  }

  public async $getFederationReservesByMonth(): Promise<any> {
    const query = `SELECT SUM(amount) AS absolute_amount, DATE_FORMAT(blocktime, '%Y-%m-01') AS date FROM federation_txos WHERE unspent = 1 GROUP BY DATE_FORMAT(blocktime, '%Y-%m')`;
    const [rows] = await DB.query(query);
    return rows;
  }

  // Get the current L-BTC pegs and the last block it was updated
  public async $getCurrentLbtcSupply(): Promise<any> {
    const query = `SELECT SUM(amount) AS LBTC_supply, MAX(block) AS lastblockupdate FROM elements_pegs;`;
    const [rows] = await DB.query(query);
    return rows[0];
  }

  // Get the current reserves of the federation and the last block it was updated
  public async $getFederationCurrentReserves(): Promise<any> {
    const query = `SELECT SUM(amount) AS total_balance, MIN(lastblockupdate) AS lastblockupdate FROM federation_txos WHERE unspent = 1;`;
    const [rows] = await DB.query(query);
    return rows[0];
  }

  // Get the "rich list" of the federation addresses
  public async $getFederationTopAddresses(): Promise<any> {
    const query = `SELECT bitcoinaddress, SUM(amount) AS balance, MAX(lastblockupdate) as lastblockupdate FROM federation_txos WHERE unspent = 1 GROUP BY bitcoinaddress ORDER BY balance DESC;`;
    const [rows] = await DB.query(query);
    return rows;
  }

  // Get all the UTXOs held by the federation, sorted by date
  public async $getFederationUtxos(): Promise<any> {
    const query = `SELECT * FROM federation_txos WHERE unspent = 1 ORDER BY blocktime DESC;`;
    const [rows] = await DB.query(query);
    return rows;
  }

}

export default new ElementsParser();
