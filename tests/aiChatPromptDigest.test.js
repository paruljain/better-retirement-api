const assert = require('node:assert/strict')
const test = require('node:test')
const { buildActivePlanPromptDigest } = require('../dist/src/lib/aiChatPromptDigest')

function fixture() {
    return { currentPlanId: 'baseline', plans: [{ id: 'baseline', planName: 'Baseline',
        institutions: [{ id: 'fidelity', name: 'Fidelity' }],
        accounts: [
            { id: 'cd-account', institutionId: 'fidelity', name: 'Brokerage CD', type: 'interest-account', accountType: 'cd',
                taxStatus: 'regular', ownership: 'primary', currentValue: 262886.91, modelingMode: 'detailed', holdings: [
                    { id: 'boa', name: 'BOA CD', assetType: 'cd', currentValue: 262886.91, basis: 263000,
                        plaidLink: { accessToken: 'never-include-this' }, fixedIncome: {
                            cdKind: 'brokered', principal: 263000, rate: 3.75, issueDate: '2026-02-12',
                            maturityDate: '2026-11-13', compound: false, paymentMonths: 0, dayCount: 'actual-365',
                            maturityInterest: null, taxTiming: 'paid', renewAtMaturity: true, renewalMonths: 9,
                            renewUntilDate: '', destinationAccountId: 'cash' } }
                ] },
            { id: 'cash', name: 'Brokerage Cash', type: 'interest-account', taxStatus: 'regular', amount: 5000 }
        ] }] }
}

function rows(digest, title) {
    const block = digest.split(`${title}\n${'-'.repeat(title.length)}\n`)[1].split('\n\n')[0]
    const [header, ...lines] = block.split('\n')
    return lines.map(line => Object.fromEntries(header.split(',').map((key, index) => [key, line.split(',')[index]])))
}

test('digest carries exact CD terms, destination and displayed withdrawal lock without secrets', () => {
    const user = fixture()
    const before = JSON.stringify(user)
    const digest = buildActivePlanPromptDigest(user)
    const [cd] = rows(digest, 'CD and Bond Holdings')
    assert.equal(cd.institution, 'Fidelity')
    assert.equal(cd.owner, 'You')
    assert.equal(cd.currentValue, '262886.91')
    assert.equal(cd.principalOrFaceValue, '263000')
    assert.equal(cd.annualRatePercent, '3.75')
    assert.equal(cd.issueDate, '2026-02-12')
    assert.equal(cd.maturityOrRedemptionDate, '2026-11-13')
    assert.equal(cd.legacyMaturityInterestOverride, '')
    assert.equal(cd.paymentIntervalMonthsZeroMeansMaturity, '0')
    assert.equal(cd.renewAtMaturity, 'Yes')
    assert.equal(cd.renewalMonths, '9')
    assert.equal(cd.cashDestination, 'Brokerage Cash')
    const [withdrawal] = rows(digest, 'Withdrawal Order')
    assert.equal(withdrawal.enabled, 'No')
    assert.equal(withdrawal.savedEnabledPreference, 'Yes')
    assert.match(withdrawal.disabledReason, /held to maturity/)
    assert.doesNotMatch(digest, /never-include-this|accessToken/)
    assert.equal(JSON.stringify(user), before)
})

test('digest includes bond assumptions and keeps mixed accounts withdrawable', () => {
    const user = fixture()
    const account = user.plans[0].accounts[0]
    account.holdings = [{ id: 'bill', name: 'Bill', assetType: 'individual-bond', currentValue: 9500, basis: 9500,
        fixedIncome: { principal: 10000, purchaseAmount: 9500, rate: 0, bondType: 'treasury', bondInterestMode: 'discount',
            taxTreatment: 'fed', adjustmentTaxTiming: 'paid', inflationRate: 2, renewAtMaturity: false, maturityDate: '2027-01-15' } },
        { id: 'fund', name: 'Bond fund', assetType: 'investment-portfolio', currentValue: 1000 }]
    const digest = buildActivePlanPromptDigest(user)
    const holdings = rows(digest, 'CD and Bond Holdings')
    assert.equal(holdings.length, 1)
    assert.equal(holdings[0].amountInvested, '9500')
    assert.equal(holdings[0].interestHandling, 'discount')
    assert.equal(holdings[0].bondInterestTaxTreatment, 'fed')
    assert.equal(holdings[0].discountPremiumTaxTiming, 'paid')
    assert.equal(holdings[0].annualInflationAdjustmentPercent, '2')
    assert.equal(rows(digest, 'Withdrawal Order')[0].enabled, 'Yes')
})

test('digest keeps missing terms blank and retirement proceeds inside their wrapper', () => {
    const user = fixture()
    const account = user.plans[0].accounts[0]
    account.taxStatus = 'traditional-retirement'
    account.holdings[0].fixedIncome = { destinationAccountId: 'cash' }
    const [cd] = rows(buildActivePlanPromptDigest(user), 'CD and Bond Holdings')
    assert.equal(cd.annualRatePercent, '')
    assert.equal(cd.renewAtMaturity, '')
    assert.equal(cd.cashDestination, 'Cash in Brokerage CD')
})

test('digest escapes security names and scopes holdings to the requested plan', () => {
    const user = fixture()
    user.plans[0].accounts[0].holdings[0].name = 'BOA, "CD"'
    user.plans.push({ id: 'other', planName: 'Other', accounts: [] })
    assert.match(buildActivePlanPromptDigest(user), /"BOA, ""CD"""/)
    assert.doesNotMatch(buildActivePlanPromptDigest(user, 'other'), /263000|BOA/)
})
