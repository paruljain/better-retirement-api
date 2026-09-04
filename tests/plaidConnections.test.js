const assert = require('node:assert/strict')
const test = require('node:test')
const {
    applyAccountLinksToUserDocument,
    buildInvestmentSnapshotUpdate
} = require('../dist/src/functions/plaidConnections')

test('a failed holdings fetch retains the last successful investment snapshot', () => {
    const previousHoldings = [{ accountId: 'brokerage-source', securityId: 'spyi', institutionValue: 100 }]
    const previousSecurities = [{ securityId: 'spyi', tickerSymbol: 'SPYI' }]
    const update = buildInvestmentSnapshotUpdate({
        holdings: previousHoldings,
        securities: previousSecurities,
        holdingsLastSyncedAt: '2026-09-03T12:00:00.000Z'
    }, {
        holdings: [],
        securities: [],
        error: 'Plaid holdings request timed out.',
        refreshError: ''
    }, '2026-09-04T12:00:00.000Z', true)

    assert.equal(update.holdings, previousHoldings)
    assert.equal(update.securities, previousSecurities)
    assert.equal(update.holdingsLastSyncedAt, '2026-09-03T12:00:00.000Z')
    assert.equal(update.holdingsRefreshRequestedAt, '2026-09-04T12:00:00.000Z')
    assert.equal(update.holdingsError, 'Plaid holdings request timed out.')
})

test('a failed holdings fetch skips position links without blocking account balance links', () => {
    const user = {
        _id: 'user@example.com',
        plans: [{
            id: 'baseline',
            accounts: [{
                id: 'brokerage',
                type: 'investment-account',
                name: 'Brokerage Stocks',
                currentValue: 100,
                holdings: [{
                    id: 'holding-spyi',
                    name: 'SPYI',
                    currentValue: 100,
                    plaidLink: {
                        sourceType: 'position',
                        sourceField: 'institutionValue',
                        itemId: 'fidelity',
                        accountId: 'brokerage-source',
                        securityId: 'spyi'
                    }
                }]
            }, {
                id: 'savings',
                type: 'interest-account',
                name: 'Savings',
                amount: 10,
                plaidLink: {
                    sourceType: 'account',
                    sourceField: 'currentBalance',
                    itemId: 'fidelity',
                    accountId: 'savings-source'
                }
            }]
        }]
    }
    const item = {
        itemId: 'fidelity',
        accounts: [{
            accountId: 'savings-source',
            balances: { current: 20 }
        }],
        holdings: [{
            accountId: 'brokerage-source',
            securityId: 'spyi',
            institutionValue: 120
        }],
        holdingsError: 'Plaid holdings request timed out.'
    }

    const applied = applyAccountLinksToUserDocument(user, item)

    assert.equal(applied.user.plans[0].accounts[0].holdings[0].currentValue, 100)
    assert.equal(applied.user.plans[0].accounts[0].currentValue, 100)
    assert.equal(applied.user.plans[0].accounts[1].amount, 20)
    assert.deepEqual(applied.results.map((result) => ({
        status: result.status,
        name: result.targetHoldingName || result.targetAccountName,
        message: result.message
    })), [{
        status: 'skipped',
        name: 'SPYI',
        message: 'Plaid investment positions could not be refreshed. The last successful snapshot was retained.'
    }, {
        status: 'updated',
        name: 'Savings',
        message: undefined
    }])
})
