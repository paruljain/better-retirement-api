import { UserDocument } from './mongo'

type CsvRow = Array<string | number | null | undefined>

const MAX_CHART_YEARS = 120
const MAX_CHART_ROWS = 20

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

function getActivePlan(user: UserDocument, activePlanId = ''): any | null {
    const plans = getPlans(user)

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
        { label: 'You', person: basicInfo?.primary },
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

function getHealthcareConfigRows(entries: any[]): CsvRow[] {
    return (entries || []).map((entry) => [
        formatOwner(entry?.owner),
        entry?.coverageType || '',
        entry?.startYearReference?.mode || '',
        entry?.startYearReference?.value ?? '',
        entry?.startYearReference?.month ?? '',
        formatMaybeNumber(entry?.startYear),
        entry?.endYearReference?.mode || '',
        entry?.endYearReference?.value ?? '',
        entry?.endYearReference?.month ?? '',
        entry?.endYear === null ? 'Lifetime' : formatMaybeNumber(entry?.endYear),
        roundDollars(entry?.premiumAmount),
        entry?.premiumFrequency || '',
        formatPercent(entry?.inflationRate),
        roundDollars(entry?.advantageAmount),
        roundDollars(entry?.medigapAmount),
        roundDollars(entry?.otherAmount),
        entry?.addOnFrequency || '',
        entry?.premiumCashFlowTreatment || '',
        entry?.payFromHsaFirst === true ? 'Yes' : 'No',
        entry?.notes || ''
    ])
}

function buildCsvBlock(title: string, headers: string[], rows: CsvRow[]): string {
    const csv = toCsv(headers, rows)

    if (!csv) {
        return `${title}\n${'-'.repeat(title.length)}\nNo entries.`
    }

    return `${title}\n${'-'.repeat(title.length)}\n${csv}`
}

function getRunStatus(value: unknown): string {
    return isPlainObject(value) && typeof value.status === 'string' ? value.status : ''
}

function getStringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function getArrayValue(value: unknown): unknown[] {
    return Array.isArray(value) ? value : []
}

function formatMonteCarloSection(computedContext: unknown): string {
    const monteCarlo = isPlainObject(computedContext) && isPlainObject(computedContext.monteCarlo)
        ? computedContext.monteCarlo
        : null

    if (getRunStatus(monteCarlo) !== 'run') {
        return [
            'Monte Carlo',
            '-----------',
            'Chance of Success: Not run. The user has not run Monte Carlo for this plan yet, but they can run it from the dashboard.'
        ].join('\n')
    }

    return [
        'Monte Carlo',
        '-----------',
        `Chance of Success: ${formatPercent(monteCarlo?.successRate) || 'N/A'}`,
        `Generated At: ${getStringValue(monteCarlo?.generatedAt) || 'N/A'}`,
        `Iterations: ${formatMaybeNumber(monteCarlo?.iterations) || 'N/A'}`,
        `Start Year: ${formatMaybeNumber(monteCarlo?.startYear) || 'N/A'}`,
        `End Year: ${formatMaybeNumber(monteCarlo?.endYear) || 'N/A'}`
    ].join('\n')
}

function getSpendingCapacityRows(rows: unknown[]): CsvRow[] {
    return rows.map((row) => {
        const item = isPlainObject(row) ? row : {}

        return [
            formatMaybeNumber(item.targetSuccessRate),
            roundDollars(item.annualSpending),
            roundDollars(item.spendingChange),
            formatMaybeNumber(item.achievedSuccessRate),
            item.supported === false ? 'No' : 'Yes'
        ]
    })
}

function formatSpendingCapacitySection(computedContext: unknown): string {
    const spendingCapacity = isPlainObject(computedContext) && isPlainObject(computedContext.spendingCapacity)
        ? computedContext.spendingCapacity
        : null

    if (getRunStatus(spendingCapacity) !== 'run') {
        return [
            'Spending Capacity',
            '-----------------',
            'Not run. The user has not run Spending Capacity for this plan yet, but they can run it from the Spending Capacity analysis screen.'
        ].join('\n')
    }

    const rows = getSpendingCapacityRows(getArrayValue(spendingCapacity?.rows))
    const csv = toCsv(
        ['targetSuccessRate', 'annualSpending', 'spendingChange', 'achievedSuccessRate', 'supported'],
        rows
    )

    return [
        'Spending Capacity',
        '-----------------',
        `Generated At: ${getStringValue(spendingCapacity?.generatedAt) || 'N/A'}`,
        `Baseline Chance of Success: ${formatPercent(spendingCapacity?.baselineSuccessRate) || 'N/A'}`,
        `Current Annual Spending: ${formatCurrency(spendingCapacity?.currentAnnualSpending)}`,
        csv || 'No spending capacity rows were provided.'
    ].join('\n')
}

function getChartYears(charts: Record<string, unknown>): number[] {
    return getArrayValue(charts.years)
        .map((year) => Number(year))
        .filter((year) => Number.isInteger(year) && year > 1900 && year < 2200)
        .slice(0, MAX_CHART_YEARS)
}

function getChartCsvRows(charts: Record<string, unknown>, years: number[]): CsvRow[] {
    return getArrayValue(charts.rows)
        .slice(0, MAX_CHART_ROWS)
        .map((row) => {
            const item = isPlainObject(row) ? row : {}
            const chartName = getStringValue(item.chartName)
            const totals = getArrayValue(item.totals)

            return [
                chartName,
                ...years.map((_year, index) => roundDollars(totals[index]))
            ]
        })
        .filter((row) => Boolean(row[0]))
}

function formatChartsSection(computedContext: unknown): string {
    const charts = isPlainObject(computedContext) && isPlainObject(computedContext.charts)
        ? computedContext.charts
        : null
    const status = getRunStatus(charts)

    if (status !== 'available' || !charts) {
        return [
            'Charts',
            '------',
            'Chart data is unavailable. Add valid plan ages and run the relevant screens if needed.'
        ].join('\n')
    }

    const years = getChartYears(charts)
    const rows = getChartCsvRows(charts, years)
    const csv = toCsv(['Chart Name', ...years.map(String)], rows)

    return [
        'Charts',
        '------',
        'Amounts are annual future-dollar totals. Tax includes federal and state income tax. Expense includes non-tax expenses and medical premiums, and excludes taxes and IRMAA.',
        '',
        csv || 'No chart rows were provided.'
    ].join('\n')
}

function buildComputedContextBlock(computedContext: unknown): string {
    return [
        formatMonteCarloSection(computedContext),
        '',
        formatSpendingCapacitySection(computedContext),
        '',
        formatChartsSection(computedContext)
    ].join('\n')
}

export function buildActivePlanPromptDigest(user: UserDocument, activePlanId = '', computedContext: unknown = null): string {
    const plan = getActivePlan(user, activePlanId)

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

    const summaryLines = [
        `Plan Name: ${plan.planName || 'Untitled Plan'}`,
        `Current Net Worth: ${formatCurrency(getCurrentNetWorth(plan))}`,
        ...getHouseholdLines(plan.basicInfo),
        `Rates - COLA: ${formatPercent(plan.rates?.cola)}, Inflation: ${formatPercent(plan.rates?.inflation)}, Wage Growth: ${formatPercent(plan.rates?.wageGrowth)}`,
        `Counts - Accounts: ${accounts.length}, Incomes: ${incomes.length}, Expenses: ${expenses.length}, Transfers: ${transfers.length}, Homes: ${homes.length}, Debts: ${debts.length}, Healthcare Entries: ${medicalEntries.length}, Roth Conversions: ${rothEntries.length}`
    ]

    return [
        summaryLines.join('\n'),
        buildCsvBlock(
            'Accounts',
            ['name', 'type', 'taxStatus', 'owner', 'balance', 'basis', 'growthOrApy', 'dividendRate'],
            getAccountRows(accounts)
        ),
        buildCsvBlock(
            'Income',
            ['name', 'category', 'owner', 'amount', 'frequency', 'growthOrInflationRate', 'startYearReferenceMode', 'startYearReferenceValue', 'startYearReferenceMonth', 'startYear', 'endYearReferenceMode', 'endYearReferenceValue', 'endYearReferenceMonth', 'endYear'],
            getCashFlowRows(incomes)
        ),
        buildCsvBlock(
            'Expenses',
            ['name', 'category', 'owner', 'amount', 'frequency', 'growthOrInflationRate', 'startYearReferenceMode', 'startYearReferenceValue', 'startYearReferenceMonth', 'startYear', 'endYearReferenceMode', 'endYearReferenceValue', 'endYearReferenceMonth', 'endYear'],
            getCashFlowRows(expenses)
        ),
        buildCsvBlock(
            'Healthcare Configuration',
            ['owner', 'coverageType', 'startYearReferenceMode', 'startYearReferenceValue', 'startYearReferenceMonth', 'startYear', 'endYearReferenceMode', 'endYearReferenceValue', 'endYearReferenceMonth', 'endYear', 'premiumAmount', 'premiumFrequency', 'inflationRate', 'medicareAdvantageAmount', 'medigapAmount', 'otherMedicareAddOnAmount', 'addOnFrequency', 'premiumCashFlowTreatment', 'payFromHsaFirst', 'notes'],
            getHealthcareConfigRows(medicalEntries)
        ),
        buildCsvBlock(
            'Transfers',
            ['name', 'category', 'owner', 'amount', 'frequency', 'growthOrInflationRate', 'startYearReferenceMode', 'startYearReferenceValue', 'startYearReferenceMonth', 'startYear', 'endYearReferenceMode', 'endYearReferenceValue', 'endYearReferenceMonth', 'endYear'],
            getCashFlowRows(transfers)
        ),
        buildCsvBlock(
            'Roth Conversions',
            ['year', 'month', 'owner', 'amount', 'name'],
            getRothConversionRows(rothEntries)
        ),
        buildComputedContextBlock(computedContext)
    ].filter(Boolean).join('\n\n')
}
