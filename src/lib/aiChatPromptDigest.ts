import { UserDocument } from './mongo'

type CsvRow = Array<string | number | null | undefined>

function roundDollars(value: unknown): number {
    const amount = Number(value || 0)
    return Number.isFinite(amount) ? Math.round(amount) : 0
}

function formatCurrency(value: unknown): string {
    return `$${roundDollars(value).toLocaleString('en-US')}`
}

function formatPercent(value: unknown): string {
    const amount = Number(value)

    if (!Number.isFinite(amount)) {
        return ''
    }

    return `${amount.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}%`
}

function formatMaybeNumber(value: unknown): string {
    const amount = Number(value)
    return Number.isFinite(amount) ? String(amount) : ''
}

function formatOwner(owner: unknown): string {
    if (owner === 'primary') {
        return 'You'
    }

    if (owner === 'spouse') {
        return 'Spouse'
    }

    return 'Joint'
}

function csvEscapeCell(value: string | number | null | undefined): string {
    const text = value === null || value === undefined ? '' : String(value)

    if (text.includes('"') || text.includes(',') || text.includes('\n')) {
        return `"${text.replace(/"/g, '""')}"`
    }

    return text
}

function toCsv(headers: string[], rows: CsvRow[]): string {
    if (rows.length === 0) {
        return ''
    }

    return [
        headers.map(csvEscapeCell).join(','),
        ...rows.map((row) => row.map(csvEscapeCell).join(','))
    ].join('\n')
}

function getPlans(user: UserDocument): any[] {
    return Array.isArray(user?.plans) ? user.plans : []
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getActivePlan(user: UserDocument, activePlanId = '', activePlanSnapshot: unknown = null): any | null {
    const plans = getPlans(user)

    if (isPlainObject(activePlanSnapshot)) {
        const snapshotId = typeof activePlanSnapshot.id === 'string' ? activePlanSnapshot.id : ''

        if (!activePlanId || snapshotId === activePlanId) {
            return activePlanSnapshot
        }
    }

    return plans.find((plan) => plan?.id === activePlanId)
        || plans.find((plan) => plan?.id === user?.currentPlanId)
        || plans[0]
        || null
}

function getAccountBalance(account: any): number {
    return roundDollars(account?.currentValue ?? account?.amount)
}

function getHouseholdLines(basicInfo: any): string[] {
    return [
        { label: 'Owner', person: basicInfo?.primary },
        { label: 'Spouse', person: basicInfo?.spouse }
    ]
        .filter(({ person }) => Boolean(person))
        .map(({ label, person }) => (
            `${label} - Age: ${formatMaybeNumber(person.age) || 'N/A'}, `
            + `Retirement Age: ${formatMaybeNumber(person.retirementAge) || 'N/A'}, `
            + `Death Age: ${formatMaybeNumber(person.ageAtDeath) || 'N/A'}, `
            + `SS FRA Benefit: ${formatCurrency(person.socialSecurity?.benefitAtFra || 0)}, `
            + `SS Claim Age: ${formatMaybeNumber(person.socialSecurity?.claimAge) || 'N/A'}`
        ))
}

function getCurrentNetWorth(plan: any): number {
    const accountTotal = (plan?.accounts || []).reduce((sum: number, account: any) => sum + getAccountBalance(account), 0)
    const homeTotal = (plan?.homes || []).reduce((sum: number, home: any) => sum + roundDollars(home?.currentValue), 0)
    const debtTotal = (plan?.debts || []).reduce((sum: number, debt: any) => sum + roundDollars(debt?.amount), 0)

    return accountTotal + homeTotal - debtTotal
}

function getAccountRows(accounts: any[]): CsvRow[] {
    return (accounts || []).map((account) => [
        account?.name || '',
        account?.type || '',
        account?.taxStatus || '',
        formatOwner(account?.owner),
        getAccountBalance(account),
        roundDollars(account?.basis),
        formatPercent(account?.growthRate ?? account?.apy),
        formatPercent(account?.dividendRate)
    ])
}

function getCashFlowRows(items: any[]): CsvRow[] {
    return (items || []).map((item) => [
        item?.name || '',
        item?.category || '',
        formatOwner(item?.owner),
        roundDollars(item?.amount),
        item?.amountFrequency || '',
        formatPercent(item?.growthRate ?? item?.inflationRate),
        item?.startYearReference?.mode || '',
        item?.startYearReference?.value ?? '',
        item?.startYearReference?.month ?? '',
        formatMaybeNumber(item?.startYear),
        item?.endYearReference?.mode || '',
        item?.endYearReference?.value ?? '',
        item?.endYearReference?.month ?? '',
        item?.endYear === null ? 'Lifetime' : formatMaybeNumber(item?.endYear)
    ])
}

function getRothConversionRows(entries: any[]): CsvRow[] {
    return (entries || []).map((entry) => [
        formatMaybeNumber(entry?.year),
        entry?.month ?? '',
        formatOwner(entry?.owner),
        roundDollars(entry?.amount),
        entry?.name || ''
    ])
}

function buildCsvBlock(title: string, headers: string[], rows: CsvRow[]): string {
    const csv = toCsv(headers, rows)

    if (!csv) {
        return `${title}\n${'-'.repeat(title.length)}\nNo entries.`
    }

    return `${title}\n${'-'.repeat(title.length)}\n${csv}`
}

export function buildActivePlanPromptDigest(user: UserDocument, activePlanId = '', activePlanSnapshot: unknown = null): string {
    const plan = getActivePlan(user, activePlanId, activePlanSnapshot)

    if (!plan) {
        return 'No active plan was found for this user.'
    }

    const accounts = Array.isArray(plan.accounts) ? plan.accounts : []
    const incomes = Array.isArray(plan.incomes) ? plan.incomes : []
    const expenses = Array.isArray(plan.expenses) ? plan.expenses : []
    const transfers = Array.isArray(plan.transfers) ? plan.transfers : []
    const homes = Array.isArray(plan.homes) ? plan.homes : []
    const debts = Array.isArray(plan.debts) ? plan.debts : []
    const rothEntries = Array.isArray(plan.rothConversionPlan?.entries) ? plan.rothConversionPlan.entries : []
    const medicalEntries = Array.isArray(plan.medicalPremiumConfig?.entries) ? plan.medicalPremiumConfig.entries : []

    return [
        `Plan Name: ${plan.planName || 'Untitled Plan'}`,
        `Current Net Worth: ${formatCurrency(getCurrentNetWorth(plan))}`,
        ...getHouseholdLines(plan.basicInfo),
        `Rates - COLA: ${formatPercent(plan.rates?.cola)}, Inflation: ${formatPercent(plan.rates?.inflation)}, Wage Growth: ${formatPercent(plan.rates?.wageGrowth)}`,
        `Counts - Accounts: ${accounts.length}, Incomes: ${incomes.length}, Expenses: ${expenses.length}, Transfers: ${transfers.length}, Homes: ${homes.length}, Debts: ${debts.length}, Healthcare Entries: ${medicalEntries.length}, Roth Conversions: ${rothEntries.length}`,
        '',
        buildCsvBlock(
            'Accounts',
            ['name', 'type', 'taxStatus', 'owner', 'balance', 'basis', 'growthOrApy', 'dividendRate'],
            getAccountRows(accounts)
        ),
        '',
        buildCsvBlock(
            'Income',
            ['name', 'category', 'owner', 'amount', 'frequency', 'growthOrInflationRate', 'startYearReferenceMode', 'startYearReferenceValue', 'startYearReferenceMonth', 'startYear', 'endYearReferenceMode', 'endYearReferenceValue', 'endYearReferenceMonth', 'endYear'],
            getCashFlowRows(incomes)
        ),
        '',
        buildCsvBlock(
            'Expenses',
            ['name', 'category', 'owner', 'amount', 'frequency', 'growthOrInflationRate', 'startYearReferenceMode', 'startYearReferenceValue', 'startYearReferenceMonth', 'startYear', 'endYearReferenceMode', 'endYearReferenceValue', 'endYearReferenceMonth', 'endYear'],
            getCashFlowRows(expenses)
        ),
        '',
        buildCsvBlock(
            'Transfers',
            ['name', 'category', 'owner', 'amount', 'frequency', 'growthOrInflationRate', 'startYearReferenceMode', 'startYearReferenceValue', 'startYearReferenceMonth', 'startYear', 'endYearReferenceMode', 'endYearReferenceValue', 'endYearReferenceMonth', 'endYear'],
            getCashFlowRows(transfers)
        ),
        '',
        buildCsvBlock(
            'Roth Conversions',
            ['year', 'month', 'owner', 'amount', 'name'],
            getRothConversionRows(rothEntries)
        )
    ].filter(Boolean).join('\n')
}
