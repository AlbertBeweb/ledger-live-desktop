// @flow

import logger from 'logger'
import { BigNumber } from 'bignumber.js'
import type { AccountRaw, OperationRaw } from '@ledgerhq/live-common/lib/types'
import Btc from '@ledgerhq/hw-app-btc'
import { Observable } from 'rxjs'
import { getCryptoCurrencyById } from '@ledgerhq/live-common/lib/helpers/currencies'
import { isSegwitAccount } from 'helpers/bip32'
import { libcoreAmountToBigNumber, bigNumberToLibcoreAmount } from 'helpers/libcore'

import withLibcore from 'helpers/withLibcore'
import { createCommand, Command } from 'helpers/ipc'
import { withDevice } from 'helpers/deviceAccess'
import * as accountIdHelper from 'helpers/accountId'

type BitcoinLikeTransaction = {
  amount: string,
  feePerByte: string,
  recipient: string,
}

type Input = {
  account: AccountRaw, // FIXME there is no reason we send the whole AccountRaw
  transaction: BitcoinLikeTransaction,
  deviceId: string,
}

type Result = { type: 'signed' } | { type: 'broadcasted', operation: OperationRaw }

// FIXME this command should be unified with 'signTransaction' command

const cmd: Command<Input, Result> = createCommand(
  'libcoreSignAndBroadcast',
  ({ account, transaction, deviceId }) =>
    Observable.create(o => {
      let unsubscribed = false
      const isCancelled = () => unsubscribed
      withLibcore(core =>
        doSignAndBroadcast({
          account,
          transaction,
          deviceId,
          core,
          isCancelled,
          onSigned: () => {
            o.next({ type: 'signed' })
          },
          onOperationBroadcasted: operation => {
            o.next({
              type: 'broadcasted',
              operation,
            })
          },
        }),
      ).then(() => o.complete(), e => o.error(e))

      return () => {
        unsubscribed = true
      }
    }),
)

async function signTransaction({
  hwApp,
  currencyId,
  transaction,
  sigHashType,
  supportsSegwit,
  isSegwit,
  hasTimestamp,
}: {
  hwApp: Btc,
  currencyId: string,
  transaction: *,
  sigHashType: number,
  supportsSegwit: boolean,
  isSegwit: boolean,
  hasTimestamp: boolean,
}) {
  const additionals = []
  let expiryHeight
  if (currencyId === 'bitcoin_cash' || currencyId === 'bitcoin_gold') additionals.push('bip143')
  if (currencyId === 'zcash') expiryHeight = Buffer.from([0x00, 0x00, 0x00, 0x00])
  const rawInputs = transaction.getInputs()

  const hasExtraData = currencyId === 'zcash'

  const inputs = await Promise.all(
    rawInputs.map(async input => {
      const rawPreviousTransaction = await input.getPreviousTransaction()
      const hexPreviousTransaction = Buffer.from(rawPreviousTransaction).toString('hex')
      const previousTransaction = hwApp.splitTransaction(
        hexPreviousTransaction,
        supportsSegwit,
        hasTimestamp,
        hasExtraData,
      )
      const outputIndex = input.getPreviousOutputIndex()
      const sequence = input.getSequence()
      return [
        previousTransaction,
        outputIndex,
        undefined, // we don't use that TODO: document
        sequence, // 0xffffffff,
      ]
    }),
  )

  const associatedKeysets = rawInputs.map(input => {
    const derivationPaths = input.getDerivationPath()
    return derivationPaths[0].toString()
  })

  const outputs = transaction.getOutputs()

  const output = outputs.find(output => {
    const derivationPath = output.getDerivationPath()
    if (derivationPath.isNull()) {
      return false
    }
    const strDerivationPath = derivationPath.toString()
    const derivationArr = strDerivationPath.split('/')
    return derivationArr[derivationArr.length - 2] === '1'
  })

  const changePath = output ? output.getDerivationPath().toString() : undefined
  const outputScriptHex = Buffer.from(transaction.serializeOutputs()).toString('hex')
  const initialTimestamp = hasTimestamp ? transaction.getTimestamp() : undefined

  // FIXME
  // should be `transaction.getLockTime()` as soon as lock time is
  // handled by libcore (actually: it always returns a default value
  // and that caused issue with zcash (see #904))
  const lockTime = undefined

  const signedTransaction = await hwApp.createPaymentTransactionNew(
    inputs,
    associatedKeysets,
    changePath,
    outputScriptHex,
    lockTime,
    sigHashType,
    isSegwit,
    initialTimestamp,
    additionals,
    expiryHeight,
  )

  return signedTransaction
}

export async function doSignAndBroadcast({
  account,
  transaction,
  deviceId,
  core,
  isCancelled,
  onSigned,
  onOperationBroadcasted,
}: {
  account: AccountRaw,
  transaction: BitcoinLikeTransaction,
  deviceId: string,
  core: *,
  isCancelled: () => boolean,
  onSigned: () => void,
  onOperationBroadcasted: (optimisticOp: $Exact<OperationRaw>) => void,
}): Promise<void> {
  const { walletName } = accountIdHelper.decode(account.id)
  const njsWallet = await core.getPoolInstance().getWallet(walletName)
  if (isCancelled()) return
  const njsAccount = await njsWallet.getAccount(account.index)
  if (isCancelled()) return
  const bitcoinLikeAccount = njsAccount.asBitcoinLikeAccount()
  const njsWalletCurrency = njsWallet.getCurrency()
  const amount = bigNumberToLibcoreAmount(core, njsWalletCurrency, BigNumber(transaction.amount))
  const fees = bigNumberToLibcoreAmount(core, njsWalletCurrency, BigNumber(transaction.feePerByte))
  const transactionBuilder = bitcoinLikeAccount.buildTransaction()

  // TODO: check if is valid address. if not, it will fail silently on invalid

  transactionBuilder.sendToAddress(amount, transaction.recipient)
  // TODO: don't use hardcoded value for sequence (and first also maybe)
  transactionBuilder.pickInputs(0, 0xffffff)
  transactionBuilder.setFeesPerByte(fees)

  const builded = await transactionBuilder.build()
  if (isCancelled()) return
  const sigHashType = Buffer.from(njsWalletCurrency.bitcoinLikeNetworkParameters.SigHash).toString(
    'hex',
  )

  const hasTimestamp = !!njsWalletCurrency.bitcoinLikeNetworkParameters.UsesTimestampedTransaction
  // TODO: const timestampDelay = njsWalletCurrency.bitcoinLikeNetworkParameters.TimestampDelay

  const currency = getCryptoCurrencyById(account.currencyId)

  const signedTransaction = await withDevice(deviceId)(async transport =>
    signTransaction({
      hwApp: new Btc(transport),
      currencyId: account.currencyId,
      transaction: builded,
      sigHashType: parseInt(sigHashType, 16),
      supportsSegwit: !!currency.supportsSegwit,
      isSegwit: isSegwitAccount(account),
      hasTimestamp,
    }),
  )

  if (!signedTransaction || isCancelled() || !njsAccount) return
  onSigned()

  logger.log(signedTransaction)

  const txHash = await njsAccount
    .asBitcoinLikeAccount()
    .broadcastRawTransaction(Array.from(Buffer.from(signedTransaction, 'hex')))

  const fee = libcoreAmountToBigNumber(builded.getFees())

  // NB we don't check isCancelled() because the broadcast is not cancellable now!
  onOperationBroadcasted({
    id: `${account.xpub}-${txHash}-OUT`,
    hash: txHash,
    type: 'OUT',
    value: BigNumber(transaction.amount)
      .plus(fee)
      .toString(),
    fee: fee.toString(),
    blockHash: null,
    blockHeight: null,
    senders: [account.freshAddress],
    recipients: [transaction.recipient],
    accountId: account.id,
    date: new Date().toISOString(),
  })
}

export default cmd
